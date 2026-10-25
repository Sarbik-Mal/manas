import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import { debugLog } from "../log/debug";
import { installId } from "../storage/install-id";
import { capability } from "./models";

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

// Streams the reply text for one prompt. An effort the model can't take at all
// (no reasoning) is dropped, so one setting works across models.
export async function* streamText(
	input: string,
	{ model = "gpt-5.6-luna", effort }: { model?: string; effort?: string } = {},
): AsyncGenerator<string> {
	const { efforts } = capability(model);
	if (effort && efforts.length > 0 && !efforts.includes(effort)) {
		throw new Error(
			`effort "${effort}" not supported by ${model}: ${efforts.join(", ")}`,
		);
	}
	if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
	const client = new OpenAI({
		maxRetries: MAX_RETRIES,
		timeout: TIMEOUT_MS,
		logLevel: "info",
		logger: sdkLogger,
	});

	const start = performance.now();
	const since = () => Math.round(performance.now() - start);
	const entry: Record<string, unknown> = { kind: "request", model, effort };
	try {
		const { data: stream, response } = await client.responses
			.create({
				model,
				input,
				stream: true,
				store: false,
				prompt_cache_key: installId(),
				reasoning:
					effort && efforts.length > 0
						? { effort: effort as ReasoningEffort }
						: undefined,
			})
			.withResponse();
		lastRateLimits = entry.rateLimits = readRateLimits(response.headers);
		for await (const event of stream) {
			if (event.type === "response.output_text.delta") {
				entry.firstTokenMs ??= since();
				yield event.delta;
			} else if (event.type === "response.completed") {
				const u = event.response.usage;
				entry.usage = u && {
					input: u.input_tokens,
					cached: u.input_tokens_details.cached_tokens,
					output: u.output_tokens,
					reasoning: u.output_tokens_details.reasoning_tokens,
				};
			}
		}
		entry.status = "ok";
	} catch (err) {
		entry.status = "error";
		entry.error = (err as Error).message;
		throw err;
	} finally {
		entry.ms = since();
		debugLog(entry);
	}
}

// SDK messages (info: retries, failed connections) go to the debug log.
const toLog = (level: string) => (message: string) =>
	debugLog({ kind: "sdk", level, message });
const sdkLogger = {
	error: toLog("error"),
	warn: toLog("warn"),
	info: toLog("info"),
	debug: toLog("debug"),
};
