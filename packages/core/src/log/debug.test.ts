import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	debugLog,
	disableDebugLog,
	enableDebugLog,
	setLogScrubber,
} from "./debug";

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

test("with the vault's scrubber hooked in, every known secret is redacted", () => {
	const dir = mkdtempSync(join(tmpdir(), "manas-log-"));
	enableDebugLog(dir);
	setLogScrubber((t) => t.replaceAll("hunter2-db-pass", "[REDACTED:env#1]"));
	debugLog({ kind: "error", error: "login failed with hunter2-db-pass" });
	setLogScrubber((t) => t);
	disableDebugLog();
	const [file] = readdirSync(dir);
	const text = readFileSync(join(dir, file), "utf8");
	expect(text).not.toContain("hunter2-db-pass");
	expect(text).toContain("[REDACTED:env#1]");
	rmSync(dir, { recursive: true });
});
