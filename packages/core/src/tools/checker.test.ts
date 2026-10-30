import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Type from "typebox";
import { disableDebugLog, enableDebugLog } from "../log/debug";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { NO_BACKUPS } from "./backups";
import {
	findProject,
	openChecker,
	parseTsc,
	type RunTsc,
	render,
	type TscError,
} from "./checker";
import { edit } from "./edit";
import { openHooks } from "./hooks";
import { readRecord } from "./reads";
import { buildRegistry, callTool, defineTool, type ToolCtx } from "./registry";

const signal = new AbortController().signal;
const CWD = "C:\\p";
const a = "C:\\p\\a.ts";
const err = (message: string, file = a, line = 1, code = "TS1"): TscError => ({
	file,
	line,
	column: 1,
	code,
	message,
});
// A checker over a scripted tsc: each run takes the next list.
function scripted(...runs: (TscError[] | "timeout" | "failed")[]) {
	let calls = 0;
	const run: RunTsc = async () => {
		const r = runs[calls++] ?? [];
		return typeof r === "string" ? { status: r } : { status: "ok", errors: r };
	};
	const c = openChecker({
		cwd: CWD,
		cache: tempRoot(),
		run,
		find: () => ({ tsconfig: "C:\\p\\tsconfig.json", tsc: "tsc" }),
	});
	return { c, calls: () => calls };
}

test("parsing: errors with their indented lines; other lines ignored", () => {
	const out = [
		"src/a.ts(3,7): error TS2322: Type 'string' is not assignable.",
		"  Type 'x' is missing.",
		"",
		"Found 1 error.",
		"b.ts(1,1): error TS1005: ';' expected.",
	].join("\r\n");
	expect(parseTsc(out, CWD)).toEqual([
		{
			file: resolve(CWD, "src/a.ts"),
			line: 3,
			column: 7,
			code: "TS2322",
			message: "Type 'string' is not assignable.\n  Type 'x' is missing.",
		},
		{
			file: resolve(CWD, "b.ts"),
			line: 1,
			column: 1,
			code: "TS1005",
			message: "';' expected.",
		},
	]);
});

test("new means over the baseline's count, whatever the line", async () => {
	const { c } = scripted(
		[err("old", a, 1)],
		[err("old", a, 50)],
		[err("old", a, 50), err("old", a, 60)],
	);
	await c.before(a, signal);
	expect(await c.after(a, signal)).toBeUndefined();
	const text = await c.after(a, signal);
	expect(text).toContain("[Line 60:1]");
	expect(text).not.toContain("[Line 50:1]");
});

test("each new error is reported once; a fixed one coming back is new", async () => {
	const { c } = scripted(
		[err("old")],
		[err("old", a, 9), err("mine")],
		[err("old"), err("mine")],
		[err("old")],
		[err("old"), err("mine")],
	);
	await c.before(a, signal);
	const first = await c.after(a, signal);
	expect(first).toContain("mine");
	expect(first).not.toContain("old");
	expect(await c.after(a, signal)).toBeUndefined();
	expect(await c.after(a, signal)).toBeUndefined();
	expect(await c.after(a, signal)).toContain("mine");
});

test("Claude's block and caps: 10 per file, 30 in all, 4,000 characters", () => {
	const text = render([err("bad type", "C:\\p\\src\\a.ts", 12)], CWD);
	expect(text).toBe(
		`<new-diagnostics>The following new diagnostic issues were detected:\n\n${"src\\a.ts"}:\n  ✘ [Line 12:1] bad type [TS1] (tsc)</new-diagnostics>`,
	);
	const many = (file: string, n: number) =>
		Array.from({ length: n }, (_, i) => err(`m${i}`, file));
	const lines = (t: string) => t.split("✘").length - 1;
	expect(lines(render(many(a, 15), CWD))).toBe(10);
	const files = ["a", "b", "c", "d"].flatMap((f) => many(`C:\\p\\${f}.ts`, 10));
	expect(lines(render(files, CWD))).toBe(30);
	const long = render([err("y".repeat(5000))], CWD);
	expect(long).toContain("…[truncated]");
	expect(long.length).toBeLessThan(4200);
});

test("only TypeScript files; off with the setting; no project skips", async () => {
	const { c, calls } = scripted([]);
	await c.before("C:\\p\\a.md", signal);
	expect(await c.after("C:\\p\\a.md", signal)).toBeUndefined();
	expect(calls()).toBe(0);

	let on = false;
	let runs = 0;
	const off = openChecker({
		cwd: CWD,
		cache: tempRoot(),
		enabled: () => on,
		find: () => ({ tsconfig: "t", tsc: "tsc" }),
		run: async () => {
			runs++;
			return { status: "ok", errors: [] };
		},
	});
	await off.before(a, signal);
	expect(await off.after(a, signal)).toBeUndefined();
	expect(runs).toBe(0);
	on = true;
	await off.before(a, signal);
	expect(runs).toBe(1);

	const none = openChecker({
		cwd: CWD,
		cache: tempRoot(),
		find: () => undefined,
	});
	await none.before(a, signal);
	expect(await none.after(a, signal)).toBeUndefined();
});

test("finding the project: nearest tsconfig inside it, tsc from there up", () => {
	const cwd = tempRoot();
	const dir = join(cwd, "pkg", "src");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "a.ts");
	expect(findProject(file, cwd)).toBeUndefined();
	writeFileSync(join(cwd, "pkg", "tsconfig.json"), "{}");
	expect(findProject(file, cwd)).toBeUndefined();
	const bin = join(cwd, "node_modules", ".bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "tsc.cmd"), "");
	expect(findProject(file, cwd)).toEqual({
		tsconfig: join(cwd, "pkg", "tsconfig.json"),
		tsc: join(bin, "tsc.cmd"),
	});
	expect(findProject(join(tempRoot(), "a.ts"), cwd)).toBeUndefined();
});

test("errors in read-denied files aren't shown", async () => {
	const secret = "C:\\p\\secret.ts";
	const c = openChecker({
		cwd: CWD,
		cache: tempRoot(),
		denied: (p) => (p === secret ? "rule" : undefined),
		find: () => ({ tsconfig: "t", tsc: "tsc" }),
		run: (() => {
			let n = 0;
			return async () =>
				n++ === 0
					? { status: "ok", errors: [] }
					: { status: "ok", errors: [err("hidden", secret), err("seen")] };
		})(),
	});
	await c.before(a, signal);
	const text = await c.after(a, signal);
	expect(text).toContain("seen");
	expect(text).not.toContain("hidden");
});

test("parallel edits share runs: one baseline, one report", async () => {
	let runs = 0;
	const c = openChecker({
		cwd: CWD,
		cache: tempRoot(),
		find: () => ({ tsconfig: "t", tsc: "tsc" }),
		run: async () => {
			const n = ++runs;
			await Bun.sleep(30);
			return { status: "ok", errors: n === 1 ? [] : [err("mine")] };
		},
	});
	await Promise.all([c.before(a, signal), c.before(a, signal)]);
	expect(runs).toBe(1);
	const results = await Promise.all([
		c.after(a, signal),
		c.after(a, signal),
		c.after(a, signal),
	]);
	// The first running; the others share one run after it.
	expect(runs).toBe(3);
	expect(results.filter(Boolean)).toHaveLength(1);
});

test("a timeout says so; three in a row turn checking off, said once", async () => {
	const { c, calls } = scripted([], "timeout", "timeout", "timeout");
	await c.before(a, signal);
	const note = "Type check timed out after 60 s; this edit wasn't checked.";
	expect(await c.after(a, signal)).toBe(note);
	expect(await c.after(a, signal)).toBe(note);
	expect(await c.after(a, signal)).toContain(
		"Checking is off for this session",
	);
	expect(calls()).toBe(4);
	await c.before(a, signal);
	expect(await c.after(a, signal)).toBeUndefined();
	expect(calls()).toBe(4);
});

test("a timed-out baseline leaves none, and the next edit tries again", async () => {
	const { c, calls } = scripted(
		"timeout",
		[err("old")],
		[err("old"), err("mine")],
	);
	await c.before(a, signal);
	expect(await c.after(a, signal)).toContain("timed out");
	await c.before(a, signal);
	expect(calls()).toBe(2);
	const text = await c.after(a, signal);
	expect(text).toContain("mine");
	expect(text).not.toContain("old");
});

test("tsc breaking leaves the baseline alone", async () => {
	const { c } = scripted([err("old")], "failed", [err("old"), err("mine")]);
	await c.before(a, signal);
	expect(await c.after(a, signal)).toBeUndefined();
	const text = await c.after(a, signal);
	expect(text).not.toContain("old");
	expect(text).toContain("mine");
});

test("the debug log holds metadata only", async () => {
	const logs = tempRoot();
	enableDebugLog(logs);
	const { c } = scripted([], [err("secret-message")]);
	await c.before(a, signal);
	await c.after(a, signal);
	disableDebugLog();
	const text = readdirSync(logs)
		.map((f) => readFileSync(join(logs, f), "utf8"))
		.join("");
	expect(text).toContain('"kind":"checker"');
	expect(text).not.toContain("secret-message");
	expect(text).not.toContain("tsconfig");
});

// Through callTool, the path every call takes.
const ctxOf = (cwd: string, more: Partial<ToolCtx> = {}): ToolCtx => ({
	signal,
	cwd,
	shell: { cwd },
	denied: () => undefined,
	reads: readRecord(),
	vault: new Vault(),
	backups: NO_BACKUPS,
	...more,
});
const fails = defineTool({
	name: "write",
	description: "x",
	checked: true,
	schema: Type.Object(
		{ file_path: Type.String() },
		{ additionalProperties: false },
	),
	deferred: false,
	readOnly: false,
	permission: { path: (i) => i.file_path },
	async run() {
		throw new Error("no disk");
	},
});

test("a failed edit runs no check; the block comes before hooks see the output", async () => {
	let afters = 0;
	const fake = {
		before: async () => {},
		after: async () => {
			afters++;
			return "<new-diagnostics>x</new-diagnostics>";
		},
	};
	const dir = tempRoot();
	const r = await callTool(
		buildRegistry([fails]),
		"write",
		JSON.stringify({ file_path: "a.ts" }),
		ctxOf(dir, { checker: fake }),
	);
	expect(r.status).toBe("error");
	expect(afters).toBe(0);

	const seen = join(dir, "seen.json");
	const script = join(dir, "h.js");
	writeFileSync(
		script,
		`require("fs").writeFileSync(${JSON.stringify(seen)}, await Bun.stdin.text())`,
	);
	const ok = defineTool({
		...fails,
		async run() {
			return "done";
		},
	});
	const vault = new Vault();
	const hooks = openHooks({
		settings: () => ({
			hooks: {
				PostToolUse: [
					{
						hooks: [
							{ type: "command", command: process.execPath, args: [script] },
						],
					},
				],
			},
		}),
		cwd: dir,
		here: () => dir,
		vault,
		sessionId: "s",
		transcript: "t",
		results: dir,
		mode: () => "manual",
		effort: () => undefined,
		notice: () => {},
		bash: null,
	});
	const done = await callTool(
		buildRegistry([ok]),
		"write",
		JSON.stringify({ file_path: "a.ts" }),
		ctxOf(dir, { checker: fake, hooks, vault }),
	);
	expect(done.output).toBe("done\n\n<new-diagnostics>x</new-diagnostics>");
	expect(JSON.parse(readFileSync(seen, "utf8")).tool_response).toContain(
		"<new-diagnostics>",
	);
});

// The real tsc, from this repo's node_modules through a junction. The junction
// goes in afterAll; rmdir takes the link, never what it points at.
const links: string[] = [];
afterAll(() => {
	for (const l of links) rmdirSync(l);
});
function realProject(files: Record<string, string>) {
	const cwd = tempRoot();
	const link = join(cwd, "node_modules");
	symlinkSync(resolve("node_modules"), link, "junction");
	links.push(link);
	writeFileSync(
		join(cwd, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: true, types: [], skipLibCheck: true },
			include: ["*.ts"],
		}),
	);
	for (const [f, text] of Object.entries(files))
		writeFileSync(join(cwd, f), text);
	const ctx = ctxOf(cwd, {
		checker: openChecker({ cwd, cache: join(cwd, ".cache") }),
	});
	const change = async (
		file_path: string,
		old_string: string,
		new_string: string,
	) => {
		const reg = buildRegistry([edit]);
		ctx.reads.set(join(cwd, file_path), {
			hash: new Bun.CryptoHasher("sha256")
				.update(readFileSync(join(cwd, file_path)))
				.digest("hex"),
			mtime: 0,
			offset: null,
			limit: null,
			partial: false,
		});
		return callTool(
			reg,
			"edit",
			JSON.stringify({ file_path, old_string, new_string, replace_all: null }),
			ctx,
		);
	};
	return { cwd, change };
}

test("the 3.8 check: a type error appears in the edit result, old ones don't", async () => {
	const p = realProject({
		"old.ts": "export const old: number = 'already broken';\n",
		"a.ts": "export const n: number = 1;\n",
	});
	const r = await p.change("a.ts", "= 1", "= 'two'");
	expect(r.status).toBe("ok");
	expect(r.output).toContain("has been updated");
	expect(r.output).toContain("<new-diagnostics>");
	expect(r.output).toContain("a.ts:");
	expect(r.output).toContain("[TS2322] (tsc)");
	expect(r.output).not.toContain("old.ts");
}, 120_000);

test("an edit that breaks another file reports it there", async () => {
	const p = realProject({
		"lib.ts": "export const f = (a: number) => a;\n",
		"use.ts": "import { f } from './lib';\nexport const x = f(1);\n",
	});
	const r = await p.change("lib.ts", "a: number", "a: string");
	expect(r.output).toContain("use.ts:");
	expect(r.output).not.toContain("lib.ts:");
}, 120_000);
