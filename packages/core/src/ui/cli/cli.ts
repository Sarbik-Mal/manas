import { createInterface, type Interface } from "node:readline";
import { version } from "../../../package.json";
import { doctor } from "../../doctor";
import { createHost, type SettingsSource } from "../../host/host";
import { capability, modelNames } from "../../provider/models";
import type { Tool } from "../../tools/registry";
import { HELP, parseCommand } from "./commands";
import { addToHistory, historyFile, loadHistory } from "./prompt-history";
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
const SHIFT_TAB = "\x1b[Z";
const QUIT_WINDOW_MS = 2000;
const DOUBLE_ESC_MS = 600;

// The plain text chat (build-order 1.4). It is itself a protocol client: it
// talks to the core only through protocol lines, over an in-process channel.
export async function runCli({
	input,
	output,
	cwd,
	settings,
	firstPrompt,
	style,
	root,
	resume,
	tools,
	mode: startMode,
	cleanup,
}: {
	input: In;
	output: NodeJS.WritableStream;
	cwd: string;
	// The merged settings files; the host reads model, effort and rules.
	settings?: SettingsSource;
	firstPrompt?: string;
	style: r.Style;
	// Where sessions are saved; tests use a temp folder.
	root?: string;
	// -c, --resume <id>, or --resume alone (the picker).
	resume?: { id: string } | "latest" | "pick";
	// The core's tools (`coreTools()`); tests bring their own.
	tools?: Tool[];
	// --mode: the starting mode (plain or display name).
	mode?: string;
	// The startup cleanup's folder (~/.manas); tests leave it out.
	cleanup?: { dir: string };
}): Promise<number> {
	const write = (s: string) => output.write(s);
	let atLineStart = true;
	// Running tool calls, so a finished row knows which tool it was.
	const calls = new Map<string, { name: string; input: unknown }>();
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
	// Set by `session/started`. The first session takes them from settings;
	// /clear keeps the current ones.
	let model = "";
	let effort: string | null = null;
	let mode = "";
	// Redraws the input's prompt when the mode changes while typing.
	let redraw: (() => void) | undefined;

	const onLine = (line: string) => {
		const m = JSON.parse(line) as Msg;
		if (m.kind === "response") {
			waiting.get(m.id as string)?.(m as unknown as Response);
			waiting.delete(m.id as string);
		} else if (m.kind === "request") {
			// One prompt at a time, in the order they came.
			if (m.type === "permission/request") {
				prompts = prompts.then(() => askPermission(m));
			} else if (m.type === "user/ask") {
				prompts = prompts.then(() => askQuestions(m));
			} else {
				reply(m.id as string, {
					ok: false,
					error: { code: "unsupported", message: "the CLI can't answer this" },
				});
			}
		} else if (m.kind === "cancel") {
			cancelled.add(m.id as string);
			if (asking === m.id) closeAsk?.();
		} else if (m.kind === "event") {
			onEvent(m);
		}
	};
	const reply = (id: string, r: Msg) =>
		host.receive(JSON.stringify({ kind: "response", id, ...r }));
	const request = (type: string, data: Msg = {}) =>
		new Promise<Response>((resolve) => {
			const id = `u${++requests}`;
			waiting.set(id, resolve);
			host.receive(JSON.stringify({ kind: "request", id, type, ...data }));
		});
	// A host with no session yet; sessions can be listed now.
	const open = async () => {
		host = createHost(onLine, { root, settings, tools, cleanup });
		await request("initialize", {
			client: { name: "manas-cli", version },
			capabilities: ["user_ask"],
		});
	};
	// A new session, or a saved one (its replay prints first). Returns the
	// error message, if any.
	const start = async (id?: string) => {
		const ready = new Promise<void>((resolve) => {
			onIdle = resolve;
		});
		// --mode wins at launch; later, /clear and /resume keep the current
		// mode (as Claude Code's /resume does).
		const res = id
			? await request("session/resume", {
					session_id: id,
					cwd,
					mode: mode || startMode || null,
				})
			: await request("session/new", {
					cwd,
					model: model || null,
					effort: model ? effort : null,
					mode: mode || startMode || null,
				});
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
				mode = e.mode as string;
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
				calls.set(e.tool_call_id as string, {
					name: e.name as string,
					input: e.input,
				});
				return say(r.toolStarted(e.name as string, e.input, style));
			case "tool/finished": {
				const call = calls.get(e.tool_call_id as string);
				calls.delete(e.tool_call_id as string);
				return say(
					r.toolFinished(e.status as string, e.output as string, style, call),
				);
			}
			case "turn/finished":
				if (e.stop_reason === "interrupted") say(r.interrupted(style));
				return;
			case "notice":
				return say(r.notice(e.level as string, e.text as string, style));
			case "state/changed":
				if (e.mode !== mode) {
					mode = e.mode as string;
					say(r.modeSwitched(mode, style));
					redraw?.();
				}
				if (e.state === "idle") onIdle?.();
				return;
		}
	}

	// --- Reading input ---
	// ↑/↓ history: this folder's saved prompts (encrypted), plus this run's.
	const savedHistory = historyFile(cwd, root);
	let history = loadHistory(savedHistory);
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
	// `prefill`: text already in the input, e.g. a prompt /rewind took back.
	// Esc twice on an empty input opens /rewind, as in Claude Code.
	const readPrompt = (prefill = "") =>
		new Promise<string | null>((resolve) => {
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
			let lastEsc = 0;
			const onPress = (_: string, key?: { name?: string; shift?: boolean }) => {
				if (key?.name === "tab" && key.shift) return cycleMode();
				if (key?.name !== "escape" || rl.line || parts.length > 0) return;
				const now = Date.now();
				if (now - lastEsc < DOUBLE_ESC_MS) {
					write("\n");
					finish("/rewind");
				}
				lastEsc = now;
			};
			input.on("keypress", onPress);
			redraw = () => {
				if (parts.length === 0) rl.setPrompt(r.promptText(mode));
				rl.prompt(true);
			};
			const finish = (value: string | null) => {
				done = true;
				redraw = undefined;
				input.off("keypress", onPress);
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
				addToHistory(savedHistory, [...parts, line]);
				finish([...parts, line].join("\n"));
			});
			rl.on("SIGINT", () => {
				if (rl.line || parts.length > 0) {
					parts.length = 0;
					write("\n");
					rl.setPrompt(r.promptText(mode));
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
					redraw = undefined;
					input.off("keypress", onPress);
					write("\n");
					resolve(null);
				}
			});
			rl.setPrompt(r.promptText(mode));
			rl.prompt();
			if (prefill) rl.write(prefill);
		});

	// --- Running a prompt ---
	// Typing waits until the turn ends (queueing while typing comes with M10);
	// only Esc and Ctrl+C are read meanwhile.
	let quitting = false;
	let inTurn = false;
	// Keys go to the approval prompt while it's open, not to Esc/Ctrl+C.
	const listenForStop = () => {
		input.setRawMode?.(true);
		input.resume();
	};
	const runPrompt = async (text: string) => {
		const idle = new Promise<void>((resolve) => {
			onIdle = resolve;
		});
		const onKey = (chunk: Buffer | string) => {
			if (asking) return;
			const key = chunk.toString();
			if (key === SHIFT_TAB) return cycleMode();
			if (key === CTRL_C && secondCtrlC()) quitting = true;
			if (key === ESC || key === CTRL_C) void request("session/interrupt");
		};
		input.on("data", onKey);
		inTurn = true;
		listenForStop();
		try {
			const res = await request("session/prompt", { text });
			if (!res.ok) return say(r.red(res.error?.message ?? "error", style));
			await idle;
		} finally {
			inTurn = false;
			input.off("data", onKey);
			onIdle = undefined;
			if (!atLineStart) say("");
		}
	};

	// A one-line answer, e.g. the picker's number. Esc, Ctrl+C or a cancel
	// from the core give null.
	let closeAsk: (() => void) | undefined;
	const ask = (question: string) =>
		new Promise<string | null>((resolve) => {
			const rl = createInterface({ input, output, terminal: true });
			const done = (answer: string | null) => {
				input.off("keypress", onPress);
				closeAsk = undefined;
				rl.close();
				if (inTurn) listenForStop();
				resolve(answer);
			};
			const onPress = (_: string, key?: { name?: string }) => {
				if (key?.name === "escape") {
					write("\n");
					done(null);
				}
			};
			input.on("keypress", onPress);
			closeAsk = () => {
				write(`\n${r.dim("(no longer needed)", style)}\n`);
				done(null);
			};
			rl.on("SIGINT", () => {
				write("\n");
				done(null);
			});
			rl.question(question, (answer) => done(answer.trim()));
		});

	// --- Approvals (permission/request) ---
	let prompts = Promise.resolve();
	let asking: string | undefined;
	const cancelled = new Set<string>();
	async function askPermission(m: Msg) {
		const id = m.id as string;
		if (cancelled.has(id)) return;
		asking = id;
		// The core offers at most one "don't ask again" choice per prompt.
		const remember = (m.suggestions as r.Suggestion[])[0];
		const options = [
			"Yes",
			...(remember ? [r.rememberLabel(remember)] : []),
			"No",
		];
		say(r.yellow(`Manas wants to ${m.title}`, style));
		if (typeof m.diff === "string") say(r.diff(m.diff, style));
		say(r.dim(`  ${m.reason}`, style));
		say(options.map((o, i) => `  ${i + 1}. ${o}`).join("\n"));
		let decision: "allow" | "allow_always" | "deny" | undefined;
		let message: string | null = null;
		while (!decision) {
			const a = await ask(`Choose 1-${options.length}: `);
			const n = Number(a);
			if (a === null) decision = "deny";
			else if (n === 1) decision = "allow";
			else if (n === options.length) {
				decision = "deny";
				message =
					(await ask("Tell Manas what to do instead (Enter to just stop): ")) ||
					null;
			} else if (n === 2) decision = "allow_always";
		}
		asking = undefined;
		if (!cancelled.has(id))
			reply(id, {
				ok: true,
				result: {
					decision,
					suggestion: decision === "allow_always" ? remember : null,
					message,
				},
			});
	}
	// --- Questions (user/ask, from ask_user) ---
	// A numbered menu per question, plus "Type something else". Esc on any of
	// them declines them all, which stops the turn.
	// ponytail: numbers, not an arrow-key menu, until the Ink screen (M10).
	async function askQuestions(m: Msg) {
		const id = m.id as string;
		if (cancelled.has(id)) return;
		asking = id;
		const answers: Record<string, string[]> = {};
		let declined = false;
		for (const q of m.questions as r.Question[]) {
			say(r.question(q, style));
			const other = q.options.length + 1;
			let picked: string[] | undefined;
			while (!picked) {
				const a = await ask(
					q.multiSelect
						? `Choose 1-${other} (several: 1,3): `
						: `Choose 1-${other}: `,
				);
				if (a === null) break;
				const nums = [...new Set(a.split(/[\s,]+/).filter(Boolean))].map(
					Number,
				);
				const bad =
					nums.length === 0 ||
					(!q.multiSelect && nums.length > 1) ||
					nums.some((n) => !Number.isInteger(n) || n < 1 || n > other);
				if (bad) continue;
				const chosen = nums
					.filter((n) => n !== other)
					.map((n) => q.options[n - 1].label);
				if (nums.includes(other)) {
					const text = await ask("Your answer: ");
					if (text === null) break;
					if (!text) continue;
					chosen.push(text);
				}
				picked = chosen;
			}
			if (!picked) {
				declined = true;
				break;
			}
			answers[q.question] = picked;
		}
		asking = undefined;
		if (!cancelled.has(id))
			reply(id, { ok: true, result: { answers: declined ? null : answers } });
	}

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

	// /rewind: pick a prompt, see what the code restore would change, pick an
	// action. Returns the prompt to put back in the input, if the
	// conversation was rewound.
	// ponytail: no Summarize options until compaction, and the old messages
	// stay on screen after a conversation rewind until the Ink screen (M10).
	const rewind = async (): Promise<string | undefined> => {
		const listed = await request("checkpoints/list");
		const points = ((listed.result?.checkpoints ?? []) as r.Point[])
			.slice(-20)
			.reverse();
		if (points.length === 0) {
			say("Nothing to rewind to yet.");
			return undefined;
		}
		const now = Date.now();
		say(points.map((p, i) => r.rewindRow(i + 1, p, now, style)).join("\n"));
		const n = Number(await ask("Rewind to before which? (Enter to cancel): "));
		const point = Number.isInteger(n) ? points[n - 1] : undefined;
		if (!point) return undefined;
		const id = point.checkpoint_id;
		const files = ((await request("checkpoints/preview", { checkpoint_id: id }))
			.result?.files ?? []) as r.Change[];
		say(r.preview(files, style));
		// The code options only when there's code to restore (Claude Code's
		// rule); a "before rewind" point has no conversation of its own.
		const chat = point.prompt !== null;
		const actions = [
			...(chat && files.length > 0
				? [["both", "Restore code and conversation"]]
				: []),
			...(chat ? [["conversation", "Restore conversation"]] : []),
			...(files.length > 0 ? [["code", "Restore code"]] : []),
		];
		if (actions.length === 0) {
			say(r.dim("Nothing to restore there.", style));
			return undefined;
		}
		actions.push(["cancel", "Never mind"]);
		say(actions.map(([, label], i) => `  ${i + 1}. ${label}`).join("\n"));
		const a = Number(await ask(`Choose 1-${actions.length}: `));
		const scope = Number.isInteger(a) ? actions[a - 1]?.[0] : undefined;
		if (!scope || scope === "cancel") return undefined;
		const res = await request("session/rewind", { checkpoint_id: id, scope });
		if (!res.ok) {
			say(r.red(res.error?.message ?? "error", style));
			return undefined;
		}
		const result = res.result as {
			prompt: string | null;
			restored: string[];
			failed: { path: string; error: string }[];
		};
		say(r.rewound(scope, result, style));
		return scope === "code" ? undefined : (result.prompt ?? undefined);
	};

	const showChoice = (name: string, current: string, choices: string[]) =>
		say(
			`${name}: ${current} ${r.dim(`(choices: ${choices.join(", ")})`, style)}`,
		);

	// Shift+Tab: vibe-check and lowkey (scheming and let-it-cook join later).
	// Applies from the next tool call.
	const cycleMode = () => {
		void request("session/set_mode", {
			mode: mode === "acceptEdits" ? "manual" : "acceptEdits",
		});
	};

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
	say(r.header({ version, model, effort, mode, cwd }, style));
	if (firstPrompt) {
		say(`> ${firstPrompt}`);
		await runPrompt(firstPrompt);
	}
	let prefill: string | undefined;
	while (!quitting) {
		const line = await readPrompt(prefill);
		prefill = undefined;
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
				say(r.header({ version, model, effort, mode, cwd }, style));
				break;
			}
			case "rewind":
				prefill = await rewind();
				break;
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
			case "mode":
				if (cmd.arg) {
					const res = await request("session/set_mode", { mode: cmd.arg });
					if (!res.ok) say(r.red(res.error?.message ?? "error", style));
				} else showChoice("Mode", r.modeName(mode), ["vibe-check", "lowkey"]);
				break;
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
