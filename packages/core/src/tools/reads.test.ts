import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../testing/fake-openai";
import { fileKey, readRecord } from "./reads";

const read = {
	hash: "h",
	mtime: 1,
	offset: null,
	limit: null,
	partial: false,
};

test("Src\\App.ts and src/app.ts count as one file", () => {
	const root = tempRoot();
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "app.ts"), "x");
	const saved: string[] = [];
	const reads = readRecord([], (r) => saved.push(r.path));
	reads.set(join(root, "Src\\App.ts"), read);
	expect(reads.get(`${root}/src/app.ts`)).toMatchObject(read);
	expect(saved).toEqual([fileKey(join(root, "src", "app.ts"))]);
});

test("a junction and the real folder give one key", () => {
	const root = tempRoot();
	mkdirSync(join(root, "real"));
	writeFileSync(join(root, "real", "a.ts"), "x");
	symlinkSync(join(root, "real"), join(root, "link"), "junction");
	expect(fileKey(join(root, "link", "a.ts"))).toBe(
		fileKey(join(root, "real", "a.ts")),
	);
});

test("a file that doesn't exist yet still gets a key; saved reads come back", () => {
	const root = tempRoot();
	const key = fileKey(join(root, "New.ts"));
	expect(key).toBe(join(root, "New.ts").toLowerCase());
	const reads = readRecord([{ path: key, ...read }]);
	expect(reads.get(join(root, "new.TS"))?.hash).toBe("h");
});
