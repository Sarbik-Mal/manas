import { afterAll, expect, test } from "bun:test";
import { lastRateLimits, streamText } from "./openai";

// A fake OpenAI: each test sets how many 429s to send before a real stream.
let fails = 0;
let requests = 0;
const server = Bun.serve({
	port: 0,
	fetch() {
		requests++;
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

const collect = async () => {
	let text = "";
	for await (const t of streamText("hi")) text += t;
	return text;
};

test("429s are retried, then the stream comes through", async () => {
	requests = 0;
	fails = 2;
	expect(await collect()).toBe("hello");
	expect(requests).toBe(3);
	expect(lastRateLimits?.remainingTokens).toBe("1999");
});

test("gives up after 5 retries", async () => {
	requests = 0;
	fails = Number.POSITIVE_INFINITY;
	await expect(collect()).rejects.toThrow("429");
	expect(requests).toBe(6);
});
