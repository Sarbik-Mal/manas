import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { Usage } from "../provider/openai";
import type { Registry } from "../tools/registry";
import { type LoopEvent, runTurn } from "./turn";

export type Priority = "next" | "later" | "now";

// Loop events plus the ids a front end needs to tie them together.
export type SessionEvent =
	| { type: "running" }
	| { type: "idle" }
	| { type: "prompt_delivered"; promptId: string; text: string }
	| { type: "text"; messageId: string; delta: string }
	| { type: "message_done"; messageId: string; text: string }
	| Extract<LoopEvent, { type: "tool_started" | "tool_finished" }>
	| {
			type: "turn_finished";
			turnId: string;
			stopReason: "done" | "interrupted" | "error";
			usage: Usage;
			error?: string;
	  };

type Queued = { id: string; text: string; priority: Priority };

// One conversation: history, a prompt queue and at most one running turn.
// Prompts run first in, first out; `next` ones are also folded into the
// running turn between rounds (as in Claude Code).
export function createSession({
	registry,
	model,
	effort,
	emit,
	onInterrupt = () => {},
}: {
	registry: Registry;
	model?: string;
	effort?: string;
	emit: (e: SessionEvent) => void;
	// Called whenever a turn is stopped, so pending requests can be withdrawn.
	onInterrupt?: () => void;
}) {
	const history: ResponseInputItem[] = [];
	const queue: Queued[] = [];
	let running: AbortController | undefined;
	let prompts = 0;
	let turns = 0;
	let messages = 0;

	const deliver = (q: Queued) => {
		emit({ type: "prompt_delivered", promptId: q.id, text: q.text });
		return q.text;
	};
	const takeNext = () => {
		const next = queue.filter((q) => q.priority === "next");
		for (const q of next) queue.splice(queue.indexOf(q), 1);
		return next.map(deliver);
	};
	const stop = () => {
		running?.abort();
		onInterrupt();
	};

	// Runs turns until the queue is empty.
	async function pump() {
		running = new AbortController();
		emit({ type: "running" });
		for (let q = queue.shift(); q; q = queue.shift()) {
			const ac = new AbortController();
			running = ac;
			const turnId = `t${++turns}`;
			let messageId: string | undefined;
			for await (const e of runTurn(history, deliver(q), {
				registry,
				model,
				effort,
				signal: ac.signal,
				inject: takeNext,
			})) {
				if (e.type === "text") {
					messageId ??= `m${++messages}`;
					emit({ ...e, messageId });
				} else if (e.type === "message_done") {
					emit({ ...e, messageId: messageId ?? `m${++messages}` });
					messageId = undefined;
				} else if (e.type === "turn_finished") {
					emit({ ...e, turnId });
				} else {
					emit(e);
				}
			}
		}
		running = undefined;
		emit({ type: "idle" });
	}

	return {
		history,
		// Returns at once; the turn starts on the next tick, so a front end gets
		// its response before the events.
		prompt(text: string, priority: Priority = "next") {
			const q = { id: `p${++prompts}`, text, priority };
			if (priority === "now") {
				queue.unshift(q);
				if (running) stop();
			} else {
				queue.push(q);
			}
			if (!running) {
				queueMicrotask(() => {
					if (!running && queue.length > 0) void pump();
				});
			}
			return q.id;
		},
		// Queued prompts survive and still run, unless `cancelQueued`.
		interrupt(cancelQueued = false) {
			if (cancelQueued) queue.length = 0;
			if (running) stop();
			return queue.map((q) => q.id);
		},
		get busy() {
			return running !== undefined;
		},
	};
}

export type Session = ReturnType<typeof createSession>;
