import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseBash } from "../permissions/bash";
import { readOnly } from "../permissions/engine";
import { parsePowerShell } from "../permissions/powershell";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { openBackups } from "./backups";
import { bashTool } from "./bash";
import { gitBash } from "./gitbash";
import { powershell } from "./powershell";
import { readRecord } from "./reads";
import type { ToolCtx } from "./registry";
import { openTasks } from "./tasks";
import { LIMITS, type Watched, watchCommand } from "./watch";

const spec: Watched = {
	parse: parsePowerShell,
	readOnly,
	path: (a) => a,
};

async function project(files: Record<string, string> = {}) {
	const cwd = tempRoot();
	for (const [p, content] of Object.entries(files)) {
		mkdirSync(join(cwd, p, ".."), { recursive: true });
		writeFileSync(join(cwd, p), content);
	}
	const root = tempRoot();
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
	const c1 = await backups.checkpoint(0);
	const blobs = () => {
		try {
			return readdirSync(join(root, "blobs"));
		} catch {
			return [];
		}
	};
	return {
		cwd,
		root,
		ctx,
		backups,
		c1,
		blobs,
		at: (p: string) => join(cwd, p),
	};
}

const run = (input: string) => ({
	command: input,
	description: null,
	timeout: null,
	run_in_background: null,
});

test("a read-only command isn't watched", async () => {
	const p = await project({ "a.txt": "a" });
	expect(await watchCommand("Get-Content a.txt", spec, p.ctx)).toBeUndefined();
	expect(p.blobs()).toEqual([]);
});

test("a named file, a folder and a glob are copied before the command", async () => {
	const p = await project({
		"a.txt": "a",
		"src/b.ts": "b",
		"src/deep/c.ts": "c",
		"d.log": "d",
		"e.log": "e",
		"other.md": "x",
	});
	await watchCommand("Remove-Item a.txt", spec, p.ctx);
	await watchCommand("Remove-Item -Recurse src", spec, p.ctx);
	await watchCommand("Remove-Item *.log", spec, p.ctx);
	for (const f of ["a.txt", "src/b.ts", "src/deep/c.ts", "d.log", "e.log"])
		expect(p.backups.tracks(p.at(f))).toBe(true);
	expect(p.backups.tracks(p.at("other.md"))).toBe(false);
});

test("the spellings a model uses for a delete are all copied", async () => {
	for (const command of [
		"Remove-Item -LiteralPath 'src\\cart.ts'",
		'Remove-Item "src/cart.ts" -Force',
		"Remove-Item -Path .\\src\\cart.ts -Force -ErrorAction Stop",
		"del src\\cart.ts",
	]) {
		const p = await project({ "src/cart.ts": "x" });
		await watchCommand(command, spec, p.ctx);
		expect(p.backups.tracks(p.at("src/cart.ts"))).toBe(true);
	}
});

test("a cd earlier in the command moves where names resolve", async () => {
	const p = await project({ "sub/a.txt": "a", "a.txt": "top" });
	await watchCommand("cd sub; Remove-Item a.txt", spec, p.ctx);
	expect(p.backups.tracks(p.at("sub/a.txt"))).toBe(true);
	expect(p.backups.tracks(p.at("a.txt"))).toBe(false);
});

test("the copy limit: what doesn't fit is lost once deleted", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 5; i++) files[`src/${i}.txt`] = "x";
	const p = await project(files);
	const after = await watchCommand("Remove-Item -Recurse src", spec, p.ctx, {
		...LIMITS,
		files: 3,
	});
	rmSync(p.at("src"), { recursive: true });
	await after?.();
	expect(p.backups.unrestorable(p.c1).unrestorable).toHaveLength(2);
	const bytes = await project({ "a.txt": "12345", "b.txt": "12345" });
	await watchCommand("Remove-Item a.txt, b.txt", spec, bytes.ctx, {
		...LIMITS,
		bytes: 7,
	});
	expect(
		["a.txt", "b.txt"].filter((f) => bytes.backups.tracks(bytes.at(f))),
	).toHaveLength(1);
});

test("a secret-named file is never copied or tracked, only listed", async () => {
	const p = await project({ ".env": "SECRET=hunter2" });
	const after = await watchCommand("Remove-Item .env", spec, p.ctx);
	rmSync(p.at(".env"));
	writeFileSync(p.at("id_rsa"), "new secret");
	await after?.();
	expect(p.blobs()).toEqual([]);
	expect(p.backups.tracks(p.at(".env"))).toBe(false);
	expect(p.backups.tracks(p.at("id_rsa"))).toBe(false);
	expect(p.backups.unrestorable(p.c1).unrestorable.sort()).toEqual([
		p.at(".env"),
		p.at("id_rsa"),
	]);
	// A checkpoint doesn't pick them up later either.
	await p.backups.checkpoint(2);
	expect(p.blobs()).toEqual([]);
});

test("new files are recorded as created; ignored ones aren't", async () => {
	const p = await project({ ".gitignore": "dist/\n" });
	const after = await watchCommand("npm run build", spec, p.ctx);
	writeFileSync(p.at("new.txt"), "n");
	mkdirSync(p.at("dist"));
	writeFileSync(p.at("dist/out.js"), "o");
	await after?.();
	expect(p.backups.list()[0].files).toEqual({ [p.at("new.txt")]: null });
});

test("an ignored file named directly is copied, an ignored folder isn't", async () => {
	const p = await project({
		".gitignore": "dist/\n",
		"dist/a.js": "a",
		"dist/b.js": "b",
	});
	await watchCommand("Remove-Item dist/a.js", spec, p.ctx);
	expect(p.backups.tracks(p.at("dist/a.js"))).toBe(true);
	await watchCommand("Remove-Item -Recurse dist", spec, p.ctx);
	expect(p.backups.tracks(p.at("dist/b.js"))).toBe(false);
});

test("past the scan limit: named files still copied, new files untracked", async () => {
	const p = await project({ "a.txt": "a", "b.txt": "b" });
	const after = await watchCommand("Remove-Item a.txt", spec, p.ctx, {
		...LIMITS,
		scan: 1,
	});
	expect(p.backups.tracks(p.at("a.txt"))).toBe(true);
	writeFileSync(p.at("new.txt"), "n");
	await after?.();
	expect(p.backups.tracks(p.at("new.txt"))).toBe(false);
	expect(p.backups.unrestorable(p.c1)).toEqual({
		unrestorable: [],
		untracked: true,
	});
});

test("the 3.6 check: a file deleted by PowerShell comes back with /rewind", async () => {
	const bytes = "line\r\nbytes\r\n";
	const p = await project({ "a.txt": bytes, "src/b.txt": "b" });
	await powershell.run(
		run("Remove-Item a.txt; Remove-Item -Recurse src"),
		p.ctx,
	);
	expect(existsSync(p.at("a.txt"))).toBe(false);
	const actions = ((await p.backups.preview(p.c1)) ?? []).map((c) => c.action);
	expect(actions).toEqual(["recreate", "recreate"]);
	await p.backups.restore(p.c1);
	expect(readFileSync(p.at("a.txt"), "utf8")).toBe(bytes);
	expect(readFileSync(p.at("src/b.txt"), "utf8")).toBe("b");
});

test("a command's unnamed change is listed; its new file goes on rewind", async () => {
	const p = await project({ "a.txt": "a", "b.txt": "b" });
	await powershell.run(
		run('$x = "a.txt"; Remove-Item $x; Set-Content new.txt n'),
		p.ctx,
	);
	expect(p.backups.unrestorable(p.c1).unrestorable).toEqual([p.at("a.txt")]);
	await p.backups.restore(p.c1);
	expect(existsSync(p.at("new.txt"))).toBe(false);
	expect(existsSync(p.at("a.txt"))).toBe(false);
	// A rewind to after the loss has nothing to report.
	const c2 = await p.backups.checkpoint(2);
	expect(p.backups.unrestorable(c2).unrestorable).toEqual([]);
});

const bash = gitBash().path;
test.skipIf(!bash)("a file deleted by bash comes back too", async () => {
	const p = await project({ "a.txt": "a" });
	await bashTool(bash as string).run(run("rm a.txt"), p.ctx);
	expect(existsSync(p.at("a.txt"))).toBe(false);
	await p.backups.restore(p.c1);
	expect(readFileSync(p.at("a.txt"), "utf8")).toBe("a");
});

test("lost and untracked survive a resume and the checkpoint trim", async () => {
	const p = await project();
	p.backups.lost(p.at("a.txt"), p.c1);
	p.backups.untracked(p.c1);
	const want = { unrestorable: [p.at("a.txt")], untracked: true };
	expect(openBackups(p.root, "s1").unrestorable(p.c1)).toEqual(want);
	// The trim drops c1 and rewrites the file; c2 keeps its own.
	const c2 = await p.backups.checkpoint(1);
	p.backups.lost(p.at("b.txt"), c2);
	for (let i = 0; i < 99; i++) await p.backups.checkpoint(i + 2);
	expect(p.backups.list()[0].id).toBe(c2);
	expect(openBackups(p.root, "s1").unrestorable(c2).unrestorable).toEqual([
		p.at("b.txt"),
	]);
});

test("a tracked file isn't lost: rewind has its copy", async () => {
	const p = await project({ "a.txt": "a" });
	p.backups.before(p.at("a.txt"), readFileSync(p.at("a.txt")));
	p.backups.lost(p.at("a.txt"), p.c1);
	expect(p.backups.unrestorable(p.c1).unrestorable).toEqual([]);
});

test("a background command is scanned when it ends, under the prompt that started it", async () => {
	const p = await project({ "a.txt": "a" });
	const tasks = openTasks({
		dir: join(tempRoot(), "tasks"),
		vault: new Vault(),
		notify: () => {},
	});
	const ctx = { ...p.ctx, tasks };
	await powershell.run(
		{
			command:
				"Start-Sleep -Milliseconds 1500; Set-Content new.txt n; Remove-Item a.txt",
			description: null,
			timeout: null,
			run_in_background: true,
		},
		ctx,
	);
	// A later prompt starts while it runs.
	await p.backups.checkpoint(2);
	for (const end = Date.now() + 20_000; Date.now() < end; ) {
		if (p.backups.tracks(p.at("new.txt"))) break;
		await Bun.sleep(50);
	}
	expect(p.backups.list()[0].files[p.at("new.txt")]).toBeNull();
	expect(p.backups.list()[1].files[p.at("new.txt")]).toBeUndefined();
	await p.backups.restore(p.c1);
	expect(existsSync(p.at("new.txt"))).toBe(false);
	expect(readFileSync(p.at("a.txt"), "utf8")).toBe("a");
}, 30_000);

test("bash names are converted and parsed by its own parser", async () => {
	const p = await project({ "a.txt": "a" });
	const { toWindows } = await import("../permissions/bash");
	await watchCommand(
		"rm a.txt",
		{ parse: parseBash, readOnly: () => false, path: toWindows },
		p.ctx,
	);
	expect(p.backups.tracks(p.at("a.txt"))).toBe(true);
});
