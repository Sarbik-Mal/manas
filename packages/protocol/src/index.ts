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
	// `mode`: plain or display name; null = settings, else vibe-check.
	"session/new": Type.Object({
		cwd: Type.String(),
		model: Nullable(Type.String()),
		effort: Nullable(Type.String()),
		mode: Nullable(Type.String()),
	}),
	// `next` (default): folded into the running turn once its tools finish.
	// `later`: after the turn ends. `now`: interrupts, then runs.
	"session/prompt": Type.Object({
		text: Type.String(),
		priority: Nullable(Priority),
	}),
	// Loads a saved session and replays it as events with `replay: true`.
	// Looks in `cwd`'s project first, then in every project.
	// `mode` null: the mode the session was saved in.
	"session/resume": Type.Object({
		session_id: Type.String(),
		cwd: Type.String(),
		mode: Nullable(Type.String()),
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
	// vibe-check (`manual`) or lowkey (`acceptEdits`), plain or display name;
	// applies from the next tool call.
	"session/set_mode": Type.Object({ mode: Type.String() }),
	// The points /rewind can go back to, oldest first (2.6).
	"checkpoints/list": Type.Object({}),
	// What restoring the code of a checkpoint would change, before doing it.
	"checkpoints/preview": Type.Object({ checkpoint_id: Type.String() }),
	// Back to before that checkpoint's prompt. A code rewind first saves the
	// files as they are ("before rewind"), so it can be undone.
	"session/rewind": Type.Object({
		checkpoint_id: Type.String(),
		scope: Type.Union([
			Type.Literal("code"),
			Type.Literal("conversation"),
			Type.Literal("both"),
		]),
	}),
	// Background commands (3.3): list them, stop one, or move the running
	// foreground commands to the background (Ctrl+B).
	"tasks/list": Type.Object({}),
	"tasks/stop": Type.Object({ task_id: Type.String() }),
	"tasks/background": Type.Object({}),
};
const Mode = Type.Union([Type.Literal("manual"), Type.Literal("acceptEdits")]);
// What "Yes, and don't ask again" does: add rules to a settings file (or the
// session), or switch to lowkey. A front end may change only `destination`.
const Suggestion = Type.Union([
	Type.Object({
		rules: Type.Array(Type.String()),
		destination: Type.Union([
			Type.Literal("session"),
			Type.Literal("project"),
			Type.Literal("user"),
		]),
	}),
	Type.Object({ mode: Type.Literal("acceptEdits") }),
]);
const TaskStatus = Type.Union([
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("killed"),
]);
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
	"session/set_mode": Type.Object({ mode: Mode }),
	// Prompts, oldest first, then (only while it's the newest checkpoint) the
	// undo or redo of the last code rewind: `prompt` null, `undo` saying which
	// prompt that rewind went back to and which files it changes back.
	"checkpoints/list": Type.Object({
		checkpoints: Type.Array(
			Type.Object({
				checkpoint_id: Type.String(),
				prompt: Nullable(Type.String()),
				time: Type.String(),
				undo: Nullable(
					Type.Object({
						kind: Type.Union([Type.Literal("undo"), Type.Literal("redo")]),
						prompt: Type.String(),
						paths: Type.Array(Type.String()),
					}),
				),
			}),
		),
	}),
	"checkpoints/preview": Type.Object({
		files: Type.Array(
			Type.Object({
				path: Type.String(),
				action: Type.Union([
					Type.Literal("restore"),
					Type.Literal("delete"),
					Type.Literal("recreate"),
				]),
				added: Type.Integer(),
				removed: Type.Integer(),
			}),
		),
	}),
	// `prompt`: the rewound prompt, for the input box (conversation rewinds).
	"session/rewind": Type.Object({
		prompt: Nullable(Type.String()),
		restored: Type.Array(Type.String()),
		failed: Type.Array(
			Type.Object({ path: Type.String(), error: Type.String() }),
		),
	}),
	"tasks/list": Type.Object({
		tasks: Type.Array(
			Type.Object({
				task_id: Type.String(),
				description: Type.String(),
				command: Type.String(),
				status: TaskStatus,
				started: Type.String(),
			}),
		),
	}),
	// `text` as the model would see it ("Successfully stopped task: …").
	"tasks/stop": Type.Object({ stopped: Type.Boolean(), text: Type.String() }),
	"tasks/background": Type.Object({ moved: Type.Integer() }),
};

export const Usage = Type.Object({
	input: Type.Integer(),
	cached: Type.Integer(),
	output: Type.Integer(),
	reasoning: Type.Integer(),
});

// Core → front end events: their fields.
// Core → front end requests: their fields, and what the response's `result`
// holds. Front ends answer; requests never time out but can be cancelled.
export const CoreRequests = {
	// A tool call needs the user's yes or no. `suggestions`: what "Yes, and
	// don't ask again" can do; `allow_always` sends back the chosen one.
	"permission/request": Type.Object({
		tool_call_id: Type.String(),
		tool: Type.String(),
		input: Type.Unknown(),
		title: Type.String(),
		// What the change does, e.g. an edit's -/+ lines (2.2).
		diff: Nullable(Type.String()),
		reason: Type.String(),
		suggestions: Type.Array(Suggestion),
	}),
	// The model's questions (ask_user), sent only to a front end that
	// declared "user_ask". Never times out; an interrupt cancels it.
	"user/ask": Type.Object({
		tool_call_id: Type.String(),
		questions: Type.Array(
			Type.Object({
				question: Type.String(),
				header: Type.String(),
				options: Type.Array(
					Type.Object({
						label: Type.String(),
						description: Type.String(),
						preview: Nullable(Type.String()),
					}),
				),
				multiSelect: Type.Boolean(),
			}),
		),
	}),
};
export const CoreResults = {
	// `deny` with a `message`: the model is told and keeps going. Without one,
	// the turn stops.
	"permission/request": Type.Object({
		decision: Type.Union([
			Type.Literal("allow"),
			Type.Literal("allow_always"),
			Type.Literal("deny"),
		]),
		suggestion: Nullable(Suggestion),
		message: Nullable(Type.String()),
	}),
	// Question text → the chosen labels, or what the user typed. null: the
	// user declined, and the turn stops.
	"user/ask": Type.Object({
		answers: Type.Union([
			Type.Record(Type.String(), Type.Array(Type.String())),
			Type.Null(),
		]),
	}),
};

export const Events = {
	"session/started": Type.Object({
		model: Type.String(),
		effort: Type.Union([Type.String(), Type.Null()]),
		mode: Mode,
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
			Type.Literal("denied"),
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
	// A background command ended or was stopped; the model gets a notice too.
	"task/finished": Type.Object({
		task_id: Type.String(),
		status: TaskStatus,
		summary: Type.String(),
		output_file: Type.String(),
	}),
	// A turn ending isn't the session ending: wait for `idle` (rule 4).
	"state/changed": Type.Object({
		state: Type.Union([
			Type.Literal("running"),
			Type.Literal("waiting_for_user"),
			Type.Literal("idle"),
		]),
		mode: Mode,
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
