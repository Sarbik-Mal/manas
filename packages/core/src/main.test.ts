import { expect, test } from "bun:test";
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
