import { afterAll, beforeEach, expect, test } from "bun:test";
import { lastRateLimits, streamText } from "./openai";

// A fake OpenAI: each test sets how many 429s to send before a real stream.
let fails = 0;
let requests = 0;
let lastBody: Record<string, unknown> | undefined;
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
		const event = { type: "response.output_text.delta", delta: "hello" };
		return new Response(`data: ${JSON.stringify(event)}\n\n`, {
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
	lastBody = undefined;
});

const collect = async (opts?: Parameters<typeof streamText>[1]) => {
	let text = "";
	for await (const t of streamText("hi", opts)) text += t;
	return text;
};

test("429s are retried, then the stream comes through", async () => {
	fails = 2;
	expect(await collect()).toBe("hello");
	expect(requests).toBe(3);
	expect(lastRateLimits?.remainingTokens).toBe("1999");
});

test("gives up after 5 retries", async () => {
	fails = Number.POSITIVE_INFINITY;
	await expect(collect()).rejects.toThrow("429");
	expect(requests).toBe(6);
});

test("effort is sent to a reasoning model", async () => {
	await collect({ effort: "high" });
	expect(lastBody?.reasoning).toEqual({ effort: "high" });
});

test("effort is dropped for a model without reasoning", async () => {
	await collect({ model: "gpt-4o-mini", effort: "high" });
	expect(lastBody?.model).toBe("gpt-4o-mini");
	expect(lastBody).not.toHaveProperty("reasoning");
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
