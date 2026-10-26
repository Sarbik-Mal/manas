import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import { tempRoot } from "./testing/fake-openai";

const run = (...args: string[]) =>
	Bun.spawnSync([process.execPath, `${import.meta.dir}/main.ts`, ...args]);

test("--version prints the package version", () => {
	const r = run("--version");
	expect(r.exitCode).toBe(0);
	expect(r.stdout.toString().trim()).toBe(`manas ${version}`);
});

test("unknown flag is an error", () => {
	expect(run("--nope").exitCode).toBe(1);
});

test("the chat needs a terminal; piped input is refused", () => {
	const r = run("hi");
	expect(r.exitCode).toBe(1);
	expect(r.stderr.toString()).toContain("manas: needs a terminal");
});

test("manas sessions works without a terminal", () => {
	const r = Bun.spawnSync(
		[process.execPath, `${import.meta.dir}/main.ts`, "sessions"],
		{
			env: { ...process.env, USERPROFILE: tempRoot() },
		},
	);
	expect(r.exitCode).toBe(0);
	expect(r.stdout.toString().trim()).toBe("No sessions in this folder yet.");
});

test("--resume alone is the picker, not a missing value", () => {
	for (const args of [
		["--resume"],
		["--resume", "--debug"],
		["-c"],
		["--resume", "abc"],
	]) {
		const r = run(...args);
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("manas: needs a terminal");
	}
});

test("settings: a broken file or a bad rule stops Manas before any screen", () => {
	const home = tempRoot();
	mkdirSync(join(home, ".manas"));
	writeFileSync(
		join(home, ".manas", "settings.json"),
		'{\n  "effort": "low"\n  "x": 1\n}',
	);
	const env = { ...process.env, USERPROFILE: home };
	const spawn = (...args: string[]) =>
		Bun.spawnSync([process.execPath, `${import.meta.dir}/main.ts`, ...args], {
			env,
		});
	const broken = spawn("hi");
	expect(broken.exitCode).toBe(1);
	expect(broken.stderr.toString()).toContain(
		`manas: settings ${join(home, ".manas", "settings.json")} line 3:`,
	);

	writeFileSync(join(home, ".manas", "settings.json"), "{}");
	const typo = spawn("--deny", "Raed");
	expect(typo.exitCode).toBe(1);
	expect(typo.stderr.toString()).toContain('unknown tool "Raed"');
	const fine = spawn("--deny", "Read", "--deny", "PowerShell(rm *)");
	expect(fine.stderr.toString()).toContain("manas: needs a terminal");
});
