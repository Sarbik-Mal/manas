import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { protect, unprotect } from "./dpapi";

test("round-trips empty, short and 1 MB data", () => {
	for (const data of [
		new Uint8Array(),
		new TextEncoder().encode("sk-proj-secret"),
		new Uint8Array(randomBytes(1024 * 1024)),
	]) {
		const blob = protect(data);
		expect(blob.length).toBeGreaterThan(data.length);
		expect(unprotect(blob)).toEqual(data);
	}
});

test("a changed blob is refused", () => {
	const blob = protect(new TextEncoder().encode("hello"));
	blob[blob.length - 1] ^= 0xff;
	expect(() => unprotect(blob)).toThrow("DPAPI decrypt failed");
});
