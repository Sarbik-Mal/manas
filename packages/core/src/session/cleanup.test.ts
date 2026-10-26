import { expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempRoot } from "../testing/fake-openai";
import { sweep } from "./cleanup";

const DAY = 86_400_000;
const now = Date.now();
// A file `days` old by its last change.
function put(path: string, days: number, text = "x") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	const t = (now - days * DAY) / 1000;
	utimesSync(path, t, t);
}
const hash = (c: string) => c.repeat(64);

test("the 2.9 check: an old session goes with its vault and backups; blobs, logs and empty projects too", async () => {
	const dir = tempRoot();
	const a = join(dir, "projects", "e--a");
	const at = (...p: string[]) => join(a, ...p);
	put(at("sessions", "old.jsonl"), 40);
	put(at("sessions", "old", "vault.bin"), 40);
	put(
		at("backups", "old", "checkpoints.jsonl"),
		40,
		`{"files":{"a.ts":"${hash("1")}","b.ts":"${hash("2")}"}}\n`,
	);
	put(at("sessions", "new.jsonl"), 2);
	put(at("backups", "new", "checkpoints.jsonl"), 2, `"blob":"${hash("2")}"`);
	put(at("sessions", "open.jsonl"), 40); // the one this process opened
	put(at("backups", "blobs", hash("1")), 40); // only the old session's
	put(at("backups", "blobs", hash("2")), 40); // also the new one's
	put(at("backups", "blobs", hash("3")), 1 / 24); // unused, an hour old
	put(at("backups", "blobs", hash("4")), 2); // unused
	put(at("backups", "blobs", `${hash("5")}.123.tmp`), 2);
	// A project with only an old session goes; prompt history keeps one.
	put(join(dir, "projects", "e--b", "sessions", "s.jsonl"), 40);
	put(join(dir, "projects", "e--c", "sessions", "s.jsonl"), 40);
	put(join(dir, "projects", "e--c", "prompt-history.bin"), 90);
	put(join(dir, "logs", "debug-2026-01-01.jsonl"), 40);
	put(join(dir, "logs", "debug-today.jsonl"), 0);

	expect(await sweep({ dir, days: 30, keep: "open", now })).toEqual({
		sessions: 3,
		blobs: 3,
		logs: 1,
		projects: 1,
		failed: 0,
	});
	for (const gone of [
		at("sessions", "old.jsonl"),
		at("sessions", "old"),
		at("backups", "old"),
		at("backups", "blobs", hash("1")),
		at("backups", "blobs", hash("4")),
		at("backups", "blobs", `${hash("5")}.123.tmp`),
		join(dir, "projects", "e--b"),
		join(dir, "projects", "e--c", "sessions", "s.jsonl"),
		join(dir, "logs", "debug-2026-01-01.jsonl"),
	])
		expect([gone, existsSync(gone)]).toEqual([gone, false]);
	for (const kept of [
		at("sessions", "new.jsonl"),
		at("backups", "new", "checkpoints.jsonl"),
		at("sessions", "open.jsonl"),
		at("backups", "blobs", hash("2")),
		at("backups", "blobs", hash("3")),
		join(dir, "projects", "e--c", "prompt-history.bin"),
		join(dir, "logs", "debug-today.jsonl"),
	])
		expect([kept, existsSync(kept)]).toEqual([kept, true]);
	expect(existsSync(join(dir, ".last-cleanup"))).toBe(true);
});

test("once a day: a second sweep within 24 h does nothing", async () => {
	const dir = tempRoot();
	expect(await sweep({ dir, days: 30, now })).toBeDefined();
	const old = join(dir, "projects", "e--a", "sessions", "s.jsonl");
	put(old, 40);
	expect(await sweep({ dir, days: 30, now: now + DAY / 2 })).toBeUndefined();
	expect(existsSync(old)).toBe(true);
	expect(await sweep({ dir, days: 30, now: now + DAY + 1000 })).toMatchObject({
		sessions: 1,
	});
});

test("a locked session is skipped and tried again next time; the rest are cleaned", async () => {
	const dir = tempRoot();
	const sessions = join(dir, "projects", "e--a", "sessions");
	const locked = join(sessions, "locked.jsonl");
	put(locked, 40);
	put(join(sessions, "locked", "vault.bin"), 40);
	put(join(sessions, "other.jsonl"), 40);
	// PowerShell holds it open with no sharing, as another window might.
	const ps = Bun.spawn(
		[
			"powershell",
			"-NoProfile",
			"-Command",
			`$f = [IO.File]::Open('${locked}', 'Open', 'ReadWrite', 'None'); Write-Output held; Start-Sleep 3; $f.Close()`,
		],
		{ stdout: "pipe" },
	);
	await ps.stdout.getReader().read(); // "held"
	expect(await sweep({ dir, days: 30, now })).toMatchObject({
		sessions: 1,
		failed: 1,
	});
	expect(existsSync(locked)).toBe(true);
	expect(existsSync(join(sessions, "locked", "vault.bin"))).toBe(true);
	expect(existsSync(join(sessions, "other.jsonl"))).toBe(false);
	await ps.exited;
	expect(await sweep({ dir, days: 30, now: now + 2 * DAY })).toMatchObject({
		sessions: 1,
		failed: 0,
	});
	expect(existsSync(join(sessions, "locked"))).toBe(false);
}, 15_000);
