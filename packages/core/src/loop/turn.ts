import type {
	ResponseFunctionToolCall,
	ResponseInputItem,
} from "openai/resources/responses/responses";
import { streamResponse, type Usage } from "../provider/openai";
import { Vault } from "../safety/scrub";
import { NO_BACKUPS } from "../tools/backups";
import { readRecord } from "../tools/reads";
import {
	buildRegistry,
	callTool,
	type Permit,
	type Registry,
	type SessionCtx,
} from "../tools/registry";
import { INSTRUCTIONS } from "./prompt";

export type LoopEvent =
	| { type: "text"; delta: string }
	| { type: "message_done"; text: string }
	| { type: "tool_started"; callId: string; name: string; input: unknown }
	| {
			type: "tool_finished";
			callId: string;
			status: "ok" | "error" | "denied" | "interrupted";
			output: string;
			// The user said a plain No: whoever runs the turn stops it.
			stop?: boolean;
	  }
	| {
			type: "turn_finished";
			stopReason: "done" | "interrupted" | "error";
			usage: Usage;
			error?: string;
	  };

const INTERRUPTED = "interrupted by user";
const asItem = (p: string | ResponseInputItem): ResponseInputItem =>
	typeof p === "string" ? { role: "user", content: p } : p;
const note: ResponseInputItem = {
	role: "developer",
	content: `[${INTERRUPTED}]`,
};

// One user prompt: model → tool calls → results → model, until the model stops
// calling tools or `signal` aborts. `history` is only ever appended to, so the
// prompt cache prefix never changes. `inject` hands over prompts sent during
// the turn; they join between rounds, after the tool results. A prompt is the
// user's text, or an item such as a background task's notice (3.3).
export async function* runTurn(
	history: ResponseInputItem[],
	prompt: string | ResponseInputItem,
	{
		registry = buildRegistry([]),
		signal = new AbortController().signal,
		inject = () => [],
		permit,
		ctx = {
			cwd: process.cwd(),
			shell: { cwd: process.cwd() },
			denied: () => undefined,
			reads: readRecord(),
			vault: new Vault(),
			backups: NO_BACKUPS,
		},
		...opts
	}: {
		model?: string;
		effort?: string;
		verbosity?: string;
		registry?: Registry;
		signal?: AbortSignal;
		inject?: () => (string | ResponseInputItem)[];
		permit?: Permit;
		// What every tool call gets besides the signal.
		ctx?: SessionCtx;
	} = {},
): AsyncGenerator<LoopEvent> {
	const usage: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
	const finish = (stopReason: "done" | "interrupted") =>
		({ type: "turn_finished", stopReason, usage }) as const;
	history.push(asItem(prompt));
	while (true) {
		let text = "";
		let output: ResponseInputItem[];
		try {
			const reply = streamResponse(history, {
				...opts,
				instructions: INSTRUCTIONS,
				tools: registry.specs,
				signal,
			});
			let r = await reply.next();
			for (; !r.done; r = await reply.next()) {
				text += r.value;
				yield { type: "text", delta: r.value };
			}
			output = r.value.output;
			// ponytail: an interrupted reply never gets usage, so it adds 0 though
			// it is billed; estimate it with the cost display (4.6).
			for (const k of Object.keys(usage) as (keyof Usage)[]) {
				usage[k] += r.value.usage?.[k] ?? 0;
			}
		} catch (err) {
			if (text) yield { type: "message_done", text };
			if (!signal.aborted) {
				// The failed reply is dropped; earlier rounds stay in history.
				yield {
					type: "turn_finished",
					stopReason: "error",
					usage,
					error: (err as Error).message,
				};
				return;
			}
			// Partial items are dropped; the text the user already saw is kept.
			if (text) history.push({ role: "assistant", content: text });
			history.push(note);
			yield finish("interrupted");
			return;
		}
		if (text) yield { type: "message_done", text };
		history.push(...output);

		const calls = output.filter(
			(i): i is ResponseFunctionToolCall => i.type === "function_call",
		);
		if (calls.length === 0) {
			yield finish("done");
			return;
		}

		const interrupted = new Promise<"interrupted">((resolve) => {
			if (signal.aborted) resolve("interrupted");
			signal.addEventListener("abort", () => resolve("interrupted"), {
				once: true,
			});
		});
		const started = calls.map((call) => {
			// For the event only; callTool parses and checks it again.
			let input: unknown = call.arguments;
			try {
				input = JSON.parse(call.arguments);
			} catch {}
			return {
				call,
				input,
				// Raced, so a tool that ignores `signal` can't hold up an interrupt.
				result: Promise.race([
					callTool(
						registry,
						call.name,
						call.arguments,
						{ ...ctx, signal },
						permit,
						call.call_id,
					),
					interrupted.then(
						() => ({ status: "interrupted", output: INTERRUPTED }) as const,
					),
				]),
			};
		});
		for (const { call, input } of started) {
			yield {
				type: "tool_started",
				callId: call.call_id,
				name: call.name,
				input,
			};
		}
		// Events as each tool finishes; results go into history in call order.
		const waiting = new Map(
			started.map((s, i) => [i, s.result.then((r) => ({ i, r }))]),
		);
		while (waiting.size > 0) {
			const { i, r } = await Promise.race(waiting.values());
			waiting.delete(i);
			yield { type: "tool_finished", callId: started[i].call.call_id, ...r };
		}
		for (const { call, result } of started) {
			history.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: (await result).output,
			});
		}
		if (signal.aborted) {
			history.push(note);
			yield finish("interrupted");
			return;
		}
		for (const p of inject()) history.push(asItem(p));
	}
}
