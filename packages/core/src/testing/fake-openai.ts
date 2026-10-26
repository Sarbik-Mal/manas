// A scripted fake OpenAI Responses API for tests. Each request takes the next
// reply from `replies`: output items to send, optional text deltas first.
// `hold` sends the text and keeps the stream open; `status` fails the request.
import type { ResponseInputItem } from "openai/resources/responses/responses";

export type Reply = {
	items?: object[];
	text?: string;
	hold?: boolean;
	status?: number;
	usage?: { input: number; cached: number; output: number; reasoning: number };
};

export function fakeOpenAI() {
	const replies: Reply[] = [];
	const bodies: ({ input: ResponseInputItem[] } & Record<string, unknown>)[] =
		[];
	const sse = (e: object) => `data: ${JSON.stringify(e)}\n\n`;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			bodies.push(await req.json());
			const { items = [], text, hold, status, usage } = replies.shift() ?? {};
			if (status) {
				return Response.json(
					{
						error: { message: `fake ${status}`, type: "invalid_request_error" },
					},
					{ status },
				);
			}
			const body = new ReadableStream({
				start(c) {
					if (text) {
						c.enqueue(sse({ type: "response.output_text.delta", delta: text }));
					}
					if (hold) return;
					for (const item of items) {
						c.enqueue(sse({ type: "response.output_item.done", item }));
					}
					if (usage) {
						c.enqueue(
							sse({
								type: "response.completed",
								response: {
									usage: {
										input_tokens: usage.input,
										input_tokens_details: { cached_tokens: usage.cached },
										output_tokens: usage.output,
										output_tokens_details: {
											reasoning_tokens: usage.reasoning,
										},
									},
								},
							}),
						);
					}
					c.close();
				},
			});
			return new Response(body, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const url = `http://localhost:${server.port}/v1`;
	process.env.OPENAI_BASE_URL = url;
	process.env.OPENAI_API_KEY = "test-key";
	return {
		replies,
		bodies,
		url,
		stop: () => server.stop(true),
		reset() {
			replies.length = 0;
			bodies.length = 0;
		},
	};
}

export const message = (text: string) => ({
	type: "message",
	id: "msg_1",
	status: "completed",
	role: "assistant",
	content: [{ type: "output_text", text, annotations: [] }],
});
export const say = (text: string): Reply => ({ text, items: [message(text)] });
let n = 0;
export const call = (name: string, args: unknown) => ({
	type: "function_call",
	id: `fc_${++n}`,
	call_id: `call_${n}`,
	name,
	arguments: typeof args === "string" ? args : JSON.stringify(args),
	status: "completed",
});

// A protocol line as a test client reads it: any field, no narrowing.
// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary protocol lines
export type Msg = Record<string, any>;
