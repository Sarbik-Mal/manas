import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deniedPath } from "../permissions/engine";
import { tempRoot } from "../testing/fake-openai";
import { glob, grep, read } from "./files";
import { readRecord } from "./reads";
import type { ToolCtx } from "./registry";

function project(
	files: Record<string, string | Uint8Array>,
	deny: string[] = [],
) {
	const cwd = tempRoot();
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), content);
	}
	const rules = {
		allow: [],
		ask: [],
		deny: deny.map((text) => ({ text, base: cwd })),
	};
	const ctx: ToolCtx = {
		signal: new AbortController().signal,
		cwd,
		denied: (p) => deniedPath(p, rules, cwd),
		reads: readRecord(),
	};
	return { cwd, ctx };
}

const R = (i: Partial<Parameters<typeof read.run>[0]>) => ({
	file_path: "a.txt",
	offset: null,
	limit: null,
	...i,
});
const G = (i: Partial<Parameters<typeof grep.run>[0]>) => ({
	pattern: "x",
	path: null,
	glob: null,
	type: null,
	output_mode: null,
	"-A": null,
	"-B": null,
	"-C": null,
	context: null,
	"-i": null,
	"-n": null,
	"-o": null,
	head_limit: null,
	offset: null,
	multiline: null,
	...i,
});
const lines = (n: number) =>
	Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("read: numbered lines, offset and limit, the 2,000-line default", async () => {
	const { ctx, cwd } = project({
		"a.txt": "one\r\ntwo\nthree\n",
		"big.txt": lines(2500),
	});
	expect(await read.run(R({}), ctx)).toBe(
		"     1\tone\n     2\ttwo\n     3\tthree",
	);
	expect(await read.run(R({ offset: 2, limit: 1 }), ctx)).toBe(
		"     2\ttwo\n\n(Showing lines 2-2 of 3.)",
	);
	// Absolute paths work too.
	expect(
		await read.run(R({ file_path: join(cwd, "a.txt"), limit: 1 }), ctx),
	).toContain("     1\tone");
	const big = await read.run(R({ file_path: "big.txt" }), ctx);
	expect(big).toContain("  2000\tline 2000\n\n(Showing lines 1-2000 of 2500.)");
	expect(big).not.toContain("line 2001");
});

test("read: size and token limits", async () => {
	const huge = "x".repeat(300 * 1024);
	const wide = Array.from({ length: 60 }, () => "y".repeat(2000)).join("\n");
	const { ctx } = project({ "huge.txt": huge, "wide.txt": wide });
	await expect(read.run(R({ file_path: "huge.txt" }), ctx)).rejects.toThrow(
		"over the 256 KB limit",
	);
	// A whole file over ~25K tokens: its first part, marked PARTIAL.
	const partial = await read.run(R({ file_path: "wide.txt" }), ctx);
	expect(partial).toContain("PARTIAL view");
	expect(partial.length).toBeLessThan(100_500);
	// The same with offset and limit is an error instead.
	await expect(
		read.run(R({ file_path: "wide.txt", offset: 1, limit: 60 }), ctx),
	).rejects.toThrow("over the ~25K token limit");
});

test("read: empty, past the end, folders, binary, missing, UTF-16", async () => {
	const utf16 = Buffer.concat([
		Buffer.from([0xff, 0xfe]),
		Buffer.from("héllo\r\nwörld", "utf16le"),
	]);
	const { ctx } = project({
		"empty.txt": "",
		"a.txt": "one\n",
		"bin.dat": new Uint8Array([1, 0, 2, 3]),
		"u16.txt": utf16,
		"bom.txt": "﻿first",
		"sub/x.txt": "x",
	});
	expect(await read.run(R({ file_path: "empty.txt" }), ctx)).toBe(
		"empty.txt exists but is empty.",
	);
	expect(await read.run(R({ offset: 5 }), ctx)).toBe(
		"a.txt has 1 lines; offset 5 is past the end.",
	);
	await expect(read.run(R({ file_path: "sub" }), ctx)).rejects.toThrow(
		"is a folder",
	);
	await expect(read.run(R({ file_path: "bin.dat" }), ctx)).rejects.toThrow(
		"binary",
	);
	await expect(read.run(R({ file_path: "nope.txt" }), ctx)).rejects.toThrow(
		"file not found",
	);
	await expect(read.run(R({ file_path: "x.pdf" }), ctx)).rejects.toThrow();
	expect(await read.run(R({ file_path: "u16.txt" }), ctx)).toBe(
		"     1\théllo\n     2\twörld",
	);
	expect(await read.run(R({ file_path: "bom.txt" }), ctx)).toBe(
		"     1\tfirst",
	);
});

test("read: recorded; the same part of an unchanged file comes back as a stub", async () => {
	const wide = Array.from({ length: 60 }, () => "y".repeat(2000)).join("\n");
	const { ctx, cwd } = project({
		"a.txt": "one\ntwo\n",
		"empty.txt": "",
		"wide.txt": wide,
	});
	const first = await read.run(R({}), ctx);
	expect(first).toContain("one");
	expect(ctx.reads.get(join(cwd, "A.TXT"))).toMatchObject({
		offset: null,
		limit: null,
		partial: false,
	});
	expect(await read.run(R({}), ctx)).toStartWith("File unchanged");
	// Another part, or a changed file, is read in full.
	expect(await read.run(R({ limit: 1 }), ctx)).toContain("one");
	expect(await read.run(R({ limit: 1 }), ctx)).toStartWith("File unchanged");
	writeFileSync(join(cwd, "a.txt"), "uno\ntwo\n");
	expect(await read.run(R({ limit: 1 }), ctx)).toContain("uno");
	// An empty file counts; a cut-off view is marked; errors and past-the-end
	// reads leave nothing.
	await read.run(R({ file_path: "empty.txt" }), ctx);
	expect(ctx.reads.get(join(cwd, "empty.txt"))).toBeDefined();
	await read.run(R({ file_path: "wide.txt" }), ctx);
	expect(ctx.reads.get(join(cwd, "wide.txt"))?.partial).toBe(true);
	const { ctx: fresh } = project({ "a.txt": "one\n", "w.txt": wide });
	await read.run(R({ offset: 5 }), fresh);
	await expect(
		read.run(R({ file_path: "w.txt", offset: 1, limit: 60 }), fresh),
	).rejects.toThrow();
	expect(fresh.reads.get(join(fresh.cwd, "a.txt"))).toBeUndefined();
	expect(fresh.reads.get(join(fresh.cwd, "w.txt"))).toBeUndefined();
});

test("glob: dotfiles and ignored files found, .git skipped, newest first, denied dropped", async () => {
	const { ctx, cwd } = project(
		{
			".gitignore": "dist/\n",
			"dist/out.js": "",
			"src/a.ts": "",
			"src/b.ts": "",
			".github/ci.yml": "",
			".git/config": "",
			"secret.ts": "",
		},
		["Read(secret.ts)"],
	);
	utimesSync(join(cwd, "src/a.ts"), 1000, 1000);
	utimesSync(join(cwd, "src/b.ts"), 2000, 2000);
	expect(await glob.run({ pattern: "**/*.ts", path: null }, ctx)).toBe(
		[join("src", "b.ts"), join("src", "a.ts")].join("\n"),
	);
	const all = await glob.run({ pattern: "**/*", path: null }, ctx);
	expect(all).toContain(join("dist", "out.js"));
	expect(all).toContain(join(".github", "ci.yml"));
	expect(all).not.toContain("config");
	expect(await glob.run({ pattern: "*.ts", path: "src" }, ctx)).toContain(
		join("src", "a.ts"),
	);
	expect(await glob.run({ pattern: "*.rs", path: null }, ctx)).toBe(
		"No files found",
	);
});

test("glob: at most 100 results, with a note", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 120; i++) files[`f${i}.txt`] = "";
	const { ctx } = project(files);
	const out = (await glob.run({ pattern: "*.txt", path: null }, ctx)).split(
		"\n",
	);
	expect(out).toHaveLength(101);
	expect(out[100]).toContain("showing 100 of 120");
});

test("grep: three modes, gitignore respected, hidden files searched, denied files dropped", async () => {
	const { ctx, cwd } = project(
		{
			".gitignore": "dist/\n",
			"dist/out.js": "needle\n",
			"src/a.ts": "one\nneedle here\nthree\n",
			"src/b.py": "Needle\nneedle\n",
			".github/ci.yml": "needle\n",
			"secret.txt": "needle\n",
		},
		["Read(secret.txt)"],
	);
	// rg reads .gitignore inside a git repo.
	Bun.spawnSync(["git", "init", "-q"], { cwd });
	// .git stays out even when the model's glob matches everything.
	expect(
		await grep.run(G({ pattern: "repositoryformatversion", glob: "*" }), ctx),
	).toBe("No matches found");
	const files = await grep.run(G({ pattern: "needle" }), ctx);
	expect(files.split("\n")).toEqual([
		join(".github", "ci.yml"),
		join("src", "a.ts"),
		join("src", "b.py"),
	]);
	expect(
		await grep.run(
			G({ pattern: "needle", output_mode: "content", path: "src" }),
			ctx,
		),
	).toBe(
		[
			`${join("src", "a.ts")}:2:needle here`,
			`${join("src", "b.py")}:2:needle`,
		].join("\n"),
	);
	expect(
		await grep.run(
			G({ pattern: "needle", output_mode: "count", "-i": true, path: "src" }),
			ctx,
		),
	).toBe([`${join("src", "a.ts")}:1`, `${join("src", "b.py")}:2`].join("\n"));
	// One file: no file name, like rg (and Claude Code's Grep).
	expect(
		await grep.run(
			G({
				pattern: "needle",
				output_mode: "content",
				path: "src/a.ts",
				"-C": 1,
			}),
			ctx,
		),
	).toBe("1-one\n2:needle here\n3-three");
	expect(await grep.run(G({ pattern: "needle", type: "py" }), ctx)).toBe(
		join("src", "b.py"),
	);
	expect(await grep.run(G({ pattern: "needle", glob: "*.ts" }), ctx)).toBe(
		join("src", "a.ts"),
	);
	expect(
		await grep.run(
			G({ pattern: "one.needle", multiline: true, output_mode: "count" }),
			ctx,
		),
	).toBe(`${join("src", "a.ts")}:1`);
	expect(await grep.run(G({ pattern: "nothing-like-this" }), ctx)).toBe(
		"No matches found",
	);
	await expect(grep.run(G({ pattern: "(" }), ctx)).rejects.toThrow("regex");
});

test("grep: head_limit and offset page through results", async () => {
	const { ctx } = project({ "a.txt": lines(300).replaceAll("line", "hit") });
	const first = (
		await grep.run(G({ pattern: "hit", output_mode: "content" }), ctx)
	).split("\n");
	expect(first).toHaveLength(251);
	expect(first[250]).toBe("(Showing 1-250 of 300; use offset 250 for more.)");
	const next = await grep.run(
		G({ pattern: "hit", output_mode: "content", offset: 250, head_limit: 0 }),
		ctx,
	);
	expect(next.split("\n")).toHaveLength(50);
	expect(next.startsWith("a.txt:251:hit 251")).toBe(true);
	expect(await grep.run(G({ pattern: "hit", offset: 5 }), ctx)).toBe(
		"No entries at offset 5",
	);
});
