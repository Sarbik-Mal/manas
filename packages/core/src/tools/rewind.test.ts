import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { openBackups } from "./backups";
import { edit } from "./edit";
import { read } from "./files";
import { readRecord, sha256 } from "./reads";
import type { ToolCtx } from "./registry";
import { write } from "./write";

// 2.6: what restoring a checkpoint puts back, at the backups level.

function project(files: Record<string, string> = {}) {
	const cwd = tempRoot();
	for (const [p, content] of Object.entries(files))
		writeFileSync(join(cwd, p), content);
	const backups = openBackups(tempRoot(), "s1");
	const ctx: ToolCtx = {
		signal: new AbortController().signal,
		cwd,
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
	const at = (p: string) => join(cwd, p);
	return { cwd, ctx, backups, look, change, create, at };
}

test("the 2.6 check: a bug fix is undone exactly", async () => {
	const buggy = "export function add(a, b) {\r\n\treturn a - b;\r\n}\r\n";
	const p = project({ "math.ts": buggy });
	const c1 = await p.backups.checkpoint(0);
	await p.look("math.ts");
	await p.change("math.ts", "a - b", "a + b");
	expect(await p.backups.preview(c1)).toEqual([
		{
			path: p.at("math.ts"),
			blob: sha256(Buffer.from(buggy)),
			action: "restore",
			added: 1,
			removed: 1,
		},
	]);
	expect(await p.backups.restore(c1)).toEqual({
		restored: [p.at("math.ts")],
		failed: [],
	});
	expect(sha256(readFileSync(p.at("math.ts")))).toBe(
		sha256(Buffer.from(buggy)),
	);
	expect(await p.backups.preview(c1)).toEqual([]); // nothing left to change
});

test("a created file is deleted; a deleted one comes back", async () => {
	const p = project({ "a.ts": "a\n" });
	const c1 = await p.backups.checkpoint(0);
	await p.create("new.ts", "made\n");
	await p.look("a.ts");
	await p.change("a.ts", "a", "b");
	rmSync(p.at("a.ts")); // deleted by hand after the edit
	const actions = ((await p.backups.preview(c1)) ?? []).map((c) => [
		c.path,
		c.action,
	]);
	expect(actions).toEqual([
		[p.at("new.ts"), "delete"],
		[p.at("a.ts"), "recreate"],
	]);
	await p.backups.restore(c1);
	expect(existsSync(p.at("new.ts"))).toBe(false);
	expect(readFileSync(p.at("a.ts"), "utf8")).toBe("a\n");
});

test("a file first touched in a later turn goes back to its earliest state", async () => {
	const p = project({ "a.ts": "v1\n" });
	const c1 = await p.backups.checkpoint(0); // a.ts not tracked yet
	await p.backups.checkpoint(2);
	await p.look("a.ts");
	await p.change("a.ts", "v1", "v2");
	await p.backups.checkpoint(5);
	await p.change("a.ts", "v2", "v3");
	await p.backups.restore(c1);
	expect(readFileSync(p.at("a.ts"), "utf8")).toBe("v1\n");
});

test("a locked file fails alone; the others are restored", async () => {
	const p = project({ "a.ts": "a\n", "b.ts": "b\n" });
	const c1 = await p.backups.checkpoint(0);
	await p.look("a.ts");
	await p.look("b.ts");
	await p.change("a.ts", "a", "A");
	await p.change("b.ts", "b", "B");
	const ps = Bun.spawn(
		[
			"powershell",
			"-NoProfile",
			"-Command",
			`$f = [IO.File]::Open('${p.at("b.ts")}', 'Open', 'ReadWrite', 'None'); Write-Output held; Start-Sleep 3; $f.Close()`,
		],
		{ stdout: "pipe" },
	);
	await ps.stdout.getReader().read();
	const r = await p.backups.restore(c1);
	expect(r.restored).toEqual([p.at("a.ts")]);
	expect(r.failed).toEqual([
		{ path: p.at("b.ts"), error: expect.stringContaining("is locked") },
	]);
	expect(readFileSync(p.at("a.ts"), "utf8")).toBe("a\n");
	await ps.exited;
}, 15_000);

test("a cut checkpoint stays in the file and still serves earlier restores", async () => {
	const p = project({ "a.ts": "v1\n" });
	const c1 = await p.backups.checkpoint(0);
	const c2 = await p.backups.checkpoint(2);
	await p.look("a.ts");
	await p.change("a.ts", "v1", "v2"); // first touched in c2
	p.backups.cut(c2);
	expect(p.backups.list().map((c) => [c.id, c.cut ?? false])).toEqual([
		[c1, false],
		[c2, true],
	]);
	expect(openBackups(join(p.backups.blobPath(""), ".."), "s1").list()).toEqual(
		p.backups.list(),
	);
	await p.backups.restore(c1);
	expect(readFileSync(p.at("a.ts"), "utf8")).toBe("v1\n");
});
