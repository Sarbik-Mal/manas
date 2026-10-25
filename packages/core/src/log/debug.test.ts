import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLog, disableDebugLog, enableDebugLog } from "./debug";

test("log lines never contain the key or sk- strings", () => {
	const dir = mkdtempSync(join(tmpdir(), "manas-log-"));
	const envKey = "env-key-value-1234567890";
	const saved = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = envKey;
	try {
		enableDebugLog(dir);
		debugLog({
			kind: "request",
			error: `401 bad key ${envKey}`,
			other: "sk-proj-abcdefghijklmnopqrstuvwxyz",
		});
		const [name] = readdirSync(dir);
		const text = readFileSync(join(dir, name), "utf8");
		expect(text.trim().split("\n")).toHaveLength(1);
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain(envKey);
		expect(text).not.toContain("sk-proj-abc");
	} finally {
		disableDebugLog();
		process.env.OPENAI_API_KEY = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});
