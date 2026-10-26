import { afterAll, beforeEach, expect, test } from "bun:test";
import type { ResponseOutputMessage } from "openai/resources/responses/responses";
import { lastRateLimits, streamResponse } from "./openai";

// A fake OpenAI: each test sets how many 429s to send before a real stream,
// and whether the stream then stays open (`hold`) instead of finishing.
let fails = 0;
let hold = false;
let requests = 0;
let lastBody: Record<string, unknown> | undefined;
const item: ResponseOutputMessage = {
	type: "message",
	id: "msg_1",
	status: "completed",
	role: "assistant",
	content: [],
};
const sse = (e: object) => `data: ${JSON.stringify(e)}\n\n`;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		requests++;
		lastBody = await req.json();
		if (requests <= fails) {
			return Response.json(
				{ error: { message: "slow down", type: "rate_limit" } },
				{ status: 429, headers: { "retry-after-ms": "10" } },
			);
		}
		const body = new ReadableStream({
			start(c) {
				c.enqueue(sse({ type: "response.output_text.delta", delta: "hello" }));
				if (hold) return;
				c.enqueue(sse({ type: "response.output_item.done", item }));
				c.enqueue(
					sse({
						type: "response.output_item.done",
						item: { type: "web_search_call" },
					}),
				);
				c.close();
			},
		});
		return new Response(body, {
			headers: {
				"content-type": "text/event-stream",
				"x-ratelimit-remaining-tokens": "1999",
			},
		});
	},
});
process.env.OPENAI_BASE_URL = `http://localhost:${server.port}/v1`;
process.env.OPENAI_API_KEY = "test-key";
afterAll(() => server.stop());
beforeEach(() => {
	requests = 0;
	fails = 0;
	hold = false;
	lastBody = undefined;
});

const collect = async (opts?: Parameters<typeof streamResponse>[1]) => {
	const reply = streamResponse([{ role: "user", content: "hi" }], opts);
	let text = "";
	let r = await reply.next();
	for (; !r.done; r = await reply.next()) text += r.value;
	return { text, output: r.value.output };
};

test("429s are retried, then the stream comes through", async () => {
	fails = 2;
	expect((await collect()).text).toBe("hello");
	expect(requests).toBe(3);
	expect(lastRateLimits?.remainingTokens).toBe("1999");
});

test("gives up after 5 retries", async () => {
	fails = Number.POSITIVE_INFINITY;
	await expect(collect()).rejects.toThrow("429");
	expect(requests).toBe(6);
});

test("effort and encrypted reasoning are sent to a reasoning model", async () => {
	await collect({ effort: "high" });
	expect(lastBody?.reasoning).toEqual({ effort: "high" });
	expect(lastBody?.include).toEqual(["reasoning.encrypted_content"]);
});

test("effort and include are dropped for a model without reasoning", async () => {
	await collect({ model: "gpt-4o-mini", effort: "high" });
	expect(lastBody?.model).toBe("gpt-4o-mini");
	expect(lastBody).not.toHaveProperty("reasoning");
	expect(lastBody).not.toHaveProperty("include");
});

test("unsupported effort and unknown model fail before any request", async () => {
	await expect(collect({ effort: "minimal" })).rejects.toThrow(
		'effort "minimal" not supported',
	);
	await expect(collect({ model: "nope" })).rejects.toThrow(
		'unknown model "nope"',
	);
	expect(requests).toBe(0);
});

test("tools are sent strict, and only when there are any", async () => {
	await collect();
	expect(lastBody).not.toHaveProperty("tools");
	const parameters = { type: "object", properties: {}, required: [] };
	await collect({ tools: [{ name: "echo", description: "d", parameters }] });
	expect(lastBody?.tools).toEqual([
		{
			type: "function",
			strict: true,
			name: "echo",
			description: "d",
			parameters,
		},
	]);
});

test("finished output items are returned, unknown kinds dropped", async () => {
	expect((await collect()).output).toEqual([item]);
});

test("an abort mid-stream stops it without a retry", async () => {
	hold = true;
	const ac = new AbortController();
	const reply = streamResponse([{ role: "user", content: "hi" }], {
		signal: ac.signal,
	});
	expect((await reply.next()).value).toBe("hello");
	ac.abort();
	await expect(reply.next()).rejects.toThrow();
	expect(requests).toBe(1);
});
