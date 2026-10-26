import { expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../testing/fake-openai";
import {
	CUT_OFF,
	findSession,
	listSessions,
	loadSession,
	openStore,
	projectDir,
	sessionFile,
} from "./store";

const start = () => ({
	model: "gpt-5.6-luna",
	effort: null,
	cwd: "E:\\p",
	version: "0",
	created: "2026-10-26T00:00:00.000Z",
});
const lines = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

test("a readable folder per project, like Claude's", () => {
	expect(projectDir("E:\\Experiments\\manas", "R")).toBe(
		join("R", "e--experiments-manas", "sessions"),
	);
	expect(projectDir("e:\\experiments\\MANAS", "R")).toBe(
		projectDir("E:\\Experiments\\manas", "R"),
	);
});

test("the file appears with the first item; changes before that go in the start line", () => {
	const file = sessionFile(projectDir("E:\\p", tempRoot()), "s1");
	const store = openStore(file, start);
	store.set({ model: "gpt-4o-mini" });
	store.usage("t1", { input: 1, cached: 0, output: 1, reasoning: 0 });
	expect(existsSync(file)).toBe(false);
	store.item({ role: "user", content: "hi" });
	store.set({ effort: "high" });
	expect(lines(file).map((l) => l.kind)).toEqual(["start", "item", "set"]);
});

test("load: round-trip, latest change wins, damaged lines skipped", () => {
	const file = sessionFile(projectDir("E:\\p", tempRoot()), "s2");
	const store = openStore(file, start);
	store.item({ role: "user", content: "hi" });
	store.set({ model: "gpt-4o-mini" });
	store.set({ effort: "low" });
	store.set({ model: "gpt-5.6-luna" });
	store.item({ role: "assistant", content: "hello" });
	const read = {
		path: "e:\\p\\a.ts",
		hash: "h",
		mtime: 1,
		offset: null,
		limit: 5,
		partial: false,
	};
	store.read(read);
	appendFileSync(file, '{"kind":"item","item":{"role":"us'); // killed mid-write
	const loaded = loadSession(file);
	expect(loaded.items).toEqual([
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "hello" },
	]);
	expect(loaded.reads).toEqual([read]);
	expect(loaded).toMatchObject({
		model: "gpt-5.6-luna",
		effort: "low",
		skipped: 1,
	});
});

test("a tool call cut off by a crash gets a result, appended to the file", () => {
	const file = sessionFile(projectDir("E:\\p", tempRoot()), "s3");
	const store = openStore(file, start);
	store.item({ role: "user", content: "go" });
	store.item({
		type: "function_call",
		call_id: "c1",
		name: "x",
		arguments: "{}",
	});
	store.item({
		type: "function_call",
		call_id: "c2",
		name: "y",
		arguments: "{}",
	});
	store.item({ type: "function_call_output", call_id: "c1", output: "done" });
	const fix = {
		type: "function_call_output" as const,
		call_id: "c2",
		output: CUT_OFF,
	};
	expect(loadSession(file).items.at(-1)).toEqual(fix);
	expect(lines(file).at(-1)).toEqual({ kind: "item", item: fix });
	expect(
		loadSession(file).items.filter((i) => i.type === "function_call_output"),
	).toHaveLength(2);
});

test("list: newest first, first prompt as the title, message count", () => {
	const dir = projectDir("E:\\p", tempRoot());
	const old = openStore(sessionFile(dir, "old"), start);
	old.item({ role: "user", content: "fix the login bug\nmore detail" });
	old.item({ role: "assistant", content: "done" });
	utimesSync(sessionFile(dir, "old"), new Date(1000), new Date(1000));
	const recent = openStore(sessionFile(dir, "new"), start);
	recent.item({ role: "user", content: "x".repeat(70) });
	expect(listSessions(dir)).toEqual([
		{
			session_id: "new",
			title: `${"x".repeat(60)}...`,
			updated: expect.any(String),
			messages: 1,
		},
		{
			session_id: "old",
			title: "fix the login bug",
			updated: "1970-01-01T00:00:01.000Z",
			messages: 2,
		},
	]);
	expect(listSessions(join(dir, "nope"))).toEqual([]);
});

test("find: this project first, then every project; odd ids never touch the disk", () => {
	const root = tempRoot();
	const other = openStore(
		sessionFile(projectDir("D:\\other", root), "abc"),
		start,
	);
	other.item({ role: "user", content: "hi" });
	expect(findSession("abc", "E:\\p", root)).toBe(
		sessionFile(projectDir("D:\\other", root), "abc"),
	);
	expect(findSession("nope", "E:\\p", root)).toBeUndefined();
	expect(findSession("..\\..\\x", "E:\\p", root)).toBeUndefined();
});
