import type {
	ResponseFunctionToolCall,
	ResponseInputItem,
} from "openai/resources/responses/responses";
import { streamResponse, type ToolSpec } from "../provider/openai";

// Minimal tool shape until the registry (1.2) owns it.
export type Tool = ToolSpec & {
	run(input: unknown, ctx: { signal: AbortSignal }): Promise<string>;
};

export type LoopEvent =
	| { type: "text"; delta: string }
	| { type: "tool_started"; callId: string; name: string; input: unknown }
	| {
			type: "tool_finished";
			callId: string;
			status: "ok" | "error" | "interrupted";
			output: string;
	  }
	| { type: "turn_finished"; stopReason: "done" | "interrupted" };

const INTERRUPTED = "interrupted by user";
const note: ResponseInputItem = {
	role: "developer",
	content: `[${INTERRUPTED}]`,
};

// One user prompt: model → tool calls → results → model, until the model stops
// calling tools or `signal` aborts. `history` is only ever appended to, so the
// prompt cache prefix never changes.
export async function* runTurn(
	history: ResponseInputItem[],
	prompt: string,
	{
		tools = [],
		signal = new AbortController().signal,
		...opts
	}: {
		model?: string;
		effort?: string;
		tools?: Tool[];
		signal?: AbortSignal;
	} = {},
): AsyncGenerator<LoopEvent> {
	history.push({ role: "user", content: prompt });
	const specs = tools.map(({ name, description, parameters }) => ({
		name,
		description,
		parameters,
	}));
	while (true) {
		let text = "";
		let output: ResponseInputItem[];
		try {
			const reply = streamResponse(history, { ...opts, tools: specs, signal });
			let r = await reply.next();
			for (; !r.done; r = await reply.next()) {
				text += r.value;
				yield { type: "text", delta: r.value };
			}
			output = r.value.output;
		} catch (err) {
			if (!signal.aborted) throw err;
			// Partial items are dropped; the text the user already saw is kept.
			if (text) history.push({ role: "assistant", content: text });
			history.push(note);
			yield { type: "turn_finished", stopReason: "interrupted" };
			return;
		}
		history.push(...output);

		const calls = output.filter(
			(i): i is ResponseFunctionToolCall => i.type === "function_call",
		);
		if (calls.length === 0) {
			yield { type: "turn_finished", stopReason: "done" };
			return;
		}

		const interrupted = new Promise<"interrupted">((resolve) => {
			if (signal.aborted) resolve("interrupted");
			signal.addEventListener("abort", () => resolve("interrupted"), {
				once: true,
			});
		});
		const started = calls.map((call) => {
			let input: unknown = call.arguments;
			let valid = true;
			try {
				input = JSON.parse(call.arguments);
			} catch {
				valid = false;
			}
			return {
				call,
				input,
				// Raced, so a tool that ignores `signal` can't hold up an interrupt.
				result: Promise.race([
					valid
						? runTool(tools, call, input, signal)
						: ({
								status: "error",
								output: "error: arguments are not valid JSON",
							} as const),
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
		// ponytail: finished events come in call order, so a fast tool waits for a
		// slow one before it; yield in completion order if the UI needs it.
		for (const { call, result } of started) {
			const r = await result;
			history.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: r.output,
			});
			yield { type: "tool_finished", callId: call.call_id, ...r };
		}
		if (signal.aborted) {
			history.push(note);
			yield { type: "turn_finished", stopReason: "interrupted" };
			return;
		}
	}
}

async function runTool(
	tools: Tool[],
	call: ResponseFunctionToolCall,
	input: unknown,
	signal: AbortSignal,
): Promise<{ status: "ok" | "error"; output: string }> {
	const tool = tools.find((t) => t.name === call.name);
	if (!tool)
		return { status: "error", output: `error: unknown tool "${call.name}"` };
	try {
		return { status: "ok", output: await tool.run(input, { signal }) };
	} catch (err) {
		return { status: "error", output: `error: ${(err as Error).message}` };
	}
}
