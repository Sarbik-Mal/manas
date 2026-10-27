import { mkdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	CoreResults,
	type EventData,
	type EventType,
	Line,
	PROTOCOL_VERSION,
	type RequestData,
	Requests,
	type RequestType,
	type Result,
} from "@manas/protocol";
import Value from "typebox/value";
import { version } from "../../package.json";
import {
	type LiveSettings,
	projectFile,
	type Rule,
	saveRule,
} from "../config/settings";
import { debugLog } from "../log/debug";
import { firstMessage } from "../loop/prompt";
import {
	createSession,
	type Session,
	type SessionEvent,
} from "../loop/session";
import {
	decide,
	deniedBy,
	deniedPath,
	MODE_NAMES,
	type Mode,
	parseMode,
	type Suggestion,
} from "../permissions/engine";
import { checkEffort } from "../provider/models";
import { preloadEnv } from "../safety/env-preload";
import { restoreDeep, restoreStream, Vault } from "../safety/scrub";
import { openVault, saveVault } from "../safety/vault-file";
import { sweep } from "../session/cleanup";
import {
	DEFAULT_ROOT,
	findSession,
	type Loaded,
	listSessions,
	loadSession,
	openStore,
	projectDir,
	sessionFile,
} from "../session/store";
import type { Answers, Questions } from "../tools/ask";
import { openBackups } from "../tools/backups";
import { readRecord } from "../tools/reads";
import { buildRegistry, describeErrors, type Tool } from "../tools/registry";
import { openTasks, type Tasks } from "../tools/tasks";

type Fail = { code: string; message: string };
export type SettingsSource = Pick<LiveSettings, "current" | "subscribe">;
const DEFAULT_MODEL = "gpt-5.6-luna";
const NO_SETTINGS = {
	current: {
		settings: {},
		rules: { allow: [], ask: [], deny: [] },
		warnings: [],
		files: [],
	},
	subscribe: () => () => {},
};
class ProtocolError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

// The protocol host: lines in, lines out, independent of transport (stdio now,
// an in-process channel for the CLI in 1.4). One session per host.
export function createHost(
	send: (line: string) => void,
	{
		root = DEFAULT_ROOT,
		settings = NO_SETTINGS,
		tools = [],
		cleanup,
		temp = join(tmpdir(), "manas"),
	}: {
		// Where sessions are saved; tests use a temp folder.
		root?: string;
		// The merged settings files, reloaded when they change (1.6).
		settings?: SettingsSource;
		// Every tool the core has (`coreTools()`); tests bring their own.
		tools?: Tool[];
		// The 2.9 sweep of this folder (~/.manas) once a session opens; tests
		// leave it out.
		cleanup?: { dir: string };
		// Background task output and scratchpads, as Claude Code keeps them
		// in the system temp folder; tests use a temp folder of their own.
		temp?: string;
	} = {},
) {
	let replaying = false;
	let initialized = false;
	// What the front end said it can do (initialize), e.g. "user_ask".
	let capabilities: string[] = [];
	let session: Session | undefined;
	let tasks: Tasks | undefined;
	let scratch: string | undefined;
	let sessionId: string | null = null;
	let seq = 0;
	let lastState: string | undefined;
	// vibe-check or lowkey; read by every permission check.
	let mode: Mode = "manual";
	let lastMode: Mode | undefined;
	let changeMode: (next: Mode) => void = () => {};
	let requests = 0;
	const pending = new Map<
		string,
		{ resolve(r: unknown): void; reject(e: Error): void }
	>();

	const write = (msg: object) => send(JSON.stringify(msg));
	const event = <T extends EventType>(type: T, data: EventData<T>) =>
		write({
			kind: "event",
			type,
			session_id: sessionId,
			parent_id: null,
			seq: ++seq,
			...(replaying && { replay: true }),
			...data,
		});
	const notice = (level: "info" | "warn" | "error", text: string) =>
		event("notice", { level, text });
	const updateState = () => {
		const state =
			pending.size > 0
				? "waiting_for_user"
				: session?.busy
					? "running"
					: "idle";
		if ((state === lastState && mode === lastMode) || !session) return;
		lastState = state;
		lastMode = mode;
		event("state/changed", { state, mode });
	};
	// A core → front end request. It never times out; interrupt cancels it.
	function request(type: string, data: object): Promise<unknown> {
		const id = `c${++requests}`;
		const result = new Promise((resolve, reject) =>
			pending.set(id, { resolve, reject }),
		);
		write({
			kind: "request",
			id,
			type,
			session_id: sessionId,
			parent_id: null,
			...data,
		});
		updateState();
		return result;
	}
	const cancelPending = (reason: string) => {
		for (const [id, p] of pending) {
			pending.delete(id);
			write({ kind: "cancel", id, reason });
			p.reject(new Error(`request ${id} cancelled: ${reason}`));
		}
		updateState();
	};

	// The session's vault (1.8), and display streams that hold back a
	// placeholder split across text chunks.
	let vault: Vault | undefined;
	const streams = new Map<string, ReturnType<typeof restoreStream>>();
	const show = (text: string) => (vault ? vault.restore(text).text : text);

	const onSession = (e: SessionEvent) => {
		switch (e.type) {
			case "running":
			case "idle":
				return updateState();
			case "notice":
				return notice(e.level, e.text);
			// The user's own screen shows real values (protocol.md rule 7);
			// history and requests keep the placeholders.
			case "prompt_delivered":
				return event("prompt/delivered", {
					prompt_id: e.promptId,
					text: show(e.text),
				});
			case "text": {
				let stream = streams.get(e.messageId);
				if (!stream) {
					stream = restoreStream(vault ?? new Vault());
					streams.set(e.messageId, stream);
				}
				const text = stream.push(e.delta);
				if (!text) return;
				return event("message/delta", { message_id: e.messageId, text });
			}
			case "message_done": {
				const rest = streams.get(e.messageId)?.flush();
				streams.delete(e.messageId);
				if (rest) {
					event("message/delta", { message_id: e.messageId, text: rest });
				}
				return event("message/done", {
					message_id: e.messageId,
					text: show(e.text),
				});
			}
			case "tool_started":
				return event("tool/started", {
					tool_call_id: e.callId,
					name: e.name,
					input: vault ? restoreDeep(e.input, vault) : e.input,
					title: e.name,
				});
			case "tool_finished":
				return event("tool/finished", {
					tool_call_id: e.callId,
					status: e.status,
					output: show(e.output),
				});
			case "turn_finished":
				if (e.error) notice("error", e.error);
				return event("turn/finished", {
					turn_id: e.turnId,
					usage: e.usage,
					stop_reason: e.stopReason,
				});
		}
	};

	const handlers: {
		[T in RequestType]: (
			data: RequestData<T>,
		) => Result<T> | Promise<Result<T>>;
	} = {
		initialize({ capabilities: theirs }) {
			initialized = true;
			capabilities = theirs;
			return { protocol_version: PROTOCOL_VERSION, capabilities: [] };
		},
		"session/new"({ cwd, model, effort, mode: asked }) {
			noSession();
			// The request wins, then settings. A bad value from settings is
			// dropped with a warning; a bad one in the request is an error.
			const from = settings.current.settings;
			const warnings: string[] = [];
			const valid = (m: string, e?: string) => {
				try {
					checkEffort(m, e);
					return true;
				} catch (err) {
					warnings.push(`settings: ${(err as Error).message} (ignored)`);
					return false;
				}
			};
			let m = model ?? DEFAULT_MODEL;
			if (!model && from.models?.main && valid(from.models.main)) {
				m = from.models.main;
			}
			let eff = effort ?? undefined;
			if (effort == null && from.effort && valid(m, from.effort)) {
				eff = from.effort;
			}
			invalidParams(() => checkEffort(m, eff));
			let md: Mode = "manual";
			if (asked) invalidParams(() => (md = parseMode(asked)));
			else if (from.mode) {
				try {
					md = parseMode(from.mode);
				} catch (err) {
					warnings.push(
						`settings: ${(err as Error).message} (starting in vibe-check)`,
					);
				}
			}
			const id = crypto.randomUUID();
			open(
				id,
				sessionFile(projectDir(cwd, root), id),
				cwd,
				m,
				eff,
				md,
				undefined,
				warnings,
			);
			return { session_id: id };
		},
		"session/resume"({ session_id, cwd, mode: asked }) {
			noSession();
			const file = findSession(session_id, cwd, root);
			let loaded: Loaded | undefined;
			try {
				if (file) loaded = loadSession(file);
			} catch {}
			if (!file || !loaded) {
				throw new ProtocolError(
					"not_found",
					`No session found with id ${session_id}`,
				);
			}
			const { model: m, effort: eff } = loaded;
			invalidParams(() => checkEffort(m, eff ?? undefined));
			// The flag wins, then the mode it was saved in (as Claude Code).
			let md: Mode = "manual";
			if (asked) invalidParams(() => (md = parseMode(asked)));
			else {
				try {
					md = parseMode(loaded.mode);
				} catch {}
			}
			open(session_id, file, loaded.start.cwd, m, eff ?? undefined, md, loaded);
			return { session_id };
		},
		"sessions/list"({ cwd }) {
			return { sessions: listSessions(projectDir(cwd, root)) };
		},
		"session/prompt"({ text, priority }) {
			return { prompt_id: need().prompt(text, priority ?? "next") };
		},
		"session/interrupt"({ cancel_queued }) {
			return { still_queued: need().interrupt(cancel_queued ?? false) };
		},
		"session/set_model"({ model }) {
			const s = need();
			invalidParams(() => s.setModel(model));
			return { model: s.model, effort: s.effort ?? null };
		},
		"session/set_effort"({ effort }) {
			const s = need();
			invalidParams(() => s.setEffort(effort ?? undefined));
			return { model: s.model, effort: s.effort ?? null };
		},
		"session/set_mode"({ mode: asked }) {
			need();
			let next: Mode = mode;
			invalidParams(() => (next = parseMode(asked)));
			changeMode(next);
			return { mode };
		},
		// Prompts carry placeholders in history; the screen gets real values.
		"checkpoints/list"() {
			return {
				checkpoints: need()
					.checkpoints()
					.map((c) => ({
						checkpoint_id: c.id,
						prompt: c.prompt === null ? null : show(c.prompt),
						time: c.time,
						undo: c.undo && { ...c.undo, prompt: show(c.undo.prompt) },
					})),
			};
		},
		async "checkpoints/preview"({ checkpoint_id }) {
			const s = need();
			known(s, checkpoint_id);
			return { files: await s.preview(checkpoint_id) };
		},
		async "session/rewind"({ checkpoint_id, scope }) {
			const s = need();
			if (s.busy)
				throw new ProtocolError("busy", "stop the current turn first (Esc)");
			known(s, checkpoint_id);
			let r: Awaited<ReturnType<typeof s.rewind>>;
			try {
				r = await s.rewind(checkpoint_id, scope);
			} catch (err) {
				throw new ProtocolError("invalid_params", (err as Error).message);
			}
			return { ...r, prompt: r.prompt === null ? null : show(r.prompt) };
		},
		"tasks/list"() {
			need();
			return {
				tasks: (tasks?.list() ?? []).map((t) => ({
					task_id: t.id,
					description: show(t.description),
					command: show(t.command),
					status: t.status,
					started: t.started,
				})),
			};
		},
		"tasks/stop"({ task_id }) {
			need();
			const r = tasks?.stop(task_id) ?? { ok: false, text: "no tasks" };
			return { stopped: r.ok, text: show(r.text) };
		},
		// Ctrl+B: the running commands go on in the background.
		"tasks/background"() {
			need();
			return { moved: tasks?.backgroundAll("user") ?? 0 };
		},
	};
	const known = (s: Session, id: string) => {
		if (!s.checkpoints().some((c) => c.id === id))
			throw new ProtocolError("not_found", `No checkpoint ${id}`);
	};
	const noSession = () => {
		if (session) {
			throw new ProtocolError(
				"session_exists",
				"this process already has a session",
			);
		}
	};
	// A new or resumed session, saved to `file` from its first message on.
	function open(
		id: string,
		file: string,
		cwd: string,
		model: string,
		effort: string | undefined,
		startMode: Mode,
		loaded?: Loaded,
		warnings: string[] = [],
	) {
		// "Yes, and don't ask again" rules, kept for this session (saved ones
		// too, so they apply before the settings file reloads).
		const sessionRules: Rule[] = [];
		mode = startMode;
		changeMode = (next) => {
			if (next === mode) {
				notice("info", `Already in ${MODE_NAMES[next]}.`);
				return;
			}
			mode = next;
			store.set({ mode });
			updateState();
		};
		// A bare deny removes the tool for the whole session. One added later
		// keeps the list (and the prompt cache) and is refused by `permit`.
		// ask_user only for a front end that can answer, so nothing waits on
		// a script that can't.
		const canAsk = capabilities.includes("user_ask");
		const shellMax = settings.current.settings.shellOutputMaxChars;
		const registry = buildRegistry(
			tools
				.filter(
					(t) =>
						!deniedBy(t.name, settings.current.rules) &&
						(t.name !== "ask_user" || canAsk),
				)
				.map((t) =>
					t.name === "powershell" && shellMax
						? { ...t, maxResultChars: shellMax }
						: t,
				),
		);
		// The vault sits beside the session: sessions/<id>/vault.bin. Like the
		// session file, it's only written once the session has a message.
		// Fixed for the session and saved with it, like Claude Code's output
		// style: a settings change applies to new sessions.
		const verbosity = loaded
			? loaded.start.verbosity
			: (settings.current.settings.verbosity ?? "low");
		const vaultFile = join(
			dirname(file),
			basename(file, ".jsonl"),
			"vault.bin",
		);
		const opened = openVault(vaultFile);
		const v = opened.vault;
		vault = v;
		const store = openStore(
			file,
			() => ({
				model: s.model,
				effort: s.effort ?? null,
				verbosity,
				mode,
				cwd,
				version,
				created: new Date().toISOString(),
			}),
			() => saveVault(v, vaultFile),
		);
		v.onNew = () => {
			if (store.exists) saveVault(v, vaultFile);
		};
		// .env values join the vault before the first turn runs.
		const ready = preloadEnv(cwd, v).catch((err: Error) =>
			notice(
				"warn",
				`Couldn't load .env values into the vault: ${err.message}`,
			),
		);
		// The project's backups/ sits beside its sessions/ (memory-management.md).
		const backups = openBackups(join(dirname(dirname(file)), "backups"), id);
		// Not saved: a resumed session starts in the project, as in Claude Code.
		const shell = { cwd };
		// The session's temp folder, as Claude Code's: %TEMP%\manas\<project>\
		// <session>, with tasks\ (background output, scrubbed line by line)
		// and scratchpad\ (the model's own files, 3.4).
		const own = join(dirname(projectDir(cwd, temp)), id);
		const pad = join(own, "scratchpad");
		scratch = pad;
		mkdirSync(pad, { recursive: true });
		tasks = openTasks({
			dir: join(own, "tasks"),
			vault: v,
			notify: (text) => session?.notify(text),
			finished: (f) =>
				event("task/finished", {
					task_id: f.id,
					status: f.status,
					summary: show(f.summary),
					output_file: f.outputFile,
				}),
		});
		const s = createSession({
			registry,
			vault: v,
			ready,
			context: () => firstMessage(cwd, undefined, pad),
			verbosity,
			backups,
			toolCtx: {
				cwd,
				shell,
				tasks,
				denied: (path) => deniedPath(path, settings.current.rules, cwd),
				reads: readRecord(loaded?.reads, (r) => store.read(r)),
				vault: v,
				backups,
				ask: canAsk ? (questions, callId) => ask(questions, callId) : undefined,
				scratch: pad,
				// Beside the vault: sessions/<id>/tool-results (3.4).
				results: join(dirname(vaultFile), "tool-results"),
			},
			permit: async ({ tool, input, callId, diff }) => {
				const d = await decide(tool, input, {
					rules: settings.current.rules,
					session: sessionRules,
					cwd,
					here: shell.cwd,
					mode,
					scratch: pad,
				});
				if (d.behavior === "allow") return undefined;
				if (d.behavior === "deny") return { output: d.reason };
				let answer: unknown;
				try {
					answer = await request("permission/request", {
						tool_call_id: callId,
						tool: tool.name,
						input,
						title: titleOf(tool, input),
						// Holds real values (the edit restored them): the user's
						// screen only, never the model.
						diff: diff ?? null,
						reason: d.reason,
						suggestions: d.suggestions,
					});
				} catch {
					return { output: "interrupted by user" }; // cancelled
				}
				if (!Value.Check(CoreResults["permission/request"], answer)) {
					notice(
						"error",
						"The front end sent an invalid permission answer; treated as no.",
					);
					return { output: "denied (invalid answer from the front end)" };
				}
				// ponytail: no `updated_input` (a front end editing the call
				// before it runs); add with editor/open_diff (M11).
				const { decision, suggestion, message } = answer;
				if (decision === "allow") return undefined;
				if (decision === "allow_always") {
					remember(d.suggestions, suggestion ?? null);
					return undefined;
				}
				if (message) return { output: `denied by the user: ${message}` };
				// A plain No stops the turn, as in Claude Code (the session
				// interrupts when this result comes in).
				return { output: "denied by the user", stop: true };
			},
			model,
			effort,
			emit: onSession,
			onInterrupt: () => cancelPending("interrupted"),
			items: loaded?.items,
			store,
		});
		session = s;
		sessionId = id;
		// In the background and quiet, as Claude Code's; counts go to the
		// debug log. The open session is never swept.
		if (cleanup)
			sweep({
				dir: cleanup.dir,
				temp,
				days: settings.current.settings.limits?.cleanupPeriodDays ?? 30,
				keep: id,
			}).then(
				(swept) => swept && debugLog({ kind: "cleanup", ...swept }),
				() => {},
			);
		// The front end shows real values; the answers come back keyed and
		// labelled as the model wrote them (with placeholders).
		const ask = async (questions: Questions, callId: string) => {
			let answer: unknown;
			try {
				answer = await request("user/ask", {
					tool_call_id: callId,
					questions: restoreDeep(questions, v),
				});
			} catch {
				throw new Error("interrupted by user"); // cancelled
			}
			if (!Value.Check(CoreResults["user/ask"], answer)) {
				notice(
					"error",
					"The front end sent an invalid answer to the questions; treated as declined.",
				);
				return null;
			}
			const given = answer.answers;
			if (!given) return null;
			const out: Answers = {};
			for (const q of questions) {
				const a = given[show(q.question)];
				if (!a) continue;
				const labels = new Map(q.options.map((o) => [show(o.label), o.label]));
				out[q.question] = a.map((x) => labels.get(x) ?? x);
			}
			return out;
		};
		// "Yes, and don't ask again": only a suggestion the core offered,
		// with any destination. The call itself is allowed either way.
		const remember = (offered: Suggestion[], chosen: Suggestion | null) => {
			const match =
				chosen &&
				offered.find((o) =>
					"mode" in o
						? "mode" in chosen
						: "rules" in chosen &&
							o.rules.join("\n") === chosen.rules.join("\n"),
				);
			if (!chosen || !match) {
				notice(
					"error",
					"The front end sent a choice that wasn't offered; allowed once, nothing saved.",
				);
				return;
			}
			if ("mode" in chosen) return changeMode(chosen.mode);
			const files = settings.current.files;
			const file = chosen.destination === "user" ? files[0] : projectFile(cwd);
			const base = chosen.destination === "user" ? dirname(file) : cwd;
			for (const text of chosen.rules) sessionRules.push({ text, base });
			if (chosen.destination === "session") return;
			try {
				// The tracked-.manas guard leaves the project file out.
				if (!file || !files.includes(file))
					throw new Error(`${file ?? "the settings file"} isn't in use.`);
				for (const text of chosen.rules) saveRule(file, text);
			} catch (err) {
				notice(
					"error",
					`Couldn't save the rule: ${(err as Error).message} It applies to this session only.`,
				);
			}
		};
		queueMicrotask(() => {
			event("session/started", {
				model,
				effort: effort ?? null,
				mode,
				tools: registry.specs.map((t) => t.name),
				cwd,
			});
			for (const w of [...settings.current.warnings, ...warnings]) {
				notice("warn", w);
			}
			if (opened.expired) {
				notice(
					"warn",
					"Previous secret placeholders expired (the saved vault couldn't be read). Read the files again to get new placeholders.",
				);
			}
			if (loaded) {
				replaying = true;
				for (const e of s.replay()) onSession(e);
				replaying = false;
				if (loaded.skipped > 0) {
					notice(
						"warn",
						`Skipped ${loaded.skipped} damaged line(s) in the saved session.`,
					);
				}
			}
			updateState();
		});
	}
	const unsubscribe = settings.subscribe((e) =>
		e.ok
			? notice("info", "Settings reloaded.")
			: notice(
					"error",
					`Settings not reloaded: ${e.error} Keeping the last good settings.`,
				),
	);
	const invalidParams = (f: () => void) => {
		try {
			f();
		} catch (err) {
			throw new ProtocolError("invalid_params", (err as Error).message);
		}
	};
	const need = () => {
		if (!session)
			throw new ProtocolError("no_session", "send session/new first");
		return session;
	};

	function handle(msg: { id: string; type: string }) {
		const respond = (
			r: { ok: true; result: unknown } | { ok: false; error: Fail },
		) => write({ kind: "response", id: msg.id, ...r });
		try {
			if (!Object.hasOwn(Requests, msg.type)) {
				throw new ProtocolError(
					"unknown_type",
					`unknown request type "${msg.type}"`,
				);
			}
			const type = msg.type as RequestType;
			if (!initialized && type !== "initialize") {
				throw new ProtocolError("not_initialized", "send initialize first");
			}
			const handler = handlers[type] as (d: unknown) => unknown;
			const result = handler(parse(type, msg));
			// /rewind's requests touch files, so they answer later.
			if (result instanceof Promise) {
				result.then(
					(r) => respond({ ok: true, result: r }),
					(err) => {
						if (!(err instanceof ProtocolError)) throw err;
						respond({
							ok: false,
							error: { code: err.code, message: err.message },
						});
					},
				);
			} else respond({ ok: true, result });
		} catch (err) {
			if (!(err instanceof ProtocolError)) throw err;
			respond({ ok: false, error: { code: err.code, message: err.message } });
		}
	}

	return {
		// One incoming line. A bad line gets an error back, never a crash (rule 1).
		receive(line: string) {
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				return notice("error", "line is not valid JSON");
			}
			const kind = (msg as { kind?: unknown })?.kind;
			if (kind === "request") {
				const errors = Value.Errors(Line.request, msg);
				const id = (msg as { id?: unknown }).id;
				if (errors.length === 0)
					return handle(msg as { id: string; type: string });
				const message = `invalid request: ${describeErrors(errors).join("; ")}`;
				if (typeof id !== "string" || id === "")
					return notice("error", message);
				return write({
					kind: "response",
					id,
					ok: false,
					error: { code: "invalid_request", message },
				});
			}
			if (kind === "response") {
				if (!Value.Check(Line.response, msg))
					return notice("error", "invalid response");
				const r = msg as {
					id: string;
					ok: boolean;
					result?: unknown;
					error?: Fail;
				};
				const p = pending.get(r.id);
				if (!p) return; // Already cancelled, or never ours.
				pending.delete(r.id);
				updateState();
				return r.ok
					? p.resolve(r.result)
					: p.reject(new Error(`${r.error?.code}: ${r.error?.message}`));
			}
			// Every front-end request is answered at once, so there's nothing to withdraw.
			if (kind === "cancel") return;
			notice("error", `unknown line kind ${JSON.stringify(kind)}`);
		},
		request,
		// The front end went away: stop work, withdraw requests.
		close() {
			unsubscribe();
			session?.interrupt(true);
			tasks?.killAll();
			// The scratchpad and its parents, once empty; files in it stay
			// with the session (the cleanup deletes them with it).
			if (scratch)
				try {
					rmdirSync(scratch);
					rmdirSync(dirname(scratch));
					rmdirSync(dirname(dirname(scratch)));
				} catch {}
			cancelPending("closed");
		},
	};

	function parse<T extends RequestType>(type: T, msg: unknown) {
		const errors = Value.Errors(Requests[type], msg);
		if (errors.length > 0) {
			throw new ProtocolError(
				"invalid_request",
				`invalid ${type}: ${describeErrors(errors).join("; ")}`,
			);
		}
		return msg as RequestData<T>;
	}
}

// One line for the approval prompt.
function titleOf(tool: Tool, input: unknown) {
	if (tool.title) return tool.title(input);
	const command = tool.permission?.command?.(input);
	if (command !== undefined) return `run: ${command}`;
	const path = tool.permission?.path?.(input);
	return path !== undefined ? `${tool.name}: ${path}` : `use ${tool.name}`;
}
