import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { NO_BACKUPS } from "./backups";
import { cut, powershell } from "./powershell";
import { readRecord } from "./reads";
import { buildRegistry, callTool } from "./registry";
import { openTasks } from "./tasks";

const ctxFor = (cwd: string, signal = new AbortController().signal) => ({
	signal,
	cwd,
	shell: { cwd },
	denied: () => undefined,
	reads: readRecord(),
	vault: new Vault(),
	backups: NO_BACKUPS,
});
const input = (
	command: string,
	timeout: number | null = null,
	run_in_background: boolean | null = null,
) => ({
	command,
	description: null,
	timeout,
	run_in_background,
});
// A ctx with background tasks; `notes` collects what the model would be told.
const withTasks = (cwd = tempRoot()) => {
	const notes: string[] = [];
	const tasks = openTasks({
		dir: join(tempRoot(), "tasks"),
		vault: new Vault(),
		notify: (t) => notes.push(t),
	});
	return { ctx: { ...ctxFor(cwd), tasks }, notes, tasks };
};
const until = async (ok: () => boolean, ms = 20_000) => {
	for (const end = Date.now() + ms; !ok() && Date.now() < end; )
		await Bun.sleep(50);
	return ok();
};
const fileOf = (text: string) =>
	readFileSync(/written to: (.+?\.output)/.exec(text)?.[1] ?? "", "utf8");

test("a timeout moves the command to the background, except a sleep", async () => {
	const { ctx, notes } = withTasks();
	expect(await powershell.run(input("Start-Sleep 3; 'done'", 1000), ctx)).toBe(
		"Command timed out after 1 s and was stopped.",
	);
	const out = await powershell.run(input("ping -n 4 127.0.0.1", 1000), ctx);
	expect(out).toMatch(
		/^Command did not complete within its 1s timeout and was moved to the background \(ID: b[0-9a-f]{6}\)\. Output is being written to: .+\.output\. You will be notified when it completes\. To check interim output, use read on that file path\.$/,
	);
	expect(await until(() => notes.length > 0)).toBe(true);
	expect(notes[0]).toContain("<status>completed</status>");
	expect(notes[0]).toContain(
		'<summary>Background command "ping -n 4 127.0.0.1" completed (exit code 0)</summary>',
	);
	expect(fileOf(out)).toContain("127.0.0.1");
});

test("run_in_background returns at once and notifies on exit; secrets are scrubbed in the file", async () => {
	const { ctx, notes } = withTasks();
	const key = `sk-${"a".repeat(30)}`;
	const start = Date.now();
	const out = await powershell.run(
		input(`Start-Sleep 1; Write-Output '${key}'; exit 3`, null, true),
		ctx,
	);
	expect(Date.now() - start).toBeLessThan(1000);
	expect(out).toStartWith("Command running in background with ID: b");
	expect(out).toContain("do not poll that file or sleep while waiting");
	expect(await until(() => notes.length > 0)).toBe(true);
	expect(notes[0]).toContain("failed with exit code 3");
	expect(notes[0]).toContain("<status>failed</status>");
	const file = fileOf(out);
	expect(file).toContain("[REDACTED:api_key#");
	expect(file).not.toContain(key);
});

test("a backgrounded command never moves the folder; Ctrl+B and a message have their own texts", async () => {
	const cwd = tempRoot();
	mkdirSync(join(cwd, "sub"));
	const { ctx, tasks } = withTasks(cwd);
	const running = powershell.run(input("cd sub; ping -n 3 127.0.0.1"), ctx);
	await Bun.sleep(500);
	expect(tasks.backgroundAll("user")).toBe(1);
	const out = await running;
	expect(out).toStartWith(
		"Command was manually backgrounded by user with ID: b",
	);
	expect(out).toContain(
		`Session cwd remains ${cwd}; directory changes made by the backgrounded command do not apply to subsequent commands.`,
	);
	expect(ctx.shell.cwd).toBe(cwd);
	const second = powershell.run(input("ping -n 3 127.0.0.1"), ctx);
	await Bun.sleep(500);
	tasks.backgroundAll("message");
	expect(await second).toContain(
		"so that a message that arrived while it was running can reach you; it was not interrupted",
	);
	tasks.killAll();
});

test("a read-only command runs in the project folder, UTF-8 intact", async () => {
	const cwd = tempRoot();
	writeFileSync(join(cwd, "héllo-日本.txt"), "");
	const out = await powershell.run(
		input("(Get-ChildItem).Name; (Get-Location).Path"),
		ctxFor(cwd),
	);
	expect(out).toBe(`héllo-日本.txt\n${cwd}`);
});

test("errors come back as text, with the exit code", async () => {
	const out = await powershell.run(
		input("Get-Item nope-missing"),
		ctxFor(tempRoot()),
	);
	expect(out).toContain("Cannot find path");
	expect(out).not.toContain("CLIXML");
	expect(out).toContain("exit code 1");
});

test("a command that changes things goes to the permission check, then runs", async () => {
	const cwd = tempRoot();
	let asked = 0;
	const r = await callTool(
		buildRegistry([powershell] as never),
		"powershell",
		JSON.stringify(input("New-Item made.txt | Out-Null; 'done'")),
		ctxFor(cwd),
		async () => {
			asked++;
			return undefined;
		},
	);
	expect(r).toEqual({ status: "ok", output: "done" });
	expect(asked).toBe(1);
	expect(existsSync(join(cwd, "made.txt"))).toBe(true);
});

test("a cd carries over inside the project and resets outside it", async () => {
	const cwd = tempRoot();
	mkdirSync(join(cwd, "sub"));
	const ctx = ctxFor(cwd);
	expect(await powershell.run(input("cd sub"), ctx)).toBe("(no output)");
	expect(ctx.shell.cwd).toBe(join(cwd, "sub"));
	expect(await powershell.run(input("(Get-Location).Path"), ctx)).toBe(
		join(cwd, "sub"),
	);
	expect(await powershell.run(input("cd C:\\"), ctx)).toBe(
		`Shell cwd was reset to ${cwd}`,
	);
	expect(ctx.shell.cwd).toBe(cwd);
});

test("exit codes read as Claude Code reads them", async () => {
	const ctx = ctxFor(tempRoot());
	writeFileSync(join(ctx.cwd, "a.txt"), "hello\n");
	expect(await powershell.run(input("findstr nope a.txt"), ctx)).toBe(
		"No matches found",
	);
	expect(await powershell.run(input("cmd /c exit 3"), ctx)).toBe(
		"Command failed with exit code 3",
	);
	expect(
		await powershell.run(
			input("findstr nope a.txt | Select-Object -First 1"),
			ctx,
		),
	).toBe("No matches found");
});

test("a long command runs, and > writes UTF-8", async () => {
	const ctx = ctxFor(tempRoot());
	const long = `$x = '${"a".repeat(20_000)}'; $x.Length`;
	expect(await powershell.run(input(long), ctx)).toBe("20000");
	await powershell.run(input("'héllo' > out.txt"), ctx);
	expect(readFileSync(join(ctx.cwd, "out.txt"), "utf8")).toContain("héllo");
	// param() must lead the script, so it runs without the prefix.
	expect(await powershell.run(input("param($n = 2) $n * 3"), ctx)).toBe("6");
});

test("a timeout or an interrupt stops the command", async () => {
	const start = Date.now();
	const out = await powershell.run(
		input("Start-Sleep 30", 1000),
		ctxFor(tempRoot()),
	);
	expect(out).toBe("Command timed out after 1 s and was stopped.");
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 1000);
	await powershell.run(input("Start-Sleep 30"), ctxFor(tempRoot(), ac.signal));
	expect(Date.now() - start).toBeLessThan(15_000);
});

test("long output keeps its start and end", () => {
	const out = cut(`${"a".repeat(20_000)}${"b".repeat(20_000)}`);
	expect(out).toStartWith("a".repeat(15_000));
	expect(out).toEndWith("b".repeat(15_000));
	expect(out).toContain("[… 10000 characters cut …]");
});
