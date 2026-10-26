import { createInterface, type Interface } from "node:readline";
import { version } from "../../../package.json";
import { doctor } from "../../doctor";
import { createHost } from "../../host/host";
import { capability, modelNames } from "../../provider/models";
import { HELP, parseCommand } from "./commands";
import * as r from "./render";

type In = NodeJS.ReadableStream & {
	isTTY?: boolean;
	setRawMode?(on: boolean): unknown;
};
type Msg = Record<string, unknown>;
type Response = {
	ok: boolean;
	result?: Msg;
	error?: { code: string; message: string };
};

const ESC = "\x1b";
const CTRL_C = "\x03";
const QUIT_WINDOW_MS = 2000;

// The plain text chat (build-order 1.4). It is itself a protocol client: it
// talks to the core only through protocol lines, over an in-process channel.
export async function runCli({
	input,
	output,
	cwd,
	defaults = {},
	firstPrompt,
	style,
	root,
	resume,
}: {
	input: In;
	output: NodeJS.WritableStream;
	cwd: string;
	defaults?: { model?: string; effort?: string };
	firstPrompt?: string;
	style: r.Style;
	// Where sessions are saved; tests use a temp folder.
	root?: string;
	// -c, --resume <id>, or --resume alone (the picker).
	resume?: { id: string } | "latest" | "pick";
}): Promise<number> {
	const write = (s: string) => output.write(s);
	let atLineStart = true;
	const say = (s: string) => {
		if (!atLineStart) write("\n");
		write(`${s}\n`);
		atLineStart = true;
	};

	// --- The protocol channel ---
	let host!: ReturnType<typeof createHost>;
	let requests = 0;
	const waiting = new Map<string, (r: Response) => void>();
	let onIdle: (() => void) | undefined;
	let model = defaults.model ?? "gpt-5.6-luna";
	let effort: string | null = defaults.effort ?? null;

	const onLine = (line: string) => {
		const m = JSON.parse(line) as Msg;
		if (m.kind === "response") {
			waiting.get(m.id as string)?.(m as unknown as Response);
			waiting.delete(m.id as string);
		} else if (m.kind === "request") {
			// No approval screen yet (1.7): say so instead of leaving it hanging.
			host.receive(
				JSON.stringify({
					kind: "response",
					id: m.id,
					ok: false,
					error: {
						code: "unsupported",
						message: "the CLI can't answer this yet",
					},
				}),
			);
		} else if (m.kind === "event") {
			onEvent(m);
		}
	};
	const request = (type: string, data: Msg = {}) =>
		new Promise<Response>((resolve) => {
			const id = `u${++requests}`;
			waiting.set(id, resolve);
			host.receive(JSON.stringify({ kind: "request", id, type, ...data }));
		});
	// A host with no session yet; sessions can be listed now.
	const open = async () => {
		host = createHost(onLine, { root });
		await request("initialize", {
			client: { name: "manas-cli", version },
			capabilities: [],
		});
	};
	// A new session, or a saved one (its replay prints first). Returns the
	// error message, if any.
	const start = async (id?: string) => {
		const ready = new Promise<void>((resolve) => {
			onIdle = resolve;
		});
		const res = id
			? await request("session/resume", { session_id: id, cwd })
			: await request("session/new", { cwd, model, effort });
		if (res.ok) await ready;
		onIdle = undefined;
		return res.ok ? undefined : (res.error?.message ?? "error");
	};
	const list = async () =>
		((await request("sessions/list", { cwd })).result?.sessions ??
			[]) as r.Listed[];
	// Like Claude: an empty screen, but the old chat stays in the scrollback.
	// Newlines push it up instead of erasing it.
	const clearScreen = () =>
		write(`${"\n".repeat((output as { rows?: number }).rows ?? 24)}\x1b[H`);

	function onEvent(e: Msg) {
		switch (e.type) {
			case "session/started":
				model = e.model as string;
				effort = (e.effort as string | null) ?? null;
				return;
			case "prompt/delivered":
				// Live prompts are already on screen as typed; replayed ones aren't.
				if (e.replay) say(`> ${e.text}`);
				return;
			case "message/delta": {
				const text = e.text as string;
				write(text);
				if (text) atLineStart = text.endsWith("\n");
				return;
			}
			case "message/done":
				if (e.replay) say(e.text as string);
				else if (!atLineStart) say("");
				return;
			case "tool/started":
				return say(r.toolStarted(e.name as string, e.input, style));
			case "tool/finished":
				return say(
					r.toolFinished(e.status as string, e.output as string, style),
				);
			case "turn/finished":
				if (e.stop_reason === "interrupted") say(r.interrupted(style));
				return;
			case "notice":
				return say(r.notice(e.level as string, e.text as string, style));
			case "state/changed":
				if (e.state === "idle") onIdle?.();
				return;
		}
	}

	// --- Reading input ---
	let history: string[] = [];
	let lastCtrlC = 0;
	const secondCtrlC = () => {
		const now = Date.now();
		const quit = now - lastCtrlC < QUIT_WINDOW_MS;
		lastCtrlC = now;
		return quit;
	};

	// One prompt; `\` at the end of a line continues it. null: quit.
	// ponytail: Ctrl+J can't add a new line, since readline treats it as
	// Enter; the Ink screen (M10) brings it.
	const readPrompt = () =>
		new Promise<string | null>((resolve) => {
			// ponytail: history lives in memory for this run only; it's saved per
			// folder once the vault (1.8) can scrub it (limitation.md).
			const rl: Interface = createInterface({
				input,
				output,
				terminal: true,
				history,
				historySize: 1000,
				removeHistoryDuplicates: true,
			});
			const parts: string[] = [];
			let done = false;
			const finish = (value: string | null) => {
				done = true;
				history = (rl as unknown as { history: string[] }).history;
				rl.close();
				resolve(value);
			};
			rl.on("line", (line) => {
				if (line.endsWith("\\")) {
					parts.push(line.slice(0, -1));
					rl.setPrompt(style.unicode ? "… " : "... ");
					rl.prompt();
					return;
				}
				finish([...parts, line].join("\n"));
			});
			rl.on("SIGINT", () => {
				if (rl.line || parts.length > 0) {
					parts.length = 0;
					write("\n");
					rl.setPrompt("> ");
					rl.write(null, { ctrl: true, name: "u" });
					rl.prompt();
				} else if (secondCtrlC()) {
					write("\n");
					finish(null);
				} else {
					write(`\n${r.dim("Press Ctrl+C again to exit", style)}\n`);
					rl.prompt();
				}
			});
			// Ctrl+D on an empty input closes readline.
			rl.on("close", () => {
				if (!done) {
					done = true;
					write("\n");
					resolve(null);
				}
			});
			rl.setPrompt("> ");
			rl.prompt();
		});

	// --- Running a prompt ---
	// Typing waits until the turn ends (queueing while typing comes with M10);
	// only Esc and Ctrl+C are read meanwhile.
	let quitting = false;
	const runPrompt = async (text: string) => {
		const idle = new Promise<void>((resolve) => {
			onIdle = resolve;
		});
		const onKey = (chunk: Buffer | string) => {
			const key = chunk.toString();
			if (key === CTRL_C && secondCtrlC()) quitting = true;
			if (key === ESC || key === CTRL_C) void request("session/interrupt");
		};
		input.setRawMode?.(true);
		input.on("data", onKey);
		input.resume();
		try {
			const res = await request("session/prompt", { text });
			if (!res.ok) return say(r.red(res.error?.message ?? "error", style));
			await idle;
		} finally {
			input.off("data", onKey);
			onIdle = undefined;
			if (!atLineStart) say("");
		}
	};

	// A one-line answer, e.g. the picker's number. Ctrl+C gives "".
	const ask = (question: string) =>
		new Promise<string>((resolve) => {
			const rl = createInterface({ input, output, terminal: true });
			rl.on("SIGINT", () => {
				rl.close();
				resolve("");
			});
			rl.question(question, (answer) => {
				rl.close();
				resolve(answer.trim());
			});
		});
	// The 20 newest sessions in this folder; undefined if none was picked.
	const pick = async () => {
		const sessions = (await list()).slice(0, 20);
		if (sessions.length === 0) {
			say("No sessions in this folder yet.");
			return undefined;
		}
		const now = Date.now();
		say(sessions.map((s, i) => r.pickerRow(i + 1, s, now, style)).join("\n"));
		const n = Number(await ask("Pick a number (Enter to cancel): "));
		return Number.isInteger(n) && n >= 1 && n <= sessions.length
			? sessions[n - 1].session_id
			: undefined;
	};

	const showChoice = (name: string, current: string, choices: string[]) =>
		say(
			`${name}: ${current} ${r.dim(`(choices: ${choices.join(", ")})`, style)}`,
		);

	const setValue = async (type: string, data: Msg) => {
		const res = await request(type, data);
		if (!res.ok) return say(r.red(res.error?.message ?? "error", style));
		model = res.result?.model as string;
		effort = (res.result?.effort as string | null) ?? null;
	};

	// --- Main loop ---
	await open();
	let resumeId: string | undefined;
	if (resume === "latest") {
		resumeId = (await list())[0]?.session_id;
		if (!resumeId) {
			say(r.red("No session to continue in this folder.", style));
			host.close();
			return 1;
		}
	} else if (resume === "pick") {
		resumeId = await pick();
	} else if (resume) {
		resumeId = resume.id;
	}
	const failed = await start(resumeId);
	if (failed) {
		say(r.red(failed, style));
		host.close();
		return 1;
	}
	say(r.header({ version, model, effort, cwd }, style));
	if (firstPrompt) {
		say(`> ${firstPrompt}`);
		await runPrompt(firstPrompt);
	}
	while (!quitting) {
		const line = await readPrompt();
		if (line === null) break;
		if (!line.trim()) continue;
		const cmd = parseCommand(line);
		if (!cmd) {
			await runPrompt(line);
			continue;
		}
		switch (cmd.name) {
			case "help":
				say(HELP);
				break;
			case "exit":
				quitting = true;
				break;
			case "clear":
				host.close();
				await open();
				await start();
				history = [];
				clearScreen();
				say(r.dim("New conversation.", style));
				break;
			case "resume": {
				const id = await pick();
				if (!id) break;
				host.close();
				clearScreen();
				await open();
				const error = await start(id);
				if (error) {
					say(r.red(error, style));
					await start();
				}
				history = [];
				say(r.header({ version, model, effort, cwd }, style));
				break;
			}
			case "doctor": {
				const { lines } = await doctor();
				say(lines.join("\n"));
				break;
			}
			case "model":
				if (cmd.arg) await setValue("session/set_model", { model: cmd.arg });
				else showChoice("Model", model, modelNames);
				break;
			case "effort": {
				if (cmd.arg) {
					await setValue("session/set_effort", {
						effort: cmd.arg === "default" ? null : cmd.arg,
					});
					break;
				}
				const { efforts } = capability(model);
				if (efforts.length === 0) say(`${model} has no reasoning effort.`);
				else showChoice("Effort", effort ?? "default", [...efforts, "default"]);
				break;
			}
			case "unknown":
				say(r.yellow(`Unknown command ${cmd.text}. Type /help.`, style));
				break;
		}
	}
	host.close();
	return 0;
}

// `manas sessions`: this folder's saved sessions, through the protocol too.
export function sessionsText(cwd: string, style: r.Style, root?: string) {
	let result: r.Listed[] = [];
	const host = createHost(
		(line) => {
			const m = JSON.parse(line);
			if (m.kind === "response" && m.id === "l") result = m.result.sessions;
		},
		{ root },
	);
	host.receive(
		JSON.stringify({
			kind: "request",
			id: "i",
			type: "initialize",
			client: { name: "manas-cli", version },
			capabilities: [],
		}),
	);
	host.receive(
		JSON.stringify({ kind: "request", id: "l", type: "sessions/list", cwd }),
	);
	if (result.length === 0) return "No sessions in this folder yet.";
	const now = Date.now();
	return result.map((s) => r.sessionLine(s, now, style)).join("\n");
}
