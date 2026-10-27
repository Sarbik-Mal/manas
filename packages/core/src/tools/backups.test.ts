import { expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { openBackups } from "./backups";
import { edit } from "./edit";
import { read } from "./files";
import { readRecord, sha256 } from "./reads";
import type { ToolCtx } from "./registry";
import { write } from "./write";

function project(files: Record<string, string> = {}) {
	const cwd = tempRoot();
	const root = tempRoot(); // stands in for ~/.manas/projects/<p>/backups
	for (const [p, content] of Object.entries(files))
		writeFileSync(join(cwd, p), content);
	const backups = openBackups(root, "s1");
	const ctx: ToolCtx = {
		signal: new AbortController().signal,
		cwd,
		shell: { cwd },
		denied: () => undefined,
		reads: readRecord(),
		vault: new Vault(),
		backups,
	};
	const look = (file_path: string) =>
		read.run({ file_path, offset: null, limit: null }, ctx);
	const change = async (
		file_path: string,
		old_string: string,
		new_string: string,
	) => {
		const input = { file_path, old_string, new_string, replace_all: null };
		expect(await edit.validate?.(input, ctx)).toBeUndefined();
		return edit.run(input, ctx);
	};
	const create = async (file_path: string, content: string) => {
		const input = { file_path, content };
		expect(await write.validate?.(input, ctx)).toBeUndefined();
		return write.run(input, ctx);
	};
	const blobs = () => {
		try {
			return readdirSync(join(root, "blobs"));
		} catch {
			return [];
		}
	};
	const at = (i: number) => backups.list()[i].files;
	return { cwd, root, ctx, backups, look, change, create, blobs, at };
}

test("the 2.5 check: the same version is stored once", async () => {
	const p = project({
		"big.ts": `${`${"x".repeat(50)}\n`.repeat(1000)}end\n`,
	});
	await p.backups.checkpoint(0);
	await p.look("big.ts");
	await p.change("big.ts", "end", "END");
	// Three more prompts with the file unchanged: no new blob.
	for (const items of [3, 6, 9]) await p.backups.checkpoint(items);
	expect(p.blobs()).toHaveLength(2); // before the edit, after it
	// Another session of the same project shares the blob store.
	const other = openBackups(p.root, "s2");
	await other.checkpoint(0);
	other.before(join(p.cwd, "big.ts"), readFileSync(join(p.cwd, "big.ts")));
	expect(p.blobs()).toHaveLength(2);
});

test("backed up before the change, once per turn; a new file is null", async () => {
	const p = project({ "a.ts": "one\n" });
	await p.backups.checkpoint(0);
	await p.look("a.ts");
	await p.change("a.ts", "one", "two");
	await p.change("a.ts", "two", "three");
	await p.create("b.ts", "new\n");
	const a = join(p.cwd, "a.ts");
	const b = join(p.cwd, "b.ts");
	expect(p.at(0)).toEqual({ [a]: sha256(Buffer.from("one\n")), [b]: null });
	expect(readFileSync(p.backups.blobPath(p.at(0)[a] as string), "utf8")).toBe(
		"one\n",
	);
	// The next prompt's checkpoint holds both as they are now; a change made
	// outside Manas between prompts is caught there too.
	writeFileSync(a, "by hand\n");
	await p.backups.checkpoint(4);
	expect(p.at(1)).toEqual({
		[a]: sha256(Buffer.from("by hand\n")),
		[b]: sha256(Buffer.from("new\n")),
	});
	expect(p.blobs()).toHaveLength(3); // one, by hand, new
});

test("a resumed session keeps its checkpoints and what it tracks", async () => {
	const p = project({ "a.ts": "one\n" });
	await p.backups.checkpoint(0);
	await p.look("a.ts");
	await p.change("a.ts", "one", "two");
	const again = openBackups(p.root, "s1");
	expect(again.list()).toEqual(p.backups.list());
	await again.checkpoint(3);
	expect(again.list().map((c) => c.id)).toEqual(["c1", "c2"]);
	expect(again.list()[1].files).toEqual({
		[join(p.cwd, "a.ts")]: sha256(Buffer.from("two\n")),
	});
});

test("the newest 100 checkpoints are kept", async () => {
	const p = project();
	for (let i = 0; i < 101; i++) await p.backups.checkpoint(i);
	expect(p.backups.list()).toHaveLength(100);
	expect(p.backups.list()[0].id).toBe("c2");
	expect(openBackups(p.root, "s1").list()).toEqual(p.backups.list());
});

test("a change with no checkpoint is refused rather than left without a backup", () => {
	const p = project();
	expect(() => p.backups.before(join(p.cwd, "a.ts"), null)).toThrow(
		"no checkpoint",
	);
});
