import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { NO_BACKUPS } from "./backups";
import { cut, powershell } from "./powershell";
import { readRecord } from "./reads";
import { buildRegistry, callTool } from "./registry";

const ctxFor = (cwd: string, signal = new AbortController().signal) => ({
	signal,
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
