import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "./bin";

test("rg is extracted once and runs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "manas-bin-"));
	try {
		const first = await rgPath(dir);
		const mtime = statSync(first).mtimeMs;
		expect(await rgPath(dir)).toBe(first);
		expect(statSync(first).mtimeMs).toBe(mtime);
		const out = Bun.spawnSync([first, "--version"]).stdout.toString();
		expect(out).toStartWith("ripgrep ");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
