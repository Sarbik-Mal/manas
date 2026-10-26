// Messages between the core and every front end (planning_docs/protocol.md).
// NDJSON: one JSON object per line. Unknown fields are allowed everywhere, so
// an older front end keeps working with a newer core (rule 2).
import Type, { type Static, type TSchema } from "typebox";

// Changes only for breaking changes; features are announced as capabilities.
export const PROTOCOL_VERSION = 1;

const Nullable = <T extends TSchema>(t: T) =>
	Type.Optional(Type.Union([t, Type.Null()]));
const Id = Type.String({ minLength: 1 });

// The 4 line kinds. A request's or event's own fields sit next to these.
export const Line = {
	request: Type.Object({
		kind: Type.Literal("request"),
		id: Id,
		type: Type.String(),
		session_id: Nullable(Type.String()),
	}),
	response: Type.Union([
		Type.Object({
			kind: Type.Literal("response"),
			id: Id,
			ok: Type.Literal(true),
			result: Type.Unknown(),
		}),
		Type.Object({
			kind: Type.Literal("response"),
			id: Id,
			ok: Type.Literal(false),
			error: Type.Object({ code: Type.String(), message: Type.String() }),
		}),
	]),
	cancel: Type.Object({
		kind: Type.Literal("cancel"),
		id: Id,
		reason: Type.Optional(Type.String()),
	}),
	event: Type.Object({
		kind: Type.Literal("event"),
		type: Type.String(),
		session_id: Type.Union([Type.String(), Type.Null()]),
		parent_id: Type.Union([Type.String(), Type.Null()]),
		seq: Type.Integer(),
		// Rebuilt from a saved session on resume, not happening now.
		replay: Type.Optional(Type.Boolean()),
	}),
};

export const Priority = Type.Union([
	Type.Literal("next"),
	Type.Literal("later"),
	Type.Literal("now"),
]);

// Front end → core requests: their fields, and what the response's `result` holds.
export const Requests = {
	initialize: Type.Object({
		client: Type.Object({ name: Type.String(), version: Type.String() }),
		capabilities: Type.Array(Type.String()),
	}),
	"session/new": Type.Object({
		cwd: Type.String(),
		model: Nullable(Type.String()),
		effort: Nullable(Type.String()),
	}),
	// `next` (default): folded into the running turn once its tools finish.
	// `later`: after the turn ends. `now`: interrupts, then runs.
	"session/prompt": Type.Object({
		text: Type.String(),
		priority: Nullable(Priority),
	}),
	// Loads a saved session and replays it as events with `replay: true`.
	// Looks in `cwd`'s project first, then in every project.
	"session/resume": Type.Object({
		session_id: Type.String(),
		cwd: Type.String(),
	}),
	// Saved sessions of `cwd`'s project, newest first.
	"sessions/list": Type.Object({ cwd: Type.String() }),
	// Queued prompts survive an interrupt unless `cancel_queued`.
	"session/interrupt": Type.Object({ cancel_queued: Nullable(Type.Boolean()) }),
	// Both apply from the next turn. Changing either after a reply loses the
	// cache discount for one reply, so the core sends a warning notice.
	// `role` is only "main" until subagents bring "cheap".
	"session/set_model": Type.Object({
		model: Type.String(),
		role: Nullable(Type.Literal("main")),
	}),
	// `null`: the model's default.
	"session/set_effort": Type.Object({
		effort: Type.Union([Type.String(), Type.Null()]),
	}),
};
const ModelState = Type.Object({
	model: Type.String(),
	effort: Type.Union([Type.String(), Type.Null()]),
});
export const Results = {
	initialize: Type.Object({
		protocol_version: Type.Integer(),
		capabilities: Type.Array(Type.String()),
	}),
	"session/new": Type.Object({ session_id: Type.String() }),
	"session/prompt": Type.Object({ prompt_id: Type.String() }),
	"session/interrupt": Type.Object({ still_queued: Type.Array(Type.String()) }),
	"session/resume": Type.Object({ session_id: Type.String() }),
	"sessions/list": Type.Object({
		sessions: Type.Array(
			Type.Object({
				session_id: Type.String(),
				title: Type.String(),
				updated: Type.String(),
				messages: Type.Integer(),
			}),
		),
	}),
	"session/set_model": ModelState,
	"session/set_effort": ModelState,
};

export const Usage = Type.Object({
	input: Type.Integer(),
	cached: Type.Integer(),
	output: Type.Integer(),
	reasoning: Type.Integer(),
});

// Core → front end events: their fields.
export const Events = {
	"session/started": Type.Object({
		model: Type.String(),
		effort: Type.Union([Type.String(), Type.Null()]),
		tools: Type.Array(Type.String()),
		cwd: Type.String(),
	}),
	// A prompt entered the conversation: a new turn, or folded in by `next`.
	"prompt/delivered": Type.Object({
		prompt_id: Type.String(),
		text: Type.String(),
	}),
	"message/delta": Type.Object({
		message_id: Type.String(),
		text: Type.String(),
	}),
	"message/done": Type.Object({
		message_id: Type.String(),
		text: Type.String(),
	}),
	"tool/started": Type.Object({
		tool_call_id: Type.String(),
		name: Type.String(),
		input: Type.Unknown(),
		title: Type.String(),
	}),
	"tool/finished": Type.Object({
		tool_call_id: Type.String(),
		status: Type.Union([
			Type.Literal("ok"),
			Type.Literal("error"),
			Type.Literal("interrupted"),
		]),
		output: Type.String(),
	}),
	"turn/finished": Type.Object({
		turn_id: Type.String(),
		usage: Usage,
		stop_reason: Type.Union([
			Type.Literal("done"),
			Type.Literal("interrupted"),
			Type.Literal("error"),
		]),
	}),
	// A turn ending isn't the session ending: wait for `idle` (rule 4).
	"state/changed": Type.Object({
		state: Type.Union([
			Type.Literal("running"),
			Type.Literal("waiting_for_user"),
			Type.Literal("idle"),
		]),
	}),
	notice: Type.Object({
		level: Type.Union([
			Type.Literal("info"),
			Type.Literal("warn"),
			Type.Literal("error"),
		]),
		text: Type.String(),
	}),
};

export type RequestType = keyof typeof Requests;
export type RequestData<T extends RequestType> = Static<(typeof Requests)[T]>;
export type Result<T extends RequestType> = Static<(typeof Results)[T]>;
export type EventType = keyof typeof Events;
export type EventData<T extends EventType> = Static<(typeof Events)[T]>;
export type Priority = Static<typeof Priority>;
export type Usage = Static<typeof Usage>;
