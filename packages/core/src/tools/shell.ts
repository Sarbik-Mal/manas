import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { changesLocation } from "../permissions/checks";
import { within } from "../permissions/engine";
import type { ParseResult } from "../permissions/powershell";
import type { ToolCtx } from "./registry";
import type { Reason, Tasks } from "./tasks";

// What PowerShell and bash share (3.5): how a command runs, goes to the
// background, carries the folder over and comes back. Each shell gives its
// spawn line, stderr cleanup and exit-code table.

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
// Inline up to this, else saved to a file (spill.ts); `shellOutputMaxChars`
// changes it. A failed command gets a 10K head and tail instead, no file.
export const SHELL_OUTPUT_MAX = 30_000;
const FAILED_MAX = 10_000;
// Past 5 GB a command is killed (Claude Code's cap); only the first 64 MiB is
// kept in memory, all a spill file holds.
// ponytail: so a failed command past 64 MiB has no real end in its excerpt;
// keep a rolling tail too if such outputs come up. The kill's text is ours:
// Claude Code's wasn't found in its exe.
export const OUTPUT_KILL = 5 * 1024 ** 3;
const KEEP = 64 * 1024 ** 2;

export function cut(text: string, max = FAILED_MAX) {
	if (text.length <= max) return text;
	const half = Math.floor(max / 2);
	return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters cut …]\n${text.slice(-half)}`;
}

// What an exit code means, read from the last command that isn't a
// formatter (Claude Code's table): some programs exit 1 for "no match".
export type Meaning = { failed: boolean; note?: string };
export const oneIs = (note: string) => (code: number) => ({
	failed: code !== 0 && code !== 1,
	note: code === 1 ? note : undefined,
});

// The meaning of `code` for the last part of a parsed command that isn't a
// formatter; `git x` is looked up as one key.
export async function meaningOf(
	parse: Promise<ParseResult>,
	code: number,
	table: Record<string, (code: number) => Meaning>,
	skip: (name: string) => boolean = () => false,
): Promise<Meaning> {
	const plain = { failed: code !== 0 };
	if (code === 0) return plain;
	try {
		const parts = (await parse).commands;
		const last = parts.findLast(
			(p) => !skip((p.resolved ?? p.name ?? "").toLowerCase()),
		);
		const exe = (last?.resolved ?? last?.name ?? "")
			.split(/[\\/]/)
			.pop()
			?.toLowerCase()
			.replace(/\.(exe|cmd|bat)$/, "");
		const key = exe === "git" ? `git ${last?.args[0] ?? ""}` : (exe ?? "");
		return table[key]?.(code) ?? plain;
	} catch {
		return plain;
	}
}

// The folder a finished command left behind; undefined if it didn't get
// that far (a timeout, `exit`).
function endedIn(pwdFile: string, read: (raw: string) => string) {
	try {
		const raw = readFileSync(pwdFile, "utf8")
			.replace(/^\uFEFF/, "")
			.trim();
		return raw ? read(raw) : undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(pwdFile, { force: true });
	}
}

// What the model is told when a command goes to the background: Claude
// Code's texts, one per reason.
function backgroundText(
	reason: Reason | "asked",
	id: string,
	path: string,
	ms: number,
) {
	const head =
		reason === "user"
			? `Command was manually backgrounded by user with ID: ${id}. Output is being written to: ${path}.`
			: reason === "message"
				? `Command was moved to the background (ID: ${id}) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: ${path}.`
				: reason === "timeout"
					? `Command did not complete within its ${Math.max(1, Math.round(ms / 1000))}s timeout and was moved to the background (ID: ${id}). Output is being written to: ${path}.`
					: `Command running in background with ID: ${id}. Output is being written to: ${path}.`;
	if (reason === "user") return head;
	if (reason === "asked")
		return `${head} You will be notified when it completes — do not poll that file or sleep while waiting. Use read on that file only if the user asks for progress, or if you need a line it prints before you can go on, such as a server's ready line or port.`;
	return `${head} You will be notified when it completes. To check interim output, use read on that file path.`;
}

// The input both shells take.
export const shellSchema = Type.Object(
	{
		command: Type.String({ description: "The command to run." }),
		description: Type.Union([Type.String(), Type.Null()], {
			description: "What it does, in 5-10 words, or null.",
		}),
		timeout: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
			description: `Timeout in milliseconds (at most ${MAX_TIMEOUT_MS}), or null for ${DEFAULT_TIMEOUT_MS}.`,
		}),
		run_in_background: Type.Union([Type.Boolean(), Type.Null()], {
			description:
				"true to run it in the background (you're notified when it ends), or null to wait for it.",
		}),
	},
	{ additionalProperties: false },
);

export type ShellSpec = {
	// The process to start; the script travels in its environment.
	spawn: (
		command: string,
		pwdFile: string,
	) => { argv: string[]; env: Record<string, string> };
	stderr: (s: string) => string;
	meaning: (command: string, code: number) => Promise<Meaning>;
	parse: (command: string) => Promise<ParseResult>;
	// The pwd file's text as a Windows path.
	cwd: (raw: string) => string;
	// Stopped at its timeout instead of going to the background.
	sleep: RegExp;
};

export async function runShell(
	spec: ShellSpec,
	{
		command,
		description,
		timeout,
		run_in_background,
	}: {
		command: string;
		description: string | null;
		timeout: number | null;
		run_in_background: boolean | null;
	},
	ctx: ToolCtx,
) {
	const { tasks } = ctx;
	if (run_in_background && !tasks)
		throw new Error("background commands aren't available here");
	const ms = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
	const pwdFile = join(tmpdir(), `manas-pwd-${randomUUID()}`);
	const { argv, env: own } = spec.spawn(command, pwdFile);
	const env: Record<string, string | undefined> = { ...process.env, ...own };
	env.NO_COLOR ??= "1";
	env.PYTHONIOENCODING ??= "utf-8:surrogateescape";
	const p = Bun.spawn(argv, {
		cwd: ctx.shell.cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	// The whole tree: a command may have started programs of its own.
	const kill = () =>
		Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(p.pid)]);
	// Output as it comes: kept here while the call waits, sent to the
	// task's file once the command is in the background.
	let out = "";
	let err = "";
	let feed: ((s: string) => void) | undefined;
	let bytes = 0;
	let tooBig = false;
	const pump = async (
		stream: ReadableStream<Uint8Array>,
		add: (s: string) => void,
	) => {
		const decoder = new TextDecoder();
		const take = (s: string) => (feed ? feed(s) : add(s));
		for await (const chunk of stream) {
			// In the background the task counts instead.
			bytes += chunk.length;
			if (!feed && !tooBig && bytes > OUTPUT_KILL) {
				tooBig = true;
				kill();
			}
			take(decoder.decode(chunk, { stream: true }));
		}
		take(decoder.decode());
	};
	const exited = Promise.all([
		pump(p.stdout, (s) => {
			if (out.length < KEEP) out += s;
		}),
		pump(p.stderr, (s) => {
			if (err.length < KEEP) err += s;
		}),
		p.exited,
	]).then(([, , code]) => code);

	// In the background the folder never moves (as in Claude Code).
	const toBackground = async (reason: Reason | "asked") => {
		ctx.signal.removeEventListener("abort", kill);
		void exited.then(() => rmSync(pwdFile, { force: true }));
		const task = (tasks as Tasks).adopt({
			command,
			description,
			callId: ctx.callId ?? "",
			initial: out + spec.stderr(err),
			kill,
			ended: exited.then(async (code) => ({
				code,
				...(await spec.meaning(command, code)),
			})),
		});
		feed = task.feed;
		const text = backgroundText(reason, task.id, task.outputFile, ms);
		const moved = await spec.parse(command).then(changesLocation, () => false);
		return moved
			? `${text}\nSession cwd remains ${ctx.shell.cwd}; directory changes made by the backgrounded command do not apply to subsequent commands.`
			: text;
	};
	if (run_in_background) return toBackground("asked");

	// A timeout, Ctrl+B or a message arriving moves the command to the
	// background; only a sleep is stopped at its timeout, as in Claude Code.
	let move: (reason: Reason) => void = () => {};
	const moved = new Promise<Reason>((resolve) => {
		move = resolve;
	});
	const unregister = tasks?.foreground(move);
	let timedOut = false;
	const timer = setTimeout(() => {
		if (tasks && !spec.sleep.test(command)) move("timeout");
		else {
			timedOut = true;
			kill();
		}
	}, ms);
	ctx.signal.addEventListener("abort", kill, { once: true });
	const first = await Promise.race([exited.then(() => undefined), moved]);
	clearTimeout(timer);
	unregister?.();
	if (first !== undefined) return toBackground(first);
	ctx.signal.removeEventListener("abort", kill);
	const code = await exited;
	const parts = [out.trimEnd(), spec.stderr(err).trimEnd()].filter(Boolean);
	let failed = true;
	if (tooBig) parts.push("Command was stopped: its output passed 5 GB.");
	else if (timedOut)
		parts.push(`Command timed out after ${ms / 1000} s and was stopped.`);
	else {
		const m = await spec.meaning(command, code);
		failed = m.failed;
		if (m.failed) parts.push(`Command failed with exit code ${code}`);
		else if (m.note) parts.push(m.note);
	}
	// The folder carries over inside the project, as in Claude Code.
	const now = endedIn(pwdFile, spec.cwd);
	if (now !== undefined && now !== ctx.shell.cwd) {
		if (within(now, ctx.cwd)) ctx.shell.cwd = now;
		else {
			ctx.shell.cwd = ctx.cwd;
			parts.push(`Shell cwd was reset to ${ctx.cwd}`);
		}
	}
	const text = parts.join("\n").replace(/\r\n/g, "\n") || "(no output)";
	// An ok result comes back whole; callTool spills it if it's long.
	return failed ? cut(text) : text;
}
