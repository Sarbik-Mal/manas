import {
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
import type { LiveSettings } from "../config/settings";
import {
	createSession,
	type Session,
	type SessionEvent,
} from "../loop/session";
import { deniedBy } from "../permissions/rules";
import { checkEffort } from "../provider/models";
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
		// Every tool the core has; real ones arrive in 1.9.
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
	const cancelPending = (reason: string) => {
		for (const [id, p] of pending) {
			pending.delete(id);
			write({ kind: "cancel", id, reason });
			p.reject(new Error(`request ${id} cancelled: ${reason}`));
		}
		updateState();
	};

	const onSession = (e: SessionEvent) => {
		switch (e.type) {
			case "running":
			case "idle":
				return updateState();
			case "notice":
				return notice(e.level, e.text);
			case "prompt_delivered":
				return event("prompt/delivered", {
					prompt_id: e.promptId,
					text: e.text,
				});
			case "text":
				return event("message/delta", {
					message_id: e.messageId,
					text: e.delta,
				});
			case "message_done":
				return event("message/done", { message_id: e.messageId, text: e.text });
			case "tool_started":
				return event("tool/started", {
					tool_call_id: e.callId,
					name: e.name,
					input: e.input,
					title: e.name,
				});
			case "tool_finished":
				return event("tool/finished", {
					tool_call_id: e.callId,
					status: e.status,
					output: e.output,
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
		// A bare deny removes the tool for the whole session. One added later
		// keeps the list (and the prompt cache) and is refused by `permit`.
		const registry = buildRegistry(
			tools.filter((t) => !deniedBy(t.name, settings.current.rules)),
		);
		const s = createSession({
			registry,
			permit: (name) => {
				const rule = deniedBy(name, settings.current.rules);
				return rule ? `denied by your settings (${rule})` : undefined;
			},
			model,
			effort,
			emit: onSession,
			onInterrupt: () => cancelPending("interrupted"),
			items: loaded?.items,
			store: openStore(file, () => ({
				model: s.model,
				effort: s.effort ?? null,
				cwd,
				version,
				created: new Date().toISOString(),
			})),
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
		// A core → front end request. It never times out; interrupt cancels it.
		request(type: string, data: object): Promise<unknown> {
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
		},
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
