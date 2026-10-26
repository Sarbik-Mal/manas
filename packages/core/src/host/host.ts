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
import {
	createSession,
	type Session,
	type SessionEvent,
} from "../loop/session";
import { checkEffort } from "../provider/models";
import { buildRegistry, describeErrors } from "../tools/registry";

type Fail = { code: string; message: string };
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
	defaults: { model?: string; effort?: string } = {},
) {
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
				if (session)
					throw new ProtocolError(
						"session_exists",
						"this process already has a session",
					);
				const m = model ?? defaults.model ?? "gpt-5.6-luna";
				const eff = effort ?? defaults.effort;
				try {
					checkEffort(m, eff);
				} catch (err) {
					throw new ProtocolError("invalid_params", (err as Error).message);
				}
				const registry = buildRegistry([]);
				session = createSession({
					registry,
					model: m,
					effort: eff,
					emit: onSession,
					onInterrupt: () => cancelPending("interrupted"),
				});
				sessionId = crypto.randomUUID();
				queueMicrotask(() => {
					event("session/started", {
						model: m,
						effort: eff ?? null,
						tools: registry.specs.map((s) => s.name),
						cwd,
					});
					updateState();
				});
				return { session_id: sessionId };
			},
			"session/prompt"({ text, priority }) {
				return { prompt_id: need().prompt(text, priority ?? "next") };
			},
			"session/interrupt"({ cancel_queued }) {
				return { still_queued: need().interrupt(cancel_queued ?? false) };
			},
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
