import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import type {
	FunctionTool,
	ResponseInputItem,
} from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";
import { debugLog } from "../log/debug";
import { envValues } from "../safety/env-preload";
import { installId } from "../storage/install-id";
import { checkEffort } from "./models";

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

export type ToolSpec = Pick<FunctionTool, "name" | "description"> & {
	parameters: Record<string, unknown>;
};
export type Usage = {
	input: number;
	cached: number;
	output: number;
	reasoning: number;
};

export const keyFile = (home = homedir()) => join(home, ".manas", ".env");

// The key: the environment first, else ~/.manas/.env. Read per request and
// never put in process.env, so it can't reach a child process; the exe is
// built without .env autoload, so a project's .env is never used.
// ponytail: a plain-text file, developer mode only; `manas login --key`
// (Credential Manager, cli.md) replaces it.
export function apiKey(home = homedir()) {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	let text: string;
	try {
		text = readFileSync(keyFile(home), "utf8");
	} catch {
		return undefined;
	}
	const m = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)$/m.exec(text);
	return m ? envValues(m[0])[0] : undefined;
}

// Output item kinds we send back next round; the rest are tools we never offer.
const KEPT = new Set(["message", "reasoning", "function_call"]);

// Streams one model reply: yields text as it arrives, returns the finished
// output items. An effort the model can't take at all (no reasoning) is
// dropped, so one setting works across models.
export async function* streamResponse(
	input: ResponseInputItem[],
	{
		model = "gpt-5.6-luna",
		effort,
		tools = [],
		signal,
	}: {
		model?: string;
		effort?: string;
		tools?: ToolSpec[];
		signal?: AbortSignal;
	} = {},
): AsyncGenerator<string, { output: ResponseInputItem[]; usage?: Usage }> {
	const efforts = checkEffort(model, effort);
	const key = apiKey();
	if (!key) {
		throw new Error(`OPENAI_API_KEY is not set (put it in ${keyFile()})`);
	}
	const client = new OpenAI({
		apiKey: key,
		maxRetries: MAX_RETRIES,
		timeout: TIMEOUT_MS,
		logLevel: "info",
		logger: sdkLogger,
	});
	const reasoning = efforts.length > 0;

	const start = performance.now();
	const since = () => Math.round(performance.now() - start);
	const entry: Record<string, unknown> = { kind: "request", model, effort };
	const output: ResponseInputItem[] = [];
	let usage: Usage | undefined;
	try {
		const { data: stream, response } = await client.responses
			.create(
				{
					model,
					input,
					stream: true,
					store: false,
					prompt_cache_key: installId(),
					reasoning:
						effort && reasoning
							? { effort: effort as ReasoningEffort }
							: undefined,
					// store: false, so we carry reasoning across rounds ourselves.
					include: reasoning ? ["reasoning.encrypted_content"] : undefined,
					tools:
						tools.length > 0
							? tools.map((t) => ({ type: "function", strict: true, ...t }))
							: undefined,
				},
				{ signal },
			)
			.withResponse();
		lastRateLimits = entry.rateLimits = readRateLimits(response.headers);
		for await (const event of stream) {
			if (event.type === "response.output_text.delta") {
				entry.firstTokenMs ??= since();
				yield event.delta;
			} else if (event.type === "response.output_item.done") {
				if (KEPT.has(event.item.type))
					output.push(event.item as ResponseInputItem);
			} else if (event.type === "response.completed") {
				const u = event.response.usage;
				entry.usage = usage = u && {
					input: u.input_tokens,
					cached: u.input_tokens_details.cached_tokens,
					output: u.output_tokens,
					reasoning: u.output_tokens_details.reasoning_tokens,
				};
			}
		}
		// The SDK ends the stream quietly on abort; make it an error.
		signal?.throwIfAborted();
		entry.status = "ok";
		return { output, usage };
	} catch (err) {
		entry.status = signal?.aborted ? "interrupted" : "error";
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
