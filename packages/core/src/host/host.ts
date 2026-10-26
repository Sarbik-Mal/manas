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
import type { LiveSettings, Rule } from "../config/settings";
import { firstMessage } from "../loop/prompt";
import {
	createSession,
	type Session,
	type SessionEvent,
} from "../loop/session";
import { decide, deniedBy, deniedPath } from "../permissions/engine";
import { checkEffort } from "../provider/models";
import { preloadEnv } from "../safety/env-preload";
import { restoreDeep, restoreStream, Vault } from "../safety/scrub";
import { openVault, saveVault } from "../safety/vault-file";
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
import { readRecord } from "../tools/reads";
import { buildRegistry, describeErrors, type Tool } from "../tools/registry";

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
	}: {
		// Where sessions are saved; tests use a temp folder.
		root?: string;
		// The merged settings files, reloaded when they change (1.6).
		settings?: SettingsSource;
		// Every tool the core has (`coreTools()`); tests bring their own.
		tools?: Tool[];
	} = {},
) {
	let replaying = false;
	let initialized = false;
	let session: Session | undefined;
	let sessionId: string | null = null;
	let seq = 0;
	let lastState: string | undefined;
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
		if (state === lastState || !session) return;
		lastState = state;
		event("state/changed", { state });
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

	const handlers: { [T in RequestType]: (data: RequestData<T>) => Result<T> } =
		{
			initialize() {
				initialized = true;
				return { protocol_version: PROTOCOL_VERSION, capabilities: [] };
			},
			"session/new"({ cwd, model, effort }) {
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
				const id = crypto.randomUUID();
				open(
					id,
					sessionFile(projectDir(cwd, root), id),
					cwd,
					m,
					eff,
					undefined,
					warnings,
				);
				return { session_id: id };
			},
			"session/resume"({ session_id, cwd }) {
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
				open(session_id, file, loaded.start.cwd, m, eff ?? undefined, loaded);
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
		loaded?: Loaded,
		warnings: string[] = [],
	) {
		// "Yes, and don't ask again this session" rules (saving them: 2.7).
		const sessionRules: Rule[] = [];
		// A bare deny removes the tool for the whole session. One added later
		// keeps the list (and the prompt cache) and is refused by `permit`.
		const registry = buildRegistry(
			tools.filter((t) => !deniedBy(t.name, settings.current.rules)),
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
		const s = createSession({
			registry,
			vault: v,
			ready,
			context: () => firstMessage(cwd),
			verbosity,
			toolCtx: {
				cwd,
				denied: (path) => deniedPath(path, settings.current.rules, cwd),
				reads: readRecord(loaded?.reads, (r) => store.read(r)),
				vault: v,
			},
			permit: async ({ tool, input, callId, diff }) => {
				const d = await decide(tool, input, {
					rules: settings.current.rules,
					session: sessionRules,
					cwd,
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
				const { decision, message } = answer;
				if (decision === "allow") return undefined;
				if (decision === "allow_always") {
					for (const text of d.suggestions)
						sessionRules.push({ text, base: cwd });
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
		queueMicrotask(() => {
			event("session/started", {
				model,
				effort: effort ?? null,
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
			respond({ ok: true, result: handler(parse(type, msg)) });
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
