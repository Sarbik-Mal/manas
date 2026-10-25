import { expect, test } from "bun:test";
import { version } from "../package.json";

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
