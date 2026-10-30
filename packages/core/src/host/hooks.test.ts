import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	call,
	fakeOpenAI,
	type Msg,
	say,
	tempRoot,
} from "../testing/fake-openai";
import { coreTools } from "../tools";
import { createHost } from "./host";

// Hooks end to end: settings → host → session → the fake model.

const fake = fakeOpenAI();
afterAll(fake.stop);
beforeEach(fake.reset);

function start() {
	const dir = tempRoot();
	const root = tempRoot();
	let n = 0;
	const script = (js: string) => {
		const file = join(dir, `h${++n}.js`);
		writeFileSync(file, js);
		return {
			type: "command" as const,
			command: process.execPath,
			args: [file],
		};
	};
	const hooks: Record<string, { matcher?: string; hooks: object[] }[]> = {};
	const on = (event: string, js: string, matcher?: string) => {
		hooks[event] ??= [];
		hooks[event].push({
			...(matcher && { matcher }),
			hooks: [script(js)],
		});
	};
	const out: Msg[] = [];
	const host = createHost((line) => out.push(JSON.parse(line)), {
		root,
		temp: join(root, "tmp"),
		tools: coreTools(null),
		settings: {
			current: {
				settings: { hooks } as never,
				rules: { allow: [], ask: [], deny: [] },
				warnings: [],
				files: [],
			},
			subscribe: () => () => {},
		},
	});
	let id = 0;
	const send = (type: string, data: object = {}) =>
		host.receive(
			JSON.stringify({ kind: "request", id: `r${++id}`, type, ...data }),
		);
	const waitFor = async (pred: () => boolean, ms = 20_000) => {
		for (const end = Date.now() + ms; !pred() && Date.now() < end; )
			await Bun.sleep(10);
		expect(pred()).toBe(true);
	};
	const events = (type: string) =>
		out.filter((m) => m.kind === "event" && m.type === type);
	const asked = () =>
		out.filter((m) => m.kind === "request" && m.type === "permission/request");
	const open = async () => {
		send("initialize", {
			client: { name: "t", version: "0" },
			capabilities: [],
		});
		send("session/new", { cwd: dir });
		await waitFor(() => events("session/started").length > 0);
	};
	const finished = (k = 1) =>
		waitFor(() => events("turn/finished").length >= k);
	return { dir, on, out, host, send, waitFor, events, asked, open, finished };
}
const writeFile = (file_path: string) =>
	call("write", { file_path, content: "x\n" });
const allowJson = (event: string, more = "") =>
	`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"${event}",permissionDecision:"allow"${more}}}))`;
const developer = (i: number) =>
	(fake.bodies[i].input as Msg[])
		.filter((m) => m.role === "developer")
		.map((m) => m.content)
		.join("\n");

test("a PreToolUse block leaves the file alone and tells the model", async () => {
	const c = start();
	c.on("PreToolUse", `console.error("frozen"); process.exit(2)`, "Write");
	await c.open();
	fake.replies.push({ items: [writeFile("a.txt")] }, say("ok"));
	c.send("session/prompt", { text: "go" });
	await c.finished();
	expect(existsSync(join(c.dir, "a.txt"))).toBe(false);
	expect(c.asked()).toHaveLength(0);
	const output = (fake.bodies[1].input as Msg[]).find(
		(m) => m.type === "function_call_output",
	);
	expect(output?.output).toContain("frozen");
});

test("a hook allow skips the default prompt, not an always-ask check", async () => {
	const c = start();
	c.on("PreToolUse", allowJson("PreToolUse"));
	await c.open();
	fake.replies.push(
		{ items: [writeFile("a.txt")] },
		{
			items: [
				call("powershell", {
					command: "Write-Output $(whoami)",
					description: null,
					timeout: null,
					run_in_background: null,
				}),
			],
		},
		say("ok"),
	);
	c.send("session/prompt", { text: "go" });
	await c.waitFor(() => c.asked().length === 1);
	expect(existsSync(join(c.dir, "a.txt"))).toBe(true);
	expect(c.asked()[0].tool).toBe("powershell");
	c.host.receive(
		JSON.stringify({
			kind: "response",
			id: c.asked()[0].id,
			ok: true,
			result: { decision: "reject" },
		}),
	);
});

test("a hook allow doesn't beat a protected path; a hook ask beats read-only", async () => {
	const c = start();
	c.on("PreToolUse", allowJson("PreToolUse"), "Write");
	c.on(
		"PreToolUse",
		`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"check me"}}))`,
		"Read",
	);
	writeFileSync(join(c.dir, "r.txt"), "r\n");
	await c.open();
	fake.replies.push({ items: [writeFile(".git/x")] });
	c.send("session/prompt", { text: "go" });
	await c.waitFor(() => c.asked().length === 1);
	expect(c.asked()[0].tool).toBe("write");
	fake.replies.push(
		{
			items: [call("read", { file_path: "r.txt", offset: null, limit: null })],
		},
		say("ok"),
	);
	c.host.receive(
		JSON.stringify({
			kind: "response",
			id: c.asked()[0].id,
			ok: true,
			result: { decision: "deny", message: "no" },
		}),
	);
	await c.waitFor(() => c.asked().length === 2);
	expect(c.asked()[1].reason).toBe("check me");
});

test("a PermissionRequest hook answering first withdraws the prompt", async () => {
	const c = start();
	c.on(
		"PermissionRequest",
		`await Bun.sleep(200);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"}}}))`,
	);
	await c.open();
	fake.replies.push({ items: [writeFile("a.txt")] }, say("ok"));
	c.send("session/prompt", { text: "go" });
	await c.waitFor(() => c.asked().length === 1);
	await c.finished();
	expect(existsSync(join(c.dir, "a.txt"))).toBe(true);
	expect(
		c.out.some((m) => m.kind === "cancel" && m.id === c.asked()[0].id),
	).toBe(true);
});

test("a PermissionRequest deny refuses; exit 2 is ignored; the user can answer first", async () => {
	const deny = start();
	deny.on(
		"PermissionRequest",
		`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"deny",message:"policy"}}}))`,
	);
	await deny.open();
	fake.replies.push({ items: [writeFile("a.txt")] }, say("ok"));
	deny.send("session/prompt", { text: "go" });
	await deny.finished();
	expect(existsSync(join(deny.dir, "a.txt"))).toBe(false);
	expect(JSON.stringify(fake.bodies[1].input)).toContain("policy");

	fake.reset();
	const c = start();
	c.on("PermissionRequest", "process.exit(2)");
	c.on("PermissionRequest", "await Bun.sleep(30000)");
	await c.open();
	fake.replies.push({ items: [writeFile("b.txt")] }, say("ok"));
	c.send("session/prompt", { text: "go" });
	await c.waitFor(() => c.asked().length === 1);
	await Bun.sleep(300);
	expect(c.out.some((m) => m.kind === "cancel")).toBe(false);
	c.host.receive(
		JSON.stringify({
			kind: "response",
			id: c.asked()[0].id,
			ok: true,
			result: { decision: "allow" },
		}),
	);
	await c.finished();
	expect(existsSync(join(c.dir, "b.txt"))).toBe(true);
});

test("a blocked prompt never reaches the model; context goes beside an allowed one", async () => {
	const c = start();
	c.on(
		"UserPromptSubmit",
		`const {prompt}=JSON.parse(await Bun.stdin.text());
		if(prompt==="bad"){console.error("not that");process.exit(2)}
		console.log("plain context")`,
	);
	await c.open();
	c.send("session/prompt", { text: "bad" });
	await c.waitFor(() => c.events("notice").some((n) => n.text === "not that"));
	await Bun.sleep(100);
	expect(fake.bodies).toHaveLength(0);
	expect(c.events("prompt/delivered")).toHaveLength(0);
	fake.replies.push(say("ok"));
	c.send("session/prompt", { text: "good" });
	await c.finished();
	expect(developer(0)).toContain("plain context");
	const roles = (fake.bodies[0].input as Msg[]).map((m) => m.role);
	expect(roles.at(-1)).toBe("user");
	expect(JSON.stringify(fake.bodies[0].input)).not.toContain('"bad"');
});

test("a Stop hook keeps the model going, with stop_hook_active, then lets it stop", async () => {
	const c = start();
	const seen = join(c.dir, "seen.txt");
	c.on(
		"Stop",
		`const j=JSON.parse(await Bun.stdin.text());
		require("fs").appendFileSync(${JSON.stringify(seen)}, j.stop_hook_active+":"+j.last_assistant_message+"\\n");
		if(!j.stop_hook_active){console.error("tests still fail");process.exit(2)}`,
	);
	await c.open();
	fake.replies.push(say("first"), say("second"));
	c.send("session/prompt", { text: "go" });
	await c.finished();
	expect(fake.bodies).toHaveLength(2);
	expect(developer(1)).toContain("tests still fail");
	expect(readFileSync(seen, "utf8")).toBe("false:first\ntrue:second\n");
});

test("Stop hooks stop at 8 in a row; a tool call resets the count", async () => {
	const c = start();
	c.on("Stop", `console.error("again");process.exit(2)`);
	await c.open();
	for (let i = 0; i < 12; i++) fake.replies.push(say(`r${i}`));
	c.send("session/prompt", { text: "go" });
	await c.finished();
	expect(fake.bodies).toHaveLength(9);

	fake.reset();
	const r = start();
	r.on("Stop", `console.error("again");process.exit(2)`);
	writeFileSync(join(r.dir, "r.txt"), "r\n");
	await r.open();
	for (let i = 0; i < 5; i++) fake.replies.push(say(`a${i}`));
	fake.replies.push({
		items: [call("read", { file_path: "r.txt", offset: null, limit: null })],
	});
	for (let i = 0; i < 12; i++) fake.replies.push(say(`b${i}`));
	r.send("session/prompt", { text: "go" });
	await r.finished();
	// 5 replies, the read, its reply, then 8 more continuations.
	expect(fake.bodies).toHaveLength(15);
}, 60_000);

test("Stop doesn't fire on an interrupt; StopFailure fires on an API error", async () => {
	const c = start();
	const stopped = join(c.dir, "stopped");
	const failed = join(c.dir, "failed");
	c.on("Stop", `require("fs").writeFileSync(${JSON.stringify(stopped)},"x")`);
	c.on(
		"StopFailure",
		`require("fs").writeFileSync(${JSON.stringify(failed)}, await Bun.stdin.text())`,
		"invalid_request",
	);
	await c.open();
	fake.replies.push({ text: "part", hold: true });
	c.send("session/prompt", { text: "go" });
	await c.waitFor(() => fake.bodies.length === 1);
	c.send("session/interrupt", {});
	await c.finished();
	await Bun.sleep(300);
	expect(existsSync(stopped)).toBe(false);

	fake.replies.push({ status: 400 });
	c.send("session/prompt", { text: "again" });
	await c.finished(2);
	expect(JSON.parse(readFileSync(failed, "utf8"))).toMatchObject({
		hook_event_name: "StopFailure",
		error: "invalid_request",
	});
	expect(existsSync(stopped)).toBe(false);
});

test("PostToolBatch runs once with the whole round and can end the loop", async () => {
	const c = start();
	writeFileSync(join(c.dir, "r.txt"), "r\n");
	const seen = join(c.dir, "seen.json");
	c.on(
		"PostToolBatch",
		`require("fs").writeFileSync(${JSON.stringify(seen)}, await Bun.stdin.text());
		console.log(JSON.stringify({decision:"block",reason:"round over"}))`,
	);
	await c.open();
	fake.replies.push({
		items: [
			call("read", { file_path: "r.txt", offset: null, limit: null }),
			call("glob", { pattern: "*.txt", path: null }),
		],
	});
	c.send("session/prompt", { text: "go" });
	await c.finished();
	expect(fake.bodies).toHaveLength(1);
	const j = JSON.parse(readFileSync(seen, "utf8"));
	expect(j.tool_calls.map((t: Msg) => t.tool_name)).toEqual(["Read", "Glob"]);
	expect(j.tool_calls[0].tool_response).toContain("r");
});

test("SessionStart context reaches the first request; SessionEnd runs on close", async () => {
	const c = start();
	const ended = join(c.dir, "ended.json");
	c.on(
		"SessionStart",
		`const j=JSON.parse(await Bun.stdin.text());console.log("started "+j.source)`,
		"startup",
	);
	c.on("SessionStart", `console.log("never")`, "resume");
	c.on(
		"SessionEnd",
		`require("fs").writeFileSync(${JSON.stringify(ended)}, await Bun.stdin.text())`,
	);
	await c.open();
	fake.replies.push(say("ok"));
	c.send("session/prompt", { text: "go" });
	await c.finished();
	expect(developer(0)).toContain("started startup");
	expect(developer(0)).not.toContain("never");
	await c.host.close("prompt_input_exit");
	expect(JSON.parse(readFileSync(ended, "utf8")).reason).toBe(
		"prompt_input_exit",
	);
});

test("SessionEnd gets a short budget", async () => {
	const c = start();
	c.on("SessionEnd", "await Bun.sleep(30000)");
	await c.open();
	const at = Date.now();
	await c.host.close();
	expect(Date.now() - at).toBeLessThan(8000);
}, 30_000);
