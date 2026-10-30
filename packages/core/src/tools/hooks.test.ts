import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Type from "typebox";
import type { Settings } from "../config/settings";
import { loadSettings } from "../config/settings";
import { disableDebugLog, enableDebugLog } from "../log/debug";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { NO_BACKUPS } from "./backups";
import { errorKind, matcherHits, openHooks } from "./hooks";
import { readRecord } from "./reads";
import { buildRegistry, callTool, defineTool, type ToolCtx } from "./registry";

// A hook is a small script run directly (`args`), so no shell is involved.
function setup(extra: Partial<Parameters<typeof openHooks>[0]> = {}) {
	const dir = tempRoot();
	let n = 0;
	const handler = (js: string, more: object = {}) => {
		const file = join(dir, `h${++n}.js`);
		writeFileSync(file, js);
		return {
			type: "command" as const,
			command: process.execPath,
			args: [file],
			...more,
		};
	};
	const settings: Settings = {};
	const notices: string[] = [];
	const vault = new Vault();
	const hooks = openHooks({
		settings: () => settings,
		cwd: dir,
		here: () => dir,
		vault,
		sessionId: "s1",
		transcript: join(dir, "t.jsonl"),
		results: join(dir, "results"),
		mode: () => "manual",
		effort: () => undefined,
		notice: (_l, t) => notices.push(t),
		bash: "C:\\fake\\bash.exe",
		...extra,
	});
	const on = (
		event: string,
		js: string,
		more: object = {},
		matcher?: string,
	) => {
		settings.hooks ??= {};
		settings.hooks[event] ??= [];
		settings.hooks[event].push({
			...(matcher !== undefined && { matcher }),
			hooks: [handler(js, more)],
		});
	};
	return { dir, settings, notices, vault, hooks, on, handler };
}
const tool = defineTool({
	name: "write",
	description: "x",
	schema: Type.Object(
		{ file_path: Type.String() },
		{ additionalProperties: false },
	),
	deferred: false,
	readOnly: false,
	permission: { path: (i) => i.file_path },
	async run(i) {
		if (i.file_path === "boom") throw new Error("it broke");
		return `ran ${i.file_path}`;
	},
});
const input = { file_path: "a.txt" };

test("matchers: all, an exact list, a regular expression", () => {
	for (const m of [undefined, "", "*"])
		expect(matcherHits(m, "Edit")).toBe(true);
	expect(matcherHits("Edit|Write", "Write")).toBe(true);
	expect(matcherHits("Edit, Write", "Write")).toBe(true);
	expect(matcherHits("Edit", "EditX")).toBe(false);
	expect(matcherHits("edit", "Edit")).toBe(false);
	expect(matcherHits("^Web.*", "WebFetch")).toBe(true);
	expect(matcherHits("(bad", "x")).toBe(false);
});

test("exit 2 blocks with stderr, and beats a JSON allow", async () => {
	const h = setup();
	h.on(
		"PreToolUse",
		`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}));
		console.error("no way"); process.exit(2);`,
	);
	const r = await h.hooks.pre(tool, input, "c1");
	expect(r.deny).toContain("PreToolUse:Write hook error: [");
	expect(r.deny).toContain("]: no way");
});

test("deny beats ask beats allow; all contexts are kept; a matcher filters", async () => {
	const out = (d: string, c: string) =>
		`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"${d}",permissionDecisionReason:"${d} why",additionalContext:"${c}"}}))`;
	const h = setup();
	h.on("PreToolUse", out("allow", "one"));
	h.on("PreToolUse", out("ask", "two"));
	let r = await h.hooks.pre(tool, input, "c1");
	expect(r).toMatchObject({ decision: "ask", reason: "ask why" });
	expect(r.context?.split("\n").sort()).toEqual(["one", "two"]);
	h.on("PreToolUse", out("deny", "three"), {}, "Write");
	h.on("PreToolUse", "process.exit(2)", {}, "Edit");
	r = await h.hooks.pre(tool, input, "c1");
	expect(r.deny).toBe("deny why");
});

test("only a single JSON object counts; plain text and other exit codes don't decide", async () => {
	const h = setup();
	h.on(
		"PreToolUse",
		`console.log('note {"hookSpecificOutput":{"permissionDecision":"deny"}}')`,
	);
	h.on(
		"PreToolUse",
		`console.log('{"hookSpecificOutput":{"permissionDecision":"deny"}}')`,
	); // no hookEventName
	h.on("PreToolUse", `console.error("broke\\nmore"); process.exit(3)`);
	const r = await h.hooks.pre(tool, input, "c1");
	expect(r.deny).toBeUndefined();
	expect(r.decision).toBeUndefined();
	expect(h.notices).toEqual([
		"PreToolUse:Write hook error: Failed with non-blocking status code: broke",
	]);
});

test("a failure blocks only with onFailure, or without Git Bash", async () => {
	const h = setup();
	h.on("PreToolUse", "process.exit(3)", { onFailure: "block" });
	expect((await h.hooks.pre(tool, input, "c")).deny).toContain(
		'failed; blocking because onFailure is "block"',
	);
	const none = setup({ bash: null });
	none.on("PreToolUse", "process.exit(3)");
	expect((await none.hooks.pre(tool, input, "c")).deny).toContain(
		"blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict.",
	);
	// Only on Pre and PermissionRequest: elsewhere it stays a notice.
	none.on("PostToolUse", "process.exit(3)");
	const post = await none.hooks.post(tool, input, "c", "out", 1);
	expect(post.notes).toEqual([]);
	expect(none.notices).toHaveLength(1);
});

test("a timeout doesn't block unless onFailure says so, and the hook is killed", async () => {
	const h = setup();
	h.on("PreToolUse", "await Bun.sleep(30000)", { timeout: 0.3 });
	const started = Date.now();
	expect((await h.hooks.pre(tool, input, "c")).deny).toBeUndefined();
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(h.notices[0]).toContain("timed out");
	const b = setup();
	b.on("PreToolUse", "await Bun.sleep(30000)", {
		timeout: 0.3,
		onFailure: "block",
	});
	expect((await b.hooks.pre(tool, input, "c")).deny).toContain(
		'timed out; blocking because onFailure is "block"',
	);
}, 30_000);

test("identical hooks run once, others in parallel", async () => {
	const h = setup();
	const log = join(h.dir, "log.txt");
	const one = h.handler(
		`require("fs").appendFileSync(${JSON.stringify(log)},"x"); await Bun.sleep(600);`,
	);
	const two = h.handler("await Bun.sleep(600);");
	h.settings.hooks = {
		PreToolUse: [{ hooks: [one, two] }, { matcher: "Write", hooks: [one] }],
	};
	const started = Date.now();
	await h.hooks.pre(tool, input, "c");
	expect(readFileSync(log, "utf8")).toBe("x");
	expect(Date.now() - started).toBeLessThan(1150);
});

test("if: one rule filters; disableAllHooks turns everything off", async () => {
	const h = setup();
	h.on("PreToolUse", "process.exit(2)", { if: "Write(*.ts)" });
	expect((await h.hooks.pre(tool, input, "c")).deny).toBeUndefined();
	expect(
		(await h.hooks.pre(tool, { file_path: "a.ts" }, "c")).deny,
	).toBeDefined();
	h.settings.disableAllHooks = true;
	expect(
		(await h.hooks.pre(tool, { file_path: "a.ts" }, "c")).deny,
	).toBeUndefined();
});

test("hooks get placeholders: secrets are scrubbed on stdin, in Claude's fields", async () => {
	const h = setup();
	const key = `sk-${"a1B2".repeat(12)}`;
	h.vault.add("env", key);
	const seen = join(h.dir, "seen.json");
	h.on(
		"PostToolUse",
		`require("fs").writeFileSync(${JSON.stringify(seen)}, await Bun.stdin.text())`,
	);
	await h.hooks.post(tool, { file_path: key }, "c1", `value ${key}`, 12);
	const text = readFileSync(seen, "utf8");
	expect(text).not.toContain(key);
	const j = JSON.parse(text);
	expect(j).toMatchObject({
		session_id: "s1",
		permission_mode: "default",
		hook_event_name: "PostToolUse",
		tool_name: "Write",
		tool_use_id: "c1",
		duration_ms: 12,
	});
	expect(j.tool_response).toContain("[REDACTED:");
	expect(j.cwd).toBe(h.dir);
});

test("file_path is absolute on stdin", async () => {
	const h = setup();
	const seen = join(h.dir, "seen.json");
	h.on(
		"PreToolUse",
		`require("fs").writeFileSync(${JSON.stringify(seen)}, await Bun.stdin.text())`,
	);
	await h.hooks.pre(tool, input, "c1");
	expect(JSON.parse(readFileSync(seen, "utf8")).tool_input.file_path).toBe(
		join(h.dir, "a.txt"),
	);
});

test("the debug log holds metadata only", async () => {
	const h = setup();
	const logs = tempRoot();
	enableDebugLog(logs);
	h.on("PreToolUse", `console.log("hook-output-text"); console.error("x")`);
	await h.hooks.pre(tool, input, "c1");
	disableDebugLog();
	const text = readdirSync(logs)
		.map((f) => readFileSync(join(logs, f), "utf8"))
		.join("");
	expect(text).toContain('"kind":"hook"');
	expect(text).not.toContain("hook-output-text");
	expect(text).not.toContain(h.dir.replaceAll("\\", "\\\\"));
});

test("context over 10,000 characters goes to a file with a preview", async () => {
	const h = setup();
	h.on(
		"PostToolUse",
		`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"y".repeat(11000)}}))`,
	);
	const r = await h.hooks.post(tool, input, "c", "out", 1);
	expect(r.notes[0]).toContain("<persisted-output>");
	expect(r.notes[0].length).toBeLessThan(3000);
	expect(existsSync(join(h.dir, "results"))).toBe(true);
});

test("systemMessage is a notice", async () => {
	const h = setup();
	h.on("PreToolUse", `console.log(JSON.stringify({systemMessage:"look out"}))`);
	await h.hooks.pre(tool, input, "c");
	expect(h.notices).toEqual(["look out"]);
});

// Through callTool, the path every call takes.
function ctxOf(h: ReturnType<typeof setup>): ToolCtx {
	return {
		signal: new AbortController().signal,
		cwd: h.dir,
		shell: { cwd: h.dir },
		denied: () => undefined,
		reads: readRecord(),
		vault: h.vault,
		backups: NO_BACKUPS,
		hooks: h.hooks,
	};
}
const callIt = (h: ReturnType<typeof setup>, args: object) =>
	callTool(
		buildRegistry([tool]),
		"write",
		JSON.stringify(args),
		ctxOf(h),
		undefined,
		"c1",
	);

test("the 3.7 check: a hook can block a tool", async () => {
	const h = setup();
	h.on("PreToolUse", `console.error("not this file"); process.exit(2)`);
	const r = await callIt(h, input);
	expect(r.status).toBe("denied");
	expect(r.output).toContain("not this file");
	expect(r.output).not.toContain("ran a.txt");
});

test("updatedInput replaces the input and is checked like the model's", async () => {
	const h = setup();
	h.on(
		"PreToolUse",
		`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:{file_path:"b.txt"}}}))`,
	);
	expect((await callIt(h, input)).output).toBe("ran b.txt");
	const bad = setup();
	bad.on(
		"PreToolUse",
		`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:{nope:1}}}))`,
	);
	const r = await callIt(bad, input);
	expect(r.status).toBe("error");
	expect(r.output).toContain("invalid input");
});

test("Post adds context and can replace the output; a failure fires its own event", async () => {
	const h = setup();
	h.on(
		"PostToolUse",
		`console.log(JSON.stringify({decision:"block",reason:"lint failed",hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"more",updatedToolOutput:"swapped"}}))`,
	);
	expect((await callIt(h, input)).output).toBe(
		"swapped\n\nlint failed\n\nmore",
	);

	const f = setup();
	const seen = join(f.dir, "seen.json");
	f.on("PostToolUse", "process.exit(2)");
	f.on(
		"PostToolUseFailure",
		`require("fs").writeFileSync(${JSON.stringify(seen)}, await Bun.stdin.text());
		console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUseFailure",additionalContext:"try again"}}))`,
	);
	const r = await callIt(f, { file_path: "boom" });
	expect(r.status).toBe("error");
	expect(r.output).toBe("error: it broke\n\ntry again");
	expect(JSON.parse(readFileSync(seen, "utf8"))).toMatchObject({
		error: "it broke",
		is_interrupt: false,
		tool_name: "Write",
	});
});

test("exit 2 on PostToolUse shows stderr; the tool already ran", async () => {
	const h = setup();
	h.on("PostToolUse", `console.error("too late"); process.exit(2)`);
	const r = await callIt(h, input);
	expect(r.status).toBe("ok");
	expect(r.output).toContain("ran a.txt");
	expect(r.output).toContain("too late");
});

test("continue: false stops the turn", async () => {
	const h = setup();
	h.on(
		"PostToolUse",
		`console.log(JSON.stringify({continue:false,stopReason:"enough"}))`,
	);
	const r = await callIt(h, input);
	expect(r.stop).toBe(true);
	expect(r.output).toContain("enough");
	const pre = setup();
	pre.on(
		"PreToolUse",
		`console.log(JSON.stringify({continue:false,stopReason:"halt"}))`,
	);
	const p = await callIt(pre, input);
	expect(p).toMatchObject({ status: "denied", stop: true });
	expect(p.output).toContain("halt");
});

test("OpenAI errors map to Claude's StopFailure values", () => {
	expect(errorKind({ status: 429 })).toBe("rate_limit");
	expect(errorKind({ status: 401 })).toBe("authentication_failed");
	expect(errorKind({ status: 404 })).toBe("model_not_found");
	expect(errorKind({ status: 400 })).toBe("invalid_request");
	expect(errorKind({ status: 503 })).toBe("server_error");
	expect(errorKind(new Error("x"))).toBe("unknown");
});

test("settings: a bad hook warns and goes, the good ones stay and lists merge", () => {
	const home = tempRoot();
	const cwd = tempRoot();
	const write = (root: string, hooks: object) => {
		const dir = join(root, ".manas");
		Bun.spawnSync(["cmd", "/c", "mkdir", dir]);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks }));
	};
	const good = { type: "command" as const, command: "a" };
	write(home, { PreToolUse: [{ hooks: [good] }] });
	write(cwd, {
		PreToolUse: [
			{
				matcher: "Edit",
				hooks: [
					{ type: "command", command: "b" },
					{ type: "http", url: "x" },
					{ type: "command", command: "c", async: true },
				],
			},
		],
		Stop: [{ hooks: [{ type: "command", command: "d", if: "Edit(*)" }] }],
		Nope: [],
	});
	const { settings, warnings } = loadSettings({ cwd, home });
	expect(settings.hooks?.PreToolUse).toEqual([
		{ hooks: [good] },
		{ matcher: "Edit", hooks: [{ type: "command", command: "b" }] },
	]);
	expect(settings.hooks?.Stop).toBeUndefined();
	expect(warnings.join("\n")).toContain("not an event Manas fires");
	expect(warnings.join("\n")).toContain('"if" only works on tool events');
	expect(warnings.filter((w) => w.includes("hooks.PreToolUse"))).toHaveLength(
		2,
	);
});
