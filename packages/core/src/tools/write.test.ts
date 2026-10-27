import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { NO_BACKUPS } from "./backups";
import { read } from "./files";
import { readRecord } from "./reads";
import type { ToolCtx } from "./registry";
import { write } from "./write";

function project(files: Record<string, string | Uint8Array>) {
	const cwd = tempRoot();
	for (const [p, content] of Object.entries(files))
		writeFileSync(join(cwd, p), content);
	const ctx: ToolCtx = {
		signal: new AbortController().signal,
		cwd,
		shell: { cwd },
		denied: (p) => (p.endsWith("denied.ts") ? "Read(denied.ts)" : undefined),
		reads: readRecord(),
		vault: new Vault(),
		backups: NO_BACKUPS,
	};
	const look = (file_path = "a.ts") =>
		read.run({ file_path, offset: null, limit: null }, ctx);
	const file = (p = "a.ts") => readFileSync(join(cwd, p), "utf8");
	return { cwd, ctx, look, file };
}

// validate, then run: what callTool does around the approval.
async function apply(ctx: ToolCtx, file_path: string, content: string) {
	const input = { file_path, content };
	const refused = await write.validate?.(input, ctx);
	if (refused) return `refused: ${refused}`;
	return write.run(input, ctx);
}

test("the 2.3 check: overwrite without a read is refused", async () => {
	const { ctx, file } = project({ "a.ts": "old\n" });
	expect(await apply(ctx, "a.ts", "new\n")).toBe(
		"refused: File has not been read yet. Read it first before writing to it.",
	);
	expect(file()).toBe("old\n");
});

test("a new file, in new folders; it then counts as fully read", async () => {
	const { ctx, look, file } = project({});
	const input = { file_path: "src/util/greet.ts", content: "export {};\n" };
	expect(await write.validate?.(input, ctx)).toBeUndefined();
	expect(write.preview?.(input)).toBe("line 1:\n+ export {};");
	expect(await write.run(input, ctx)).toBe(
		"File created successfully at: src/util/greet.ts (file state is current in your context; no need to read it back)",
	);
	expect(file("src/util/greet.ts")).toBe("export {};\n");
	expect(await look("src/util/greet.ts")).toStartWith("File unchanged");
});

test("overwrite after a read; a change since the read is refused", async () => {
	const { ctx, look, file, cwd } = project({ "a.ts": "one\ntwo\n" });
	await look();
	expect(await apply(ctx, "a.ts", "one\n2\n")).toStartWith(
		"The file a.ts has been updated successfully.",
	);
	expect(file()).toBe("one\n2\n");
	writeFileSync(join(cwd, "a.ts"), "changed by you\n");
	expect(await apply(ctx, "a.ts", "x\n")).toBe(
		"refused: File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
	);
	expect(file()).toBe("changed by you\n");
});

test("placeholders become real values; unknown ones are refused", async () => {
	const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
	const { ctx, file } = project({});
	const p = ctx.vault.placeholder("api_key", secret);
	await apply(ctx, "key.ts", `key = "${p}";\n`);
	expect(file("key.ts")).toBe(`key = "${secret}";\n`);
	expect(await apply(ctx, "b.ts", "[REDACTED:token#9]")).toContain(
		"isn't a placeholder this session knows",
	);
	expect(existsSync(join(ctx.cwd, "b.ts"))).toBe(false);
});

test("refused: encodings, notebooks, denied files, folders, PARTIAL views", async () => {
	const wide = Array.from({ length: 60 }, () => "y".repeat(2000)).join("\n");
	const { ctx, look } = project({
		"cp1252.ts": new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
		"n.ipynb": "{}",
		"wide.ts": wide,
	});
	await look("wide.ts");
	expect(await apply(ctx, "cp1252.ts", "b")).toContain("such as Windows-1252");
	expect(await apply(ctx, "n.ipynb", "{}")).toContain("Jupyter notebook");
	expect(await apply(ctx, "denied.ts", "b")).toContain("cannot be written");
	expect(await apply(ctx, ".", "b")).toContain("is a folder");
	expect(await apply(ctx, "wide.ts", "b")).toContain("PARTIAL view");
});

test("a file changed or created while waiting for approval is not written", async () => {
	const { ctx, look, file, cwd } = project({ "a.ts": "a\n" });
	await look();
	const over = { file_path: "a.ts", content: "b\n" };
	expect(await write.validate?.(over, ctx)).toBeUndefined();
	writeFileSync(join(cwd, "a.ts"), "a\nmore\n");
	await expect(write.run(over, ctx)).rejects.toThrow("changed while waiting");
	expect(file()).toBe("a\nmore\n");

	const fresh = { file_path: "new.ts", content: "mine\n" };
	expect(await write.validate?.(fresh, ctx)).toBeUndefined();
	writeFileSync(join(cwd, "new.ts"), "yours\n");
	await expect(write.run(fresh, ctx)).rejects.toThrow("changed while waiting");
	expect(file("new.ts")).toBe("yours\n");
});
