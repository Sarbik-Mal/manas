import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { spill } from "./spill";

const KEY = `sk-proj-${"Q1w2E3r4T5y6U7i8O9p0".repeat(2)}`;
const lines = (n: number) =>
	Array.from({ length: n }, (_, i) => `line ${i + 1} of a long build log`).join(
		"\n",
	);
const saved = (out: string) =>
	readFileSync(/saved to: (.+\.txt)/.exec(out)?.[1] ?? "", "utf8");

test("the 3.4 check: a huge log becomes a file plus a preview (Claude Code's text)", () => {
	const dir = join(tempRoot(), "tool-results");
	const log = lines(5000);
	const out = spill(log, {
		dir,
		id: "call_1",
		vault: new Vault(),
		max: 30_000,
	});
	expect(out).toStartWith(
		`<persisted-output>\nOutput too large (${(log.length / 1024).toFixed(1)}KB). Full output saved to: ${join(dir, "call_1.txt")}\n\nPreview (first 2KB):\nline 1 of a long build log\n`,
	);
	expect(out).toEndWith("\n...\n</persisted-output>");
	// Cut at a line end, never mid-line.
	const preview = out.split("Preview (first 2KB):\n")[1].split("\n...\n")[0];
	expect(preview.length).toBeLessThanOrEqual(2000);
	expect(log.startsWith(`${preview}\n`)).toBe(true);
	expect(saved(out)).toBe(log);
});

test("short output is untouched; the file is scrubbed and capped", () => {
	const dir = join(tempRoot(), "r");
	const vault = new Vault();
	expect(spill("short", { dir, id: "a", vault, max: 10 })).toBe("short");
	const out = spill(`${KEY}\n${"x".repeat(500)}`, {
		dir,
		id: "fc/1:2",
		vault,
		max: 100,
		cap: 300,
	});
	expect(out).toContain(
		`Output exceeded the 300 bytes persist limit; only the first 300 bytes were saved to: ${join(dir, "fc-1-2.txt")}`,
	);
	const file = saved(out);
	expect(file).toHaveLength(300);
	expect(file).not.toContain(KEY);
	expect(out).not.toContain(KEY);
});

test("a file that can't be written: Claude's truncated-output text", () => {
	const blocker = join(tempRoot(), "not-a-folder");
	writeFileSync(blocker, "");
	const out = spill(lines(100), {
		dir: blocker,
		id: "x",
		vault: new Vault(),
		max: 200,
	});
	expect(out).toStartWith("<truncated-output>\nOutput too large (");
	expect(out).toContain(
		"It could not be saved, so only the first 188 bytes are shown; the rest was dropped.",
	);
	expect(out).toEndWith("line 7 of a long build log\n</truncated-output>");
});
