import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installId } from "./install-id";

test("creates the id once, then reuses it", () => {
	const dir = join(mkdtempSync(join(tmpdir(), "manas-")), "home");
	try {
		const first = installId(dir);
		expect(existsSync(join(dir, "install-id"))).toBe(true);
		expect(installId(dir)).toBe(first);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
