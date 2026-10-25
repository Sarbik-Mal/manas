import OpenAI from "openai";
import { installId } from "../storage/install-id";

// The SDK already retries 408/409/429/5xx and connection errors, honoring
// retry-after(-ms), else exponential backoff with jitter.
const MAX_RETRIES = 5;
// Time until response headers; a stream starts within seconds.
const TIMEOUT_MS = 60_000;

export type RateLimits = ReturnType<typeof readRateLimits>;
export let lastRateLimits: RateLimits | undefined;

export function readRateLimits(headers: Headers) {
	const h = (name: string) => headers.get(`x-ratelimit-${name}`);
	return {
		limitRequests: h("limit-requests"),
		limitTokens: h("limit-tokens"),
		remainingRequests: h("remaining-requests"),
		remainingTokens: h("remaining-tokens"),
		resetRequests: h("reset-requests"),
		resetTokens: h("reset-tokens"),
	};
}

// Streams the reply text for one prompt.
export async function* streamText(input: string): AsyncGenerator<string> {
	if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
	const client = new OpenAI({ maxRetries: MAX_RETRIES, timeout: TIMEOUT_MS });
	const { data: stream, response } = await client.responses
		.create({
			model: "gpt-5.6-luna",
			input,
			stream: true,
			store: false,
			prompt_cache_key: installId(),
		})
		.withResponse();
	lastRateLimits = readRateLimits(response.headers);
	for await (const event of stream) {
		if (event.type === "response.output_text.delta") yield event.delta;
	}
}
