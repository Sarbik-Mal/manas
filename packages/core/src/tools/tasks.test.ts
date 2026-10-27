import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { NO_BACKUPS } from "./backups";
import { powershell } from "./powershell";
import { readRecord } from "./reads";
import { type Ended, openTasks, taskStop } from "./tasks";

const setup = (stall?: { every: number; quiet: number }) => {
	const cwd = tempRoot();
	const notes: string[] = [];
	const dir = join(tempRoot(), "tasks");
	const tasks = openTasks({
		dir,
		vault: new Vault(),
		notify: (t) => notes.push(t),
		stall,
	});
	const ctx = {
		signal: new AbortController().signal,
		cwd,
		shell: { cwd },
		denied: () => undefined,
		reads: readRecord(),
		vault: new Vault(),
		backups: NO_BACKUPS,
		tasks,
	};
	const background = async (command: string) => {
		const out = await powershell.run(
			{ command, description: null, timeout: null, run_in_background: true },
			ctx,
		);
		return /ID: (b[0-9a-f]{6})/.exec(out)?.[1] ?? "";
	};
	return { cwd, notes, tasks, ctx, background, dir };
};
const until = async (ok: () => boolean, ms = 20_000) => {
	for (const end = Date.now() + ms; !ok() && Date.now() < end; )
		await Bun.sleep(50);
	return ok();
};

test("task_stop kills the whole tree and notifies; a second stop says it isn't running", async () => {
	const { cwd, notes, ctx, background } = setup();
	// The marker comes from a child of a child: it never appears if the
	// whole tree goes.
	const id = await background(
		'cmd /c "ping -n 4 127.0.0.1 >nul & echo x > marker.txt"',
	);
	await Bun.sleep(500);
	expect(await taskStop.run({ task_id: id }, ctx)).toBe(
		`Successfully stopped task: ${id} (cmd /c "ping -n 4 127.0.0.1 >nul & echo x > marker.txt")`,
	);
	expect(await until(() => notes.length > 0)).toBe(true);
	expect(notes[0]).toContain("<status>killed</status>");
	expect(notes[0]).toContain("was stopped</summary>");
	await Bun.sleep(4000);
	expect(existsSync(join(cwd, "marker.txt"))).toBe(false);
	await expect(taskStop.run({ task_id: id }, ctx)).rejects.toThrow(
		`Task ${id} is not running (status: killed)`,
	);
	await expect(taskStop.run({ task_id: "bnope00" }, ctx)).rejects.toThrow(
		"No task found with ID: bnope00",
	);
}, 30_000);

test("killAll stops everything without notices and removes the folder", async () => {
	const { notes, tasks, background, dir } = setup();
	await background("ping -n 30 127.0.0.1");
	expect(tasks.list()).toMatchObject([{ status: "running" }]);
	tasks.killAll();
	await Bun.sleep(1500);
	expect(notes).toEqual([]);
	expect(existsSync(dir)).toBe(false);
});

test("a command waiting on a question gets one stall notice", async () => {
	const { notes, tasks, background } = setup({ every: 100, quiet: 400 });
	await background("[Console]::Out.Write('Continue? (y/n) '); Start-Sleep 5");
	expect(await until(() => notes.length > 0, 5000)).toBe(true);
	expect(notes[0]).toContain(
		"appears to be waiting for interactive input</summary>",
	);
	expect(notes[0]).toContain("Last output:\nContinue? (y/n)");
	expect(notes[0]).toContain(
		"The command is likely blocked on an interactive prompt.",
	);
	await Bun.sleep(600);
	expect(notes).toHaveLength(1);
	tasks.killAll();
});

test("3.4: a background command whose output passes the cap is stopped", async () => {
	const notes: string[] = [];
	const tasks = openTasks({
		dir: join(tempRoot(), "tasks"),
		vault: new Vault(),
		notify: (t) => notes.push(t),
		outputMax: 1000,
	});
	let killed = false;
	let end: (e: Ended) => void = () => {};
	const t = tasks.adopt({
		command: "spam",
		description: "Spam",
		callId: "c",
		initial: "",
		kill: () => {
			killed = true;
			end({ code: 1, failed: true });
		},
		ended: new Promise<Ended>((r) => {
			end = r;
		}),
	});
	for (let i = 0; i < 50; i++) t.feed(`${"z".repeat(99)}\n`);
	await Bun.sleep(10);
	expect(killed).toBe(true);
	expect(notes[0]).toContain("<status>killed</status>");
	expect(notes[0]).toContain(
		'<summary>Background command "Spam" was stopped: its output passed 5 GB</summary>',
	);
	expect(readFileSync(t.outputFile, "utf8").length).toBeLessThanOrEqual(1100);
});
