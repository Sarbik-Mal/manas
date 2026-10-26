import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { cut, powershell } from "./powershell";
import { readRecord } from "./reads";
import { buildRegistry, callTool } from "./registry";

const ctxFor = (cwd: string, signal = new AbortController().signal) => ({
	signal,
	cwd,
	denied: () => undefined,
	reads: readRecord(),
	vault: new Vault(),
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

test("anything not read-only is refused before any permission prompt", async () => {
	const registry = buildRegistry([powershell] as never);
	let asked = 0;
	const permit = async () => {
		asked++;
		return undefined;
	};
	for (const command of [
		"Remove-Item a.txt",
		"Get-Content .env",
		"iex 'Get-Date'",
		"Get-Date > out.txt",
	]) {
		const r = await callTool(
			registry,
			"powershell",
			JSON.stringify(input(command)),
			ctxFor(tempRoot()),
			permit,
		);
		expect(r.status).toBe("error");
		expect(r.output).toStartWith(
			"error: only read-only commands can run for now:",
		);
	}
	expect(asked).toBe(0);
	const ok = await callTool(
		registry,
		"powershell",
		JSON.stringify(input("Get-Date -Year 2001 -Format yyyy")),
		ctxFor(tempRoot()),
		permit,
	);
	expect(ok).toEqual({ status: "ok", output: "2001" });
	expect(asked).toBe(1);
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
