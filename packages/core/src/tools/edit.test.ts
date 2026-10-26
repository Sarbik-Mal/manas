import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { edit, findLoose } from "./edit";
import { read } from "./files";
import { readRecord } from "./reads";
import type { ToolCtx } from "./registry";

function project(files: Record<string, string | Uint8Array>) {
	const cwd = tempRoot();
	for (const [p, content] of Object.entries(files))
		writeFileSync(join(cwd, p), content);
	const ctx: ToolCtx = {
		signal: new AbortController().signal,
		cwd,
		denied: (p) => (p.endsWith("denied.ts") ? "Read(denied.ts)" : undefined),
		reads: readRecord(),
		vault: new Vault(),
	};
	const look = (file_path = "a.ts", offset: number | null = null) =>
		read.run({ file_path, offset, limit: null }, ctx);
	const file = (p = "a.ts") => readFileSync(join(cwd, p), "utf8");
	return { cwd, ctx, look, file };
}

const E = (
	old_string: string,
	new_string: string,
	more: Partial<Parameters<typeof edit.run>[0]> = {},
) => ({
	file_path: "a.ts",
	old_string,
	new_string,
	replace_all: null,
	...more,
});

// validate, then run: what callTool does around the approval.
async function apply(ctx: ToolCtx, input: ReturnType<typeof E>) {
	const refused = await edit.validate?.(input, ctx);
	if (refused) return `refused: ${refused}`;
	return edit.run(input, ctx);
}

test("the 2.2 check: an edit to an unread file is refused", async () => {
	const { ctx, file } = project({ "a.ts": "let a = 1;\n" });
	expect(await apply(ctx, E("a = 1", "a = 2"))).toBe(
		"refused: File has not been read yet. Read it first before writing to it.",
	);
	expect(file()).toBe("let a = 1;\n");
});

test("exact match, duplicates, replace_all; the record follows the edit", async () => {
	const { ctx, look, file, cwd } = project({
		"a.ts": "x = 1;\nx = 1;\ny = 2;\n",
	});
	await look();
	expect(await apply(ctx, E("x = 1;", "x = 3;"))).toStartWith(
		"refused: Found 2 matches",
	);
	const input = E("y = 2;", "y = 4;");
	expect(await edit.validate?.(input, ctx)).toBeUndefined();
	expect(edit.preview?.(input)).toBe(
		"line 1:\n  x = 1;\n  x = 1;\n- y = 2;\n+ y = 4;",
	);
	expect(await edit.run(input, ctx)).toBe(
		"The file a.ts has been updated successfully. (file state is current in your context; no need to read it back)",
	);
	expect(
		await apply(ctx, E("x = 1;", "x = 3;", { replace_all: true })),
	).toStartWith(
		"The file a.ts has been updated. All occurrences were successfully replaced.",
	);
	expect(file()).toBe("x = 3;\nx = 3;\ny = 4;\n");
	expect(ctx.reads.get(join(cwd, "a.ts"))).toMatchObject({ edited: true });
	// An edited file is read in full again, never as the "unchanged" stub.
	expect(await look()).toContain("x = 3;");
});

test("loose matches: blank lines, trailing spaces and curly quotes", async () => {
	const { ctx, look, file } = project({
		"a.ts": "a();  \n\n\nb();\nsay(“hi”);\nsay(“hi”);\n",
	});
	await look();
	// Two blank lines in the file, one in old_string; a run counts as one.
	expect(await apply(ctx, E("a();\n\nb();", "c();"))).toContain(
		"Matched loosely",
	);
	expect(file()).toBe("c();\nsay(“hi”);\nsay(“hi”);\n");
	// Folded, it matches twice: refused rather than guessed.
	expect(await apply(ctx, E('say("hi");', 'say("yo");'))).toContain(
		"matches 2 places",
	);
	expect(await apply(ctx, E('say("hi");\nsay("hi");', 'say("yo");'))).toContain(
		"Matched loosely",
	);
	// new_string goes in as sent.
	expect(file()).toBe('c();\nsay("yo");\n');
	expect(await apply(ctx, E("nope", "x"))).toBe(
		"refused: String to replace not found in file.\nString: nope",
	);
});

test("findLoose: whole lines only, a trailing newline is replaced too", () => {
	expect(findLoose("a\n\n\nb\nc", "a\n\nb\n")).toEqual({ start: 0, end: 6 });
	expect(findLoose("a\n\nb", "a\nb")).toBe("none"); // a blank line still counts
	expect(findLoose("ab\nc", "b")).toBe("none");
	expect(findLoose("a\na", "a")).toBe("many");
});

test("stale: an exact unique match applies with a note; anything else asks for a read", async () => {
	const { ctx, look, file, cwd } = project({ "a.ts": "one\ntwo\n" });
	await look();
	writeFileSync(join(cwd, "a.ts"), "one\ntwo\nthree  \n\nfour\n");
	expect(await apply(ctx, E("three\nfour", "x"))).toBe(
		"refused: File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
	);
	expect(await apply(ctx, E("two", "2"))).toContain(
		"The file contains other changes not in your context",
	);
	expect(file()).toBe("one\n2\nthree  \n\nfour\n");
});

test("placeholders become the real secret in the file; unknown ones are refused", async () => {
	const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
	const { ctx, look, file } = project({ "a.ts": `key = "${secret}";\n` });
	const p = ctx.vault.placeholder("api_key", secret);
	await look();
	expect(await apply(ctx, E(`key = "${p}";`, `apiKey = "${p}";`))).toContain(
		"updated successfully",
	);
	expect(file()).toBe(`apiKey = "${secret}";\n`);
	expect(await apply(ctx, E("apiKey", "[REDACTED:token#9]"))).toBe(
		"refused: [REDACTED:token#9] isn't a placeholder this session knows; read the file again to get a current one.",
	);
});

test("refused before any prompt: partial reads, encodings, notebooks, empty or same strings", async () => {
	const wide = Array.from({ length: 60 }, () => "y".repeat(2000)).join("\n");
	const { ctx, look } = project({
		"a.ts": "a\n",
		"crlf.ts": "a\r\nb\r\n",
		"bom.ts": "﻿a\n",
		"u16.ts": new Uint8Array([0xff, 0xfe, 0x61, 0]),
		"bad.ts": new Uint8Array([0x61, 0xff, 0x62]),
		"n.ipynb": "{}",
		"denied.ts": "a\n",
		"wide.ts": wide,
	});
	for (const f of ["a.ts", "crlf.ts", "bom.ts", "u16.ts", "wide.ts"])
		await look(f);
	const on = (file_path: string) => apply(ctx, E("a", "b", { file_path }));
	expect(await on("crlf.ts")).toContain("CRLF");
	expect(await on("bom.ts")).toContain("byte-order mark");
	expect(await on("u16.ts")).toContain("UTF-16");
	expect(await on("bad.ts")).toContain("isn't valid UTF-8");
	expect(await on("n.ipynb")).toContain("Jupyter notebook");
	expect(await on("denied.ts")).toContain("Read deny rule");
	expect(await on("nope.ts")).toContain("File does not exist");
	expect(await apply(ctx, E("y", "z", { file_path: "wide.ts" }))).toContain(
		"PARTIAL view",
	);
	expect(await apply(ctx, E("", "b"))).toContain("old_string is empty");
	expect(await apply(ctx, E("a", "a"))).toContain("No changes to make");
});

test("a file changed while waiting for approval is not written", async () => {
	const { ctx, look, file, cwd } = project({ "a.ts": "a\n" });
	await look();
	const input = E("a", "b");
	expect(await edit.validate?.(input, ctx)).toBeUndefined();
	writeFileSync(join(cwd, "a.ts"), "a\nmore\n");
	await expect(edit.run(input, ctx)).rejects.toThrow(
		"changed while waiting for approval",
	);
	expect(file()).toBe("a\nmore\n");
});
