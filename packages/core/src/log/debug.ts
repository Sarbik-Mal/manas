import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Developer log (--debug): metadata only, one JSON object per line.
let file: string | undefined;

export function enableDebugLog(dir = join(homedir(), ".manas", "logs")) {
	mkdirSync(dir, { recursive: true });
	// "sv" locale formats the local date as YYYY-MM-DD.
	file = join(dir, `debug-${new Date().toLocaleDateString("sv")}.jsonl`);
}

export function disableDebugLog() {
	file = undefined;
}

export function debugLog(entry: Record<string, unknown>) {
	if (!file) return;
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
	try {
		appendFileSync(file, `${redact(line)}\n`);
	} catch {
		// A broken debug log must never break a request.
	}
}

// ponytail: env key + sk- pattern only; the vault (1.8) replaces this.
export function redact(text: string) {
	const key = process.env.OPENAI_API_KEY;
	if (key) text = text.replaceAll(key, "[REDACTED]");
	return text.replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
}
