import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { NO_BACKUPS } from "./backups";
import { bashTool } from "./bash";
import { gitBash } from "./gitbash";
import { powershell } from "./powershell";
import { readRecord } from "./reads";
import { buildRegistry, callTool } from "./registry";
import { openTasks } from "./tasks";

// Runs the real Git Bash; skipped on a PC without it.
const found = gitBash().path;
const it = found ? test : test.skip;
const bash = bashTool(found ?? "");

const ctxFor = (cwd: string) => ({
	signal: new AbortController().signal,
	cwd,
	shell: { cwd },
	denied: () => undefined,
	reads: readRecord(),
	vault: new Vault(),
	backups: NO_BACKUPS,
});
const input = (command: string, timeout: number | null = null) => ({
	command,
	description: null,
	timeout,
	run_in_background: null,
});

it("3.5: runs bash, with Claude's exit-1 notes and the failure line", async () => {
	const ctx = ctxFor(tempRoot());
	expect(await bash.run(input("echo hi && echo err >&2"), ctx)).toBe("hi\nerr");
	expect(await bash.run(input("echo x | grep y"), ctx)).toBe(
		"No matches found",
	);
	expect(await bash.run(input("exit 3"), ctx)).toBe(
		"Command failed with exit code 3",
	);
	// Git Bash's own aliases come through the snapshot.
	expect(await bash.run(input("alias ll"), ctx)).toContain("alias ll=");
}, 30_000);

it("the folder is shared with PowerShell and reset outside the project", async () => {
	const cwd = tempRoot();
	mkdirSync(join(cwd, "sub"));
	const ctx = ctxFor(cwd);
	await bash.run(input("cd sub"), ctx);
	expect(ctx.shell.cwd.toLowerCase()).toBe(join(cwd, "sub").toLowerCase());
	expect(
		(await powershell.run(input("(Get-Location).Path"), ctx)).toLowerCase(),
	).toBe(join(cwd, "sub").toLowerCase());
	expect(await bash.run(input("cd /"), ctx)).toBe(
		`Shell cwd was reset to ${cwd}`,
	);
	expect(ctx.shell.cwd).toBe(cwd);
}, 30_000);

it("a timeout moves it to the background; a secret is scrubbed in the spill", async () => {
	const notes: string[] = [];
	const tasks = openTasks({
		dir: join(tempRoot(), "tasks"),
		vault: new Vault(),
		notify: (t) => notes.push(t),
	});
	const ctx = { ...ctxFor(tempRoot()), tasks };
	expect(await bash.run(input("sleep 3; echo done", 1000), ctx)).toBe(
		"Command timed out after 1 s and was stopped.",
	);
	const out = await bash.run(
		input("ping -n 3 127.0.0.1 > /dev/null; echo done", 1000),
		ctx,
	);
	expect(out).toContain("was moved to the background");
	for (let i = 0; i < 100 && notes.length === 0; i++) await Bun.sleep(100);
	expect(notes[0]).toContain("completed (exit code 0)");

	const key = `sk-proj-${"Q1w2E3r4T5y6U7i8O9p0".repeat(2)}`;
	const results = join(tempRoot(), "tool-results");
	const r = await callTool(
		buildRegistry([bash]),
		"bash",
		JSON.stringify(input(`echo ${key}; seq 1 9000`)),
		{ ...ctxFor(tempRoot()), results },
		undefined,
		"c1",
	);
	expect(r.output).toStartWith("<persisted-output>");
	const file = readFileSync(join(results, "c1.txt"), "utf8");
	expect(file).not.toContain(key);
	expect(file).toEndWith("9000");
}, 60_000);
