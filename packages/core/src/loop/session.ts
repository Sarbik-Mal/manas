import type { ResponseInputItem } from "openai/resources/responses/responses";
import { capability, checkEffort } from "../provider/models";
import type { Usage } from "../provider/openai";
import { scrubItem, type Vault } from "../safety/scrub";
import { CUT_OFF, type Store, textOf } from "../session/store";
import type { Backups } from "../tools/backups";
import type { Permit, Registry, SessionCtx } from "../tools/registry";
import { dateNote, today as localToday } from "./prompt";
import { type LoopEvent, runTurn } from "./turn";

export type Priority = "next" | "later" | "now";

// Loop events plus the ids a front end needs to tie them together.
export type SessionEvent =
	| { type: "running" }
	| { type: "idle" }
	| { type: "notice"; level: "info" | "warn"; text: string }
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

// memory-management.md §6 and §7: the user may change either mid-chat, and is
// told plainly what it costs. The core never changes them by itself.
const costWarning = (what: string) =>
	"Heads up: your next reply will cost more than usual. OpenAI gives a discount on the parts of this conversation it has already seen. " +
	`Changing the ${what} makes it start fresh, so the discount is lost for one reply. After that, it comes back.`;

// One conversation: history, a prompt queue and at most one running turn.
// Prompts run first in, first out; `next` ones are also folded into the
// running turn between rounds (as in Claude Code).
export function createSession({
	registry,
	model: startModel,
	effort: startEffort,
	emit,
	onInterrupt = () => {},
	store,
	items = [],
	permit,
	vault,
	ready,
	toolCtx,
	backups,
	context,
	today = localToday,
	verbosity,
}: {
	registry: Registry;
	model: string;
	effort?: string;
	// Where history is saved (1.5); none in tests that don't need it.
	store?: Store;
	// Secrets in every item are replaced before it's kept (1.8).
	vault?: Vault;
	// Turns wait for this, e.g. the .env preload, so no secret slips past.
	ready?: Promise<unknown>;
	// A resumed session's history, already on disk.
	items?: ResponseInputItem[];
	// Step 2 of every tool call: settings rules now, the engine in 1.7.
	permit?: Permit;
	// The project folder and deny check every tool call gets.
	toolCtx?: SessionCtx;
	// A checkpoint when each turn starts (2.5); the same backups as toolCtx's.
	backups?: Backups;
	// The first message of a new session (its environment), sent before the
	// first prompt; a resumed session already has it.
	context?: () => string;
	// Today's date, as YYYY-MM-DD; tests move the clock.
	today?: () => string;
	// Answer length, fixed for the session so the cache never breaks.
	verbosity?: string;
	emit: (e: SessionEvent) => void;
	// Called whenever a turn is stopped, so pending requests can be withdrawn.
	onInterrupt?: () => void;
}) {
	const history: ResponseInputItem[] = [...items];
	// Every item the loop adds is scrubbed, then saved, then kept: secrets never
	// reach the model or the session file, and a killed process loses at most
	// the line being written. One spot covers every push. Scrubbed once, on
	// the way in, so history never changes later (that would break the cache).
	if (store || vault) {
		history.push = (...added) => {
			const clean = vault ? added.map((i) => scrubItem(i, vault)) : added;
			for (const i of clean) store?.item(i);
			return Array.prototype.push.apply(history, clean);
		};
	}
	// Read when each turn starts, so a change applies from the next turn.
	let model = startModel;
	let effort = startEffort;
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
			// After `running` is this turn's: an interrupt during the wait
			// aborts it, and the turn ends `interrupted` without a request.
			await ready;
			// Appended, never edited in: the cached prefix stays the same.
			if (context) {
				const note =
					history.length === 0 ? context() : dateNote(history, today());
				if (note) history.push({ role: "developer", content: note });
			}
			// The code as it is before this prompt, for /rewind (2.6). Prompts
			// folded into a running turn get none, as in Claude Code.
			await backups?.checkpoint(history.length);
			const turnId = `t${++turns}`;
			let messageId: string | undefined;
			for await (const e of runTurn(history, deliver(q), {
				registry,
				model,
				effort,
				verbosity,
				signal: ac.signal,
				inject: takeNext,
				permit,
				ctx: toolCtx,
			})) {
				if (e.type === "text") {
					messageId ??= `m${++messages}`;
					emit({ ...e, messageId });
				} else if (e.type === "message_done") {
					emit({ ...e, messageId: messageId ?? `m${++messages}` });
					messageId = undefined;
				} else if (e.type === "turn_finished") {
					store?.usage(turnId, e.usage);
					emit({ ...e, turnId });
				} else {
					emit(e);
					// Stopped here, before the loop moves on: the rest of the
					// turn ends `interrupted`, and queued prompts still run.
					if (e.type === "tool_finished" && e.stop) stop();
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
		// The saved conversation as events, so a front end can show it again.
		replay() {
			return replayEvents(history);
		},
		get busy() {
			return running !== undefined;
		},
		get model() {
			return model;
		},
		get effort() {
			return effort;
		},
		// Both throw on an unknown model or an effort the model can't take.
		setModel(next: string) {
			checkEffort(next, effort);
			if (next === model) {
				emit({ type: "notice", level: "info", text: `Already using ${next}.` });
				return;
			}
			model = next;
			store?.set({ model: next });
			if (history.length > 0)
				emit({ type: "notice", level: "warn", text: costWarning("model") });
		},
		setEffort(next: string | undefined) {
			checkEffort(model, next);
			if (next === effort) {
				emit({
					type: "notice",
					level: "info",
					text: `Already using effort ${next ?? "default"}.`,
				});
				return;
			}
			effort = next;
			store?.set({ effort: next ?? null });
			if (capability(model).efforts.length === 0) {
				emit({
					type: "notice",
					level: "info",
					text: `${model} has no reasoning effort; it applies when you switch to a model that has one.`,
				});
			} else if (history.length > 0) {
				emit({ type: "notice", level: "warn", text: costWarning("effort") });
			}
		},
	};
}

export type Session = ReturnType<typeof createSession>;

const zero = { input: 0, cached: 0, output: 0, reasoning: 0 };

// Rebuilds what the screen showed from history. Reasoning items are skipped.
export function replayEvents(history: ResponseInputItem[]): SessionEvent[] {
	const out: SessionEvent[] = [];
	let n = 0;
	for (const i of history) {
		if (i.type === "function_call") {
			let input: unknown = i.arguments;
			try {
				input = JSON.parse(i.arguments);
			} catch {}
			out.push({
				type: "tool_started",
				callId: i.call_id,
				name: i.name,
				input,
			});
		} else if (i.type === "function_call_output") {
			const output =
				typeof i.output === "string" ? i.output : JSON.stringify(i.output);
			const status = output.startsWith("error:")
				? "error"
				: output === "interrupted by user" || output === CUT_OFF
					? "interrupted"
					: "ok";
			out.push({
				type: "tool_finished",
				callId: String(i.call_id),
				status,
				output,
			});
		} else if ("role" in i && i.role === "user") {
			out.push({
				type: "prompt_delivered",
				promptId: `r${++n}`,
				text: textOf(i),
			});
		} else if ("role" in i && i.role === "assistant") {
			out.push({ type: "message_done", messageId: `rm${n}`, text: textOf(i) });
		} else if (
			"role" in i &&
			i.role === "developer" &&
			textOf(i) === "[interrupted by user]"
		) {
			out.push({
				type: "turn_finished",
				turnId: `r${n}`,
				stopReason: "interrupted",
				usage: zero,
			});
		}
	}
	return out;
}
