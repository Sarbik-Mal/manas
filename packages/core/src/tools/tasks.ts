import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Type from "typebox";
import { scrub, type Vault } from "../safety/scrub";
import { defineTool } from "./registry";

// Background commands (tools.md §2, 3.3), as Claude Code runs them: output
// goes to a file the model reads with `read`, and a notice joins the
// conversation when a command ends, stalls or is stopped.

export type Reason = "timeout" | "user" | "message";
export type Status = "running" | "completed" | "failed" | "killed";
export type TaskInfo = {
	id: string;
	description: string;
	command: string;
	status: Status;
	started: string;
	outputFile: string;
};
export type Finished = {
	id: string;
	status: Status;
	summary: string;
	outputFile: string;
};
export type Ended = { code: number; failed: boolean; note?: string };

type Task = TaskInfo & {
	callId: string;
	kill: () => void;
	stopping: boolean;
	silent: boolean;
	tooBig: boolean;
	pending: string; // the line not yet ended, written once it is
	tail: string; // the last output, for the stall notice
	size: number;
};

// Claude Code's check for a command waiting on a question it can't answer.
const PROMPTS = [
	/\(y\/n\)/i,
	/\[y\/n\]/i,
	/\(yes\/no\)/i,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
	/Press (any key|Enter)/i,
	/Continue\?/i,
	/Overwrite\?/i,
];
const asksSomething = (text: string) => {
	const last = text.trimEnd().split("\n").pop() ?? "";
	return PROMPTS.some((p) => p.test(last));
};

const xml = (
	t: Task,
	fields: { status?: Status; summary: string },
	trailing = "",
) =>
	`<task-notification>\n<task-id>${t.id}</task-id>\n<tool-use-id>${t.callId}</tool-use-id>\n<output-file>${t.outputFile}</output-file>` +
	(fields.status ? `\n<status>${fields.status}</status>` : "") +
	`\n<summary>${fields.summary}</summary>\n</task-notification>${trailing}`;

export function openTasks({
	dir,
	vault,
	notify,
	finished = () => {},
	stall = { every: 5_000, quiet: 45_000 },
	outputMax = 5 * 1024 ** 3,
}: {
	dir: string; // this session's tasks folder
	vault: Vault;
	notify: (text: string) => void; // to the model
	finished?: (f: Finished) => void; // to front ends
	stall?: { every: number; quiet: number };
	// Past this a command is killed, as in Claude Code (5 GB).
	outputMax?: number;
}) {
	const tasks = new Map<string, Task>();
	const foreground = new Set<(reason: Reason) => void>();

	// Whole lines only, scrubbed, so a secret never reaches the disk and a
	// pattern isn't split across two writes.
	const write = (t: Task, text: string, end = false) => {
		if (t.silent || t.tooBig) return;
		t.pending += text.replace(/\r\n/g, "\n");
		t.size += text.length;
		if (t.size > outputMax && t.status === "running") {
			t.tooBig = true;
			t.stopping = true;
			t.kill();
		}
		const cut = end ? t.pending.length : t.pending.lastIndexOf("\n") + 1;
		if (cut === 0) return;
		const clean = scrub(t.pending.slice(0, cut), vault).text;
		t.pending = t.pending.slice(cut);
		t.tail = (t.tail + clean).slice(-1024);
		appendFileSync(t.outputFile, clean);
	};

	return {
		// A foreground command the session may move to the background (Ctrl+B,
		// a message arriving); returns the way to unregister it.
		foreground(move: (reason: Reason) => void) {
			foreground.add(move);
			return () => foreground.delete(move);
		},
		backgroundAll(reason: Reason) {
			for (const move of [...foreground]) move(reason);
			const moved = foreground.size;
			foreground.clear();
			return moved;
		},
		// Takes over a running command: `initial` is what it printed so far,
		// `feed` gets the way to send the rest, `ended` resolves on exit.
		adopt({
			command,
			description,
			callId,
			initial,
			kill,
			ended,
		}: {
			command: string;
			description: string | null;
			callId: string;
			initial: string;
			kill: () => void;
			ended: Promise<Ended>;
		}) {
			mkdirSync(dir, { recursive: true });
			const id = `b${randomBytes(3).toString("hex")}`;
			const t: Task = {
				id,
				description: description ?? command,
				command,
				status: "running",
				started: new Date().toISOString(),
				outputFile: join(dir, `${id}.output`),
				callId,
				kill,
				stopping: false,
				silent: false,
				tooBig: false,
				pending: "",
				tail: "",
				size: 0,
			};
			tasks.set(id, t);
			appendFileSync(t.outputFile, "");
			write(t, initial);
			const desc = `Background command "${t.description}"`;
			let lastSize = -1;
			let quietSince = Date.now();
			const timer = setInterval(() => {
				if (t.size !== lastSize) {
					lastSize = t.size;
					quietSince = Date.now();
					return;
				}
				const last = t.tail + scrub(t.pending, vault).text;
				if (Date.now() - quietSince < stall.quiet || !asksSomething(last))
					return;
				clearInterval(timer);
				notify(
					xml(
						t,
						{ summary: `${desc} appears to be waiting for interactive input` },
						`\nLast output:\n${last.trimEnd()}\n\nThe command is likely blocked on an interactive prompt. Stop this task and re-run with piped input (e.g., \`echo y | command\`) or a non-interactive flag if one exists.`,
					),
				);
			}, stall.every);
			timer.unref();
			void ended.then(({ code, failed, note }) => {
				clearInterval(timer);
				write(t, "", true);
				t.status = t.stopping ? "killed" : failed ? "failed" : "completed";
				if (t.silent) return;
				const summary =
					t.status === "killed"
						? `${desc} was stopped${t.tooBig ? ": its output passed 5 GB" : ""}`
						: t.status === "failed"
							? `${desc} failed with exit code ${code}`
							: `${desc} completed (exit code ${code}${note ? `: ${note}` : ""})`;
				notify(xml(t, { status: t.status, summary }));
				finished({ id, status: t.status, summary, outputFile: t.outputFile });
			});
			return { id, outputFile: t.outputFile, feed: (s: string) => write(t, s) };
		},
		// The model's task_stop or the user's /tasks; both notify on exit.
		stop(id: string) {
			const t = tasks.get(id);
			if (!t) {
				const running = [...tasks.values()].filter(
					(x) => x.status === "running",
				);
				return {
					ok: false,
					text: `No task found with ID: ${id}${running.length ? `. Running tasks: ${running.map((x) => x.id).join(", ")}` : ""}`,
				};
			}
			if (t.status !== "running" || t.stopping)
				return {
					ok: false,
					text: `Task ${id} is not running (status: ${t.status})`,
				};
			t.stopping = true;
			t.kill();
			return {
				ok: true,
				text: `Successfully stopped task: ${id} (${t.command})`,
			};
		},
		list(): TaskInfo[] {
			return [...tasks.values()].map(
				({ id, description, command, status, started, outputFile }) => ({
					id,
					description,
					command,
					status,
					started,
					outputFile,
				}),
			);
		},
		// Exit or the session closing: everything stops, without notices, and
		// the folder goes.
		killAll() {
			for (const t of tasks.values()) {
				if (t.status !== "running") continue;
				t.silent = true;
				t.stopping = true;
				t.kill();
			}
			foreground.clear();
			rmSync(dir, { recursive: true, force: true });
			// The session's and the project's folders too, once empty.
			try {
				rmdirSync(dirname(dir));
				rmdirSync(dirname(dirname(dir)));
			} catch {}
		},
	};
}

export type Tasks = ReturnType<typeof openTasks>;

export const taskStop = defineTool({
	name: "task_stop",
	description:
		"- Stops a running background task by its ID\n- Takes a task_id parameter identifying the task to stop\n- Returns a success or failure status\n- Use this tool when you need to terminate a long-running task",
	schema: Type.Object(
		{
			task_id: Type.String({
				description: "The ID of the background task to stop.",
			}),
		},
		{ additionalProperties: false },
	),
	deferred: false,
	readOnly: true,
	async run({ task_id }, ctx) {
		if (!ctx.tasks) throw new Error("background tasks aren't available here");
		const r = ctx.tasks.stop(task_id);
		if (!r.ok) throw new Error(r.text);
		return r.text;
	},
});
