import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Type from "typebox";
import { type Loaded, projectFile } from "../config/settings";
import { findSession, projectDir } from "../session/store";
import {
	call,
	fakeOpenAI,
	type Msg,
	say,
	tempRoot,
} from "../testing/fake-openai";
import { coreTools } from "../tools";
import { defineTool } from "../tools/registry";
import { createHost } from "./host";

const fake = fakeOpenAI();
afterAll(fake.stop);
beforeEach(fake.reset);

// A front end on a fake transport: everything the host sends lands in `out`.
function connect(
	root = tempRoot(),
	extra: Omit<Parameters<typeof createHost>[1] & {}, "root"> = {},
) {
	const out: Msg[] = [];
	const host = createHost((line) => out.push(JSON.parse(line)), {
		root,
		...extra,
	});
	let n = 0;
	const send = (type: string, data: object = {}) => {
		const id = `r${++n}`;
		host.receive(JSON.stringify({ kind: "request", id, type, ...data }));
		return out.find((m) => m.kind === "response" && m.id === id) as Msg;
	};
	const waitFor = async (pred: () => boolean) => {
		for (let i = 0; i < 400 && !pred(); i++) await Bun.sleep(5);
		expect(pred()).toBe(true);
	};
	const events = (type?: string) =>
		out.filter((m) => m.kind === "event" && (!type || m.type === type));
	const states = () => events("state/changed").map((e) => e.state);
	const ready = async (cwd = "E:\\x") => {
		send("initialize", {
			client: { name: "test", version: "0" },
			capabilities: [],
		});
		const r = send("session/new", { cwd });
		await waitFor(() => events("session/started").length > 0);
		return r;
	};
	return { host, out, send, waitFor, events, states, ready };
}
const error = (code: string) =>
	expect.objectContaining({
		ok: false,
		error: expect.objectContaining({ code }),
	});

test("errors come back as responses, never a crash", async () => {
	const { send, ready } = connect();
	expect(send("session/new", { cwd: "." })).toEqual(error("not_initialized"));
	expect(send("nope")).toEqual(error("unknown_type"));
	expect(send("initialize", { client: "x" })).toEqual(error("invalid_request"));
	send("initialize", { client: { name: "t", version: "0" }, capabilities: [] });
	expect(send("session/prompt", { text: "hi" })).toEqual(error("no_session"));
	expect(send("session/new", { cwd: ".", effort: "minimal" })).toEqual(
		error("invalid_params"),
	);
	expect(send("session/new", { cwd: ".", model: "nope" })).toEqual(
		error("invalid_params"),
	);
	await ready();
	expect(send("session/new", { cwd: "." })).toEqual(error("session_exists"));
	expect(send("session/prompt", { text: 5 })).toEqual(error("invalid_request"));
});

test("bad lines get a notice; unknown fields are ignored", () => {
	const { host, out, send } = connect();
	host.receive("{not json");
	host.receive(JSON.stringify({ kind: "request", type: "initialize" }));
	host.receive(JSON.stringify({ kind: "weird" }));
	expect(out.map((m) => m.type)).toEqual(["notice", "notice", "notice"]);
	const r = send("initialize", {
		client: { name: "t", version: "0", extra: 1 },
		capabilities: [],
		future: true,
	});
	expect(r).toEqual({
		kind: "response",
		id: expect.any(String),
		ok: true,
		result: { protocol_version: 1, capabilities: [] },
	});
});

test("a prompt streams events with seq, then goes idle", async () => {
	const { send, events, states, waitFor, ready } = connect();
	fake.replies.push(say("hello"));
	const { result } = await ready();
	expect(send("session/prompt", { text: "hi" })).toMatchObject({
		ok: true,
		result: { prompt_id: "p1" },
	});
	await waitFor(() => states().at(-1) === "idle" && states().length > 2);
	const all = events();
	expect(all.map((e) => e.type)).toEqual([
		"session/started",
		"state/changed",
		"state/changed",
		"prompt/delivered",
		"message/delta",
		"message/done",
		"turn/finished",
		"state/changed",
	]);
	expect(states()).toEqual(["idle", "running", "idle"]);
	expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
	expect(
		all.every(
			(e) => e.session_id === result.session_id && e.parent_id === null,
		),
	).toBe(true);
	expect(events("turn/finished")[0]).toMatchObject({
		turn_id: "t1",
		stop_reason: "done",
	});
});

test("a core request resolves with the front end's response", async () => {
	const { host, out, states, ready } = connect();
	await ready();
	const answer = host.request("test/ask", { q: 1 });
	const req = out.at(-2);
	expect(req).toMatchObject({
		kind: "request",
		id: "c1",
		type: "test/ask",
		q: 1,
	});
	expect(states().at(-1)).toBe("waiting_for_user");
	host.receive(
		JSON.stringify({ kind: "response", id: "c1", ok: true, result: { a: 2 } }),
	);
	expect(await answer).toEqual({ a: 2 });
	expect(states().at(-1)).toBe("idle");
});

test("an interrupt cancels pending core requests and returns the queue", async () => {
	const { host, out, send, states, waitFor, ready } = connect();
	fake.replies.push({ text: "long…", hold: true });
	await ready();
	send("session/prompt", { text: "write a lot" });
	// The held reply must be taken by this turn, not the queued one.
	await waitFor(() => fake.bodies.length === 1);
	const answer = host.request("test/ask", {});
	expect(states().at(-1)).toBe("waiting_for_user");
	const queued = send("session/prompt", { text: "then", priority: "later" })
		.result.prompt_id;
	fake.replies.push(say("ok"));
	expect(send("session/interrupt")).toMatchObject({
		ok: true,
		result: { still_queued: [queued] },
	});
	expect(out).toContainEqual({
		kind: "cancel",
		id: "c1",
		reason: "interrupted",
	});
	await expect(answer).rejects.toThrow("cancelled");
	await waitFor(() => states().at(-1) === "idle");
	expect(states()).toEqual([
		"idle",
		"running",
		"waiting_for_user",
		"running",
		"idle",
	]);
	// A late answer or a cancel for an unknown id is ignored.
	host.receive(
		JSON.stringify({ kind: "response", id: "c1", ok: true, result: null }),
	);
	host.receive(JSON.stringify({ kind: "cancel", id: "r999" }));
	expect(out.filter((m) => m.type === "notice")).toEqual([]);
});

test("set_model and set_effort answer with the new state; bad values are invalid_params", async () => {
	const { send, events, ready } = connect();
	await ready();
	expect(send("session/set_model", { model: "gpt-4o-mini" })).toMatchObject({
		ok: true,
		result: { model: "gpt-4o-mini", effort: null },
	});
	expect(send("session/set_model", { model: "nope" })).toEqual(
		error("invalid_params"),
	);
	expect(
		send("session/set_model", { model: "gpt-4o-mini", role: "cheap" }),
	).toEqual(error("invalid_request"));
	send("session/set_model", { model: "gpt-5.6-luna" });
	expect(send("session/set_effort", { effort: "high" })).toMatchObject({
		ok: true,
		result: { model: "gpt-5.6-luna", effort: "high" },
	});
	expect(send("session/set_effort", { effort: "minimal" })).toEqual(
		error("invalid_params"),
	);
	expect(send("session/set_effort", { effort: null }).result).toEqual({
		model: "gpt-5.6-luna",
		effort: null,
	});
	send("session/set_effort", { effort: null });
	expect(events("notice").map((e) => e.text)).toEqual([
		"Already using effort default.",
	]);
});

test("sessions are saved, listed and resumed with a replay", async () => {
	const root = tempRoot();
	const a = connect(root);
	fake.replies.push(say("hello"));
	const { result } = await a.ready();
	a.send("session/prompt", { text: "hi" });
	await a.waitFor(() => a.states().at(-1) === "idle" && a.states().length > 2);
	a.send("session/set_model", { model: "gpt-4o-mini" });

	const b = connect(root);
	b.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: [],
	});
	expect(b.send("sessions/list", { cwd: "E:\\x" }).result.sessions).toEqual([
		{
			session_id: result.session_id,
			title: "hi",
			updated: expect.any(String),
			messages: 2,
		},
	]);
	expect(
		b.send("session/resume", { session_id: "nope", cwd: "E:\\x" }),
	).toEqual(error("not_found"));
	expect(
		b.send("session/resume", { session_id: result.session_id, cwd: "E:\\x" }),
	).toMatchObject({
		ok: true,
		result: { session_id: result.session_id },
	});
	await b.waitFor(() => b.states().length > 0);
	expect(b.events().map((e) => [e.type, e.replay ?? false])).toEqual([
		["session/started", false],
		["prompt/delivered", true],
		["message/done", true],
		["state/changed", false],
	]);
	expect(b.events("session/started")[0]).toMatchObject({
		model: "gpt-4o-mini",
		session_id: result.session_id,
	});
	expect(
		b.send("session/resume", { session_id: result.session_id, cwd: "E:\\x" }),
	).toEqual(error("session_exists"));
});

// Settings the test controls: `reload` swaps them, `fail` reports a broken file.
function fakeSettings(current: Partial<Loaded> = {}) {
	const listeners = new Set<(e: { ok: boolean; error?: string }) => void>();
	const src = {
		current: {
			settings: {},
			rules: { allow: [], ask: [], deny: [] },
			warnings: [],
			files: [],
			...current,
		} as Loaded,
		subscribe(l: (e: { ok: boolean; error?: string }) => void) {
			listeners.add(l);
			return () => {
				listeners.delete(l);
			};
		},
		reload(next: Partial<Loaded>) {
			src.current = { ...src.current, ...next };
			for (const l of listeners) l({ ok: true });
		},
		fail(error: string) {
			for (const l of listeners) l({ ok: false, error });
		},
	};
	return src;
}
const tool = (name: string) =>
	defineTool({
		name,
		description: name,
		schema: Type.Object({}, { additionalProperties: false }),
		deferred: false,
		readOnly: true,
		run: async () => `${name} ran`,
	});
const tools = [tool("read"), tool("lsp")];
const rules = (deny: string[]) => ({
	rules: {
		allow: [],
		ask: [],
		deny: deny.map((text) => ({ text, base: "." })),
	},
});

test("a bare deny at start removes the tool from the list", async () => {
	const c = connect(undefined, {
		tools,
		settings: fakeSettings(rules(["Read"])),
	});
	fake.replies.push(say("ok"));
	await c.ready();
	expect(c.events("session/started")[0].tools).toEqual(["lsp"]);
	c.send("session/prompt", { text: "hi" });
	await c.waitFor(() => c.states().at(-1) === "idle" && c.states().length > 2);
	expect(
		(fake.bodies[0].tools as { name: string }[]).map((t) => t.name),
	).toEqual(["lsp"]);
});

test("a deny added mid-session keeps the list but refuses the call", async () => {
	const settings = fakeSettings();
	const c = connect(undefined, { tools, settings });
	await c.ready();
	expect(c.events("session/started")[0].tools).toEqual(["read", "lsp"]);
	settings.reload(rules(["Read"]));
	expect(c.events("notice").at(-1)).toMatchObject({
		level: "info",
		text: "Settings reloaded.",
	});
	fake.replies.push(
		{ items: [call("read", {}), call("lsp", {})] },
		say("done"),
	);
	c.send("session/prompt", { text: "go" });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("tool/finished").map((e) => [e.status, e.output])).toEqual([
		["denied", "error: denied by your settings (Read)"],
		["ok", "lsp ran"],
	]);
	expect(
		(fake.bodies[1].tools as { name: string }[]).map((t) => t.name),
	).toEqual(["read", "lsp"]);
});

test("a broken reload is reported, and the old rules still apply", async () => {
	const settings = fakeSettings();
	const c = connect(undefined, { tools, settings });
	await c.ready();
	settings.reload(rules(["Read"]));
	settings.fail("settings x line 2: JSONC Parse error");
	expect(c.events("notice").at(-1)).toMatchObject({
		level: "error",
		text: "Settings not reloaded: settings x line 2: JSONC Parse error Keeping the last good settings.",
	});
	fake.replies.push({ items: [call("read", {})] }, say("done"));
	c.send("session/prompt", { text: "go" });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("tool/finished")[0].status).toBe("denied");
});

test("settings give the model and effort; bad ones and warnings become notices", async () => {
	const a = connect(undefined, {
		settings: fakeSettings({
			settings: { models: { main: "gpt-4o-mini" }, effort: "high" },
			warnings: ['settings x: unknown key "colour" (ignored)'],
		}),
	});
	await a.ready();
	expect(a.events("session/started")[0]).toMatchObject({
		model: "gpt-4o-mini",
		effort: "high",
	});
	expect(a.events("notice").map((e) => e.text)).toEqual([
		'settings x: unknown key "colour" (ignored)',
	]);

	const b = connect(undefined, {
		settings: fakeSettings({
			settings: { models: { main: "nope" }, effort: "minimal" },
		}),
	});
	await b.ready();
	expect(b.events("session/started")[0]).toMatchObject({
		model: "gpt-5.6-luna",
		effort: null,
	});
	expect(b.events("notice").map((e) => e.text)).toEqual([
		'settings: unknown model "nope" (ignored)',
		expect.stringContaining('settings: effort "minimal" not supported'),
	]);
});

// A shell that only echoes, so approvals are tested without running anything.
const powershell = defineTool({
	name: "powershell",
	description: "ps",
	schema: Type.Object(
		{ command: Type.String() },
		{ additionalProperties: false },
	),
	deferred: false,
	readOnly: false,
	permission: { command: (i) => i.command },
	run: async ({ command }) => `ran: ${command}`,
});
const ps = (command: string) => ({ items: [call("powershell", { command })] });
const answer = (c: ReturnType<typeof connect>, id: string, result: object) =>
	c.host.receive(JSON.stringify({ kind: "response", id, ok: true, result }));
const asked = (c: ReturnType<typeof connect>) =>
	c.out.filter((m) => m.kind === "request" && m.type === "permission/request");

test("the 1.7 check: Get-ChildItem runs; Remove-Item asks", async () => {
	const c = connect(undefined, { tools: [powershell] });
	await c.ready();
	fake.replies.push(
		ps("Get-ChildItem"),
		say("listed"),
		ps("Remove-Item x"),
		say("deleted"),
	);
	c.send("session/prompt", { text: "list" });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("tool/finished")[0]).toMatchObject({
		status: "ok",
		output: "ran: Get-ChildItem",
	});
	expect(asked(c)).toEqual([]);

	c.send("session/prompt", { text: "delete x" });
	await c.waitFor(() => asked(c).length === 1);
	expect(asked(c)[0]).toMatchObject({
		tool: "powershell",
		input: { command: "Remove-Item x" },
		title: "run: Remove-Item x",
		reason: "this command can change things",
		suggestions: [
			{ rules: ["PowerShell(Remove-Item *)"], destination: "project" },
		],
	});
	expect(c.states().at(-1)).toBe("waiting_for_user");
	answer(c, asked(c)[0].id, { decision: "allow" });
	await c.waitFor(() => c.events("turn/finished").length === 2);
	expect(c.events("tool/finished")[1]).toMatchObject({
		status: "ok",
		output: "ran: Remove-Item x",
	});
});

test("Yes for this session: the same kind of command doesn't ask again", async () => {
	const c = connect(undefined, { tools: [powershell] });
	await c.ready();
	fake.replies.push(
		ps("Remove-Item a"),
		say("ok"),
		ps("Remove-Item b"),
		say("ok"),
	);
	c.send("session/prompt", { text: "1" });
	await c.waitFor(() => asked(c).length === 1);
	// An editor may pick the destination; "session" saves nothing.
	answer(c, asked(c)[0].id, {
		decision: "allow_always",
		suggestion: {
			rules: ["PowerShell(Remove-Item *)"],
			destination: "session",
		},
	});
	await c.waitFor(() => c.events("turn/finished").length === 1);
	c.send("session/prompt", { text: "2" });
	await c.waitFor(() => c.events("turn/finished").length === 2);
	expect(asked(c)).toHaveLength(1);
	expect(c.events("tool/finished").map((e) => e.status)).toEqual(["ok", "ok"]);
});

test("No with a reason: the model is told and goes on", async () => {
	const c = connect(undefined, { tools: [powershell] });
	await c.ready();
	fake.replies.push(ps("Remove-Item x"), say("ok, moving it instead"));
	c.send("session/prompt", { text: "delete x" });
	await c.waitFor(() => asked(c).length === 1);
	answer(c, asked(c)[0].id, {
		decision: "deny",
		message: "move it to old/ instead",
	});
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("tool/finished")[0]).toMatchObject({
		status: "denied",
		output: "error: denied by the user: move it to old/ instead",
	});
	expect(c.events("turn/finished")[0].stop_reason).toBe("done");
	expect(fake.bodies).toHaveLength(2);
});

test("a plain No stops the turn; a queued prompt still runs", async () => {
	const c = connect(undefined, { tools: [powershell] });
	await c.ready();
	fake.replies.push(ps("Remove-Item x"), say("next one"));
	c.send("session/prompt", { text: "delete x" });
	await c.waitFor(() => asked(c).length === 1);
	c.send("session/prompt", { text: "then this", priority: "later" });
	answer(c, asked(c)[0].id, { decision: "deny" });
	await c.waitFor(() => c.events("turn/finished").length === 2);
	expect(c.events("tool/finished")[0]).toMatchObject({
		status: "denied",
		output: "error: denied by the user",
	});
	expect(c.events("turn/finished").map((e) => e.stop_reason)).toEqual([
		"interrupted",
		"done",
	]);
	expect(fake.bodies).toHaveLength(2);
});

test("interrupt while asking cancels the request; a bad answer counts as no", async () => {
	const a = connect(undefined, { tools: [powershell] });
	await a.ready();
	fake.replies.push(ps("Remove-Item x"));
	a.send("session/prompt", { text: "delete x" });
	await a.waitFor(() => asked(a).length === 1);
	a.send("session/interrupt");
	expect(a.out).toContainEqual({
		kind: "cancel",
		id: asked(a)[0].id,
		reason: "interrupted",
	});
	await a.waitFor(() => a.events("turn/finished").length === 1);
	expect(a.events("tool/finished")[0].status).toBe("interrupted");

	const b = connect(undefined, { tools: [powershell] });
	await b.ready();
	fake.replies.push(ps("Remove-Item x"), say("ok"));
	b.send("session/prompt", { text: "delete x" });
	await b.waitFor(() => asked(b).length === 1);
	answer(b, asked(b)[0].id, { decision: "sure" });
	await b.waitFor(() => b.events("turn/finished").length === 1);
	expect(b.events("tool/finished")[0].status).toBe("denied");
	expect(b.events("notice").at(-1)?.text).toContain(
		"invalid permission answer",
	);
});

// --- 1.8: the vault ---

const KEY = `sk-proj-${"Q1w2E3r4T5y6U7i8O9p0".repeat(2)}`;
// A read tool returning a file that holds a key.
const reader = defineTool({
	name: "read",
	description: "read",
	schema: Type.Object({ path: Type.String() }, { additionalProperties: false }),
	deferred: false,
	readOnly: true,
	permission: { path: (i) => i.path },
	run: async ({ path }) =>
		path.endsWith(".env")
			? "1\tDB_URL=postgres://localhost/app\n"
			: `1\tconst client = new OpenAI({ apiKey: "${KEY}" });\n2\techo ${ENV_VALUE}`,
});
const ENV_VALUE = "hunter2-db-pass";
const sent = () => JSON.stringify(fake.bodies);

test("the 1.8 check: a key read from a file reaches OpenAI only as a placeholder", async () => {
	const root = tempRoot();
	const project = tempRoot();
	writeFileSync(join(project, ".env"), `DB_PASSWORD=${ENV_VALUE}\n`);
	const c = connect(root, { tools: [reader] });
	fake.replies.push(
		{ items: [call("read", { path: "src/app.ts" })] },
		say("The key is [REDACTED:api_key#1]"),
	);
	await c.ready(project);
	c.send("session/prompt", { text: `also this one: ${KEY}` });
	await c.waitFor(() => c.events("turn/finished").length === 1);

	// What OpenAI saw: placeholders only (the pasted key, the read key, the .env value).
	expect(sent()).not.toContain(KEY);
	expect(sent()).not.toContain(ENV_VALUE);
	expect(sent()).toContain("[REDACTED:api_key#1]");
	expect(sent()).toContain("[REDACTED:env#1]");
	// The session file too.
	const sessionFile = (dir: string): string => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				const f = sessionFile(p);
				if (f) return f;
			} else if (p.endsWith(".jsonl")) return p;
		}
		return "";
	};
	const saved = readFileSync(sessionFile(root), "utf8");
	expect(saved).not.toContain(KEY);
	expect(saved).not.toContain(ENV_VALUE);
	// The user's own screen shows the real values.
	expect(c.events("tool/finished")[0].output).toContain(KEY);
	expect(c.events("message/done")[0].text).toBe(`The key is ${KEY}`);
	expect(
		c
			.events("message/delta")
			.map((e) => e.text)
			.join(""),
	).toBe(`The key is ${KEY}`);
});

test("resume brings the vault back; an unreadable vault starts fresh with a notice", async () => {
	const root = tempRoot();
	const a = connect(root, { tools: [reader] });
	fake.replies.push(say("noted"));
	const { result } = await a.ready();
	a.send("session/prompt", { text: `my key ${KEY}` });
	await a.waitFor(() => a.events("turn/finished").length === 1);

	const b = connect(root);
	b.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: [],
	});
	b.send("session/resume", { session_id: result.session_id, cwd: "E:\\x" });
	await b.waitFor(() => b.states().length > 0);
	expect(b.events("prompt/delivered")[0]).toMatchObject({
		replay: true,
		text: `my key ${KEY}`,
	});

	const vaultFile = join(
		projectDir("E:\\x", root),
		result.session_id,
		"vault.bin",
	);
	writeFileSync(vaultFile, "garbage");
	const c = connect(root);
	c.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: [],
	});
	c.send("session/resume", { session_id: result.session_id, cwd: "E:\\x" });
	await c.waitFor(() => c.states().length > 0);
	expect(
		c
			.events("notice")
			.map((e) => e.text)
			.join(),
	).toContain("Previous secret placeholders expired");
	expect(c.events("prompt/delivered")[0].text).toBe(
		"my key [REDACTED:api_key#1]",
	);
});

// --- 1.9: the real read-only tools ---

test("the real tools run in the session's folder, and a Read deny filters grep", async () => {
	const project = tempRoot();
	writeFileSync(join(project, "app.ts"), "const needle = 1;\n");
	writeFileSync(join(project, "secret.txt"), "needle in a secret\n");
	const c = connect(undefined, {
		tools: coreTools(),
		settings: fakeSettings({
			rules: {
				allow: [],
				ask: [],
				deny: [{ text: "Read(secret.txt)", base: project }],
			},
		}),
	});
	const nulls = (keys: string[]) =>
		Object.fromEntries(keys.map((k) => [k, null]));
	fake.replies.push(
		{
			items: [
				call("read", { file_path: "app.ts", offset: null, limit: null }),
				call("grep", {
					...nulls(["path", "glob", "type", "output_mode", "-A", "-B", "-C"]),
					...nulls([
						"context",
						"-i",
						"-n",
						"-o",
						"head_limit",
						"offset",
						"multiline",
					]),
					pattern: "needle",
				}),
				call("read", { file_path: "secret.txt", offset: null, limit: null }),
			],
		},
		say("done"),
	);
	await c.ready(project);
	expect(c.events("session/started")[0].tools).toEqual([
		"read",
		"edit",
		"write",
		"grep",
		"glob",
		"powershell",
		"task_stop",
	]);
	c.send("session/prompt", { text: "look around" });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	// Finished events come as each tool finishes; match them to the calls.
	const [r, g, s] = c
		.events("tool/started")
		.map((e) =>
			c.events("tool/finished").find((f) => f.tool_call_id === e.tool_call_id),
		);
	expect(r).toMatchObject({
		status: "ok",
		output: "     1\tconst needle = 1;",
	});
	expect(g).toMatchObject({ status: "ok", output: "app.ts" });
	expect(s).toMatchObject({ status: "denied" });
});

// --- 1.10: instructions and the first message ---

test("a session's first message is saved, and a resume sends the same bytes", async () => {
	const root = tempRoot();
	const project = tempRoot();
	const a = connect(root);
	fake.replies.push(say("one"));
	const { result } = await a.ready(project);
	a.send("session/prompt", { text: "hi" });
	await a.waitFor(() => a.events("turn/finished").length === 1);
	const first = fake.bodies[0].input[0];
	expect(first).toMatchObject({ role: "developer" });
	expect(JSON.stringify(first)).toContain(
		`Working directory: ${project.replaceAll("\\", "\\\\")}`,
	);
	expect(fake.bodies[0].instructions).toContain("You are Manas");

	const b = connect(root);
	b.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: [],
	});
	b.send("session/resume", { session_id: result.session_id, cwd: project });
	await b.waitFor(() => b.states().length > 0);
	fake.replies.push(say("two"));
	b.send("session/prompt", { text: "again" });
	await b.waitFor(() => b.events("turn/finished").length === 1);
	expect(fake.bodies[1].input[0]).toEqual(first);
	expect(fake.bodies[1].instructions).toBe(fake.bodies[0].instructions);
});

test("verbosity: low by default or from settings, saved, and kept on resume", async () => {
	const root = tempRoot();
	const live = fakeSettings({});
	const a = connect(root, { settings: live });
	fake.replies.push(say("one"));
	const { result } = await a.ready();
	a.send("session/prompt", { text: "hi" });
	await a.waitFor(() => a.events("turn/finished").length === 1);
	expect(fake.bodies[0].text).toEqual({ verbosity: "low" });

	// A settings change applies to new sessions; a resumed one keeps its own.
	live.reload({ settings: { verbosity: "high" } });
	const b = connect(root, { settings: live });
	b.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: [],
	});
	b.send("session/resume", { session_id: result.session_id, cwd: "E:\\x" });
	await b.waitFor(() => b.states().length > 0);
	fake.replies.push(say("two"), say("three"));
	b.send("session/prompt", { text: "again" });
	await b.waitFor(() => b.events("turn/finished").length === 1);
	expect(fake.bodies[1].text).toEqual({ verbosity: "low" });

	const c = connect(root, { settings: live });
	await c.ready();
	c.send("session/prompt", { text: "new" });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(fake.bodies[2].text).toEqual({ verbosity: "high" });

	// A session from before 1.10 has none saved: nothing is sent, as then.
	const file = findSession(result.session_id, "E:\\x", root) as string;
	writeFileSync(
		file,
		readFileSync(file, "utf8").replace(',"verbosity":"low"', ""),
	);
	const d = connect(root, { settings: live });
	d.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: [],
	});
	d.send("session/resume", { session_id: result.session_id, cwd: "E:\\x" });
	await d.waitFor(() => d.states().length > 0);
	fake.replies.push(say("four"));
	d.send("session/prompt", { text: "old" });
	await d.waitFor(() => d.events("turn/finished").length === 1);
	expect(fake.bodies[3]).not.toHaveProperty("text");
});

// --- 2.2: edit ---

test("an edit shows its diff with real values, and writes them to the file", async () => {
	const project = tempRoot();
	const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
	writeFileSync(
		join(project, "app.ts"),
		`const key = "${key}";\nconst n = 1;\n`,
	);
	const c = connect(undefined, { tools: coreTools() });
	fake.replies.push(
		{
			items: [call("read", { file_path: "app.ts", offset: null, limit: null })],
		},
		{
			items: [
				call("edit", {
					file_path: "app.ts",
					old_string: 'const key = "[REDACTED:api_key#1]";',
					new_string: 'const apiKey = "[REDACTED:api_key#1]";',
					replace_all: null,
				}),
			],
		},
		say("done"),
	);
	await c.ready(project);
	c.send("session/prompt", { text: "rename key" });
	await c.waitFor(() => asked(c).length === 1);
	expect(asked(c)[0]).toMatchObject({
		tool: "edit",
		title: "edit app.ts",
		diff: `line 1:\n- const key = "${key}";\n+ const apiKey = "${key}";\n  const n = 1;`,
	});
	answer(c, asked(c)[0].id, { decision: "allow" });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(readFileSync(join(project, "app.ts"), "utf8")).toBe(
		`const apiKey = "${key}";\nconst n = 1;\n`,
	);
});

// --- 2.6: rewind through the protocol ---

test("checkpoints/list, checkpoints/preview and session/rewind; errors for unknown or busy", async () => {
	const project = tempRoot();
	writeFileSync(join(project, "a.ts"), "let x = 1;\n");
	const c = connect(undefined, { tools: coreTools() });
	// preview and rewind answer once the files are read or written.
	const ask = async (type: string, data: object = {}) => {
		const from = c.out.length;
		c.send(type, data);
		await c.waitFor(() => c.out.slice(from).some((m) => m.kind === "response"));
		return c.out.slice(from).find((m) => m.kind === "response") as Msg;
	};
	fake.replies.push(
		{ items: [call("read", { file_path: "a.ts", offset: null, limit: null })] },
		{
			items: [
				call("edit", {
					file_path: "a.ts",
					old_string: "x = 1",
					new_string: "x = 2",
					replace_all: null,
				}),
			],
		},
		say("done"),
	);
	await c.ready(project);
	c.send("session/prompt", { text: "bump x" });
	await c.waitFor(() => asked(c).length === 1);
	answer(c, asked(c)[0].id, { decision: "allow" });
	await c.waitFor(() => c.events("turn/finished").length === 1);

	const list = await ask("checkpoints/list");
	expect(list.result).toEqual({
		checkpoints: [
			{
				checkpoint_id: "c1",
				prompt: "bump x",
				time: expect.any(String),
				undo: null,
			},
		],
	});
	expect(
		(await ask("checkpoints/preview", { checkpoint_id: "c1" })).result,
	).toEqual({
		files: [{ path: "a.ts", action: "restore", added: 1, removed: 1 }],
	});
	expect(await ask("checkpoints/preview", { checkpoint_id: "c9" })).toEqual(
		error("not_found"),
	);
	expect(
		(await ask("session/rewind", { checkpoint_id: "c1", scope: "both" }))
			.result,
	).toEqual({ prompt: "bump x", restored: ["a.ts"], failed: [] });
	expect(readFileSync(join(project, "a.ts"), "utf8")).toBe("let x = 1;\n");

	// A turn that waits on an approval is still running: rewind is refused.
	fake.replies.push(
		{ items: [call("write", { file_path: "b.ts", content: "b\n" })] },
		say("ok"),
	);
	c.send("session/prompt", { text: "make b" });
	await c.waitFor(() => asked(c).length === 2);
	const before = (await ask("checkpoints/list")).result as {
		checkpoints: { checkpoint_id: string }[];
	};
	expect(
		await ask("session/rewind", {
			checkpoint_id: before.checkpoints[0].checkpoint_id,
			scope: "code",
		}),
	).toEqual(error("busy"));
	answer(c, asked(c)[1].id, { decision: "deny", message: null });
	await c.waitFor(() => c.events("turn/finished").length === 2);
});

// --- 2.7: modes and saved rules ---

test("the 2.7 check: Allow and remember saves a rule to the project file", async () => {
	const project = tempRoot();
	const file = projectFile(project);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, '{\n\t// mine\n\t"verbosity": "low"\n}\n');
	const c = connect(undefined, {
		tools: [powershell],
		settings: fakeSettings({ files: [join(tempRoot(), "user.json"), file] }),
	});
	await c.ready(project);
	fake.replies.push(
		ps("npm test --watch"),
		say("ok"),
		ps("npm test"),
		say("ok"),
	);
	c.send("session/prompt", { text: "1" });
	await c.waitFor(() => asked(c).length === 1);
	const [suggestion] = asked(c)[0].suggestions as object[];
	expect(suggestion).toEqual({
		rules: ["PowerShell(npm test *)"],
		destination: "project",
	});
	answer(c, asked(c)[0].id, { decision: "allow_always", suggestion });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	// Comments stay; the rule is in the allow list.
	const text = readFileSync(file, "utf8");
	expect(text).toContain("// mine");
	expect(Bun.JSONC.parse(text)).toEqual({
		verbosity: "low",
		permissions: { allow: ["PowerShell(npm test *)"] },
	});
	// It applies at once, before the settings file reloads.
	c.send("session/prompt", { text: "2" });
	await c.waitFor(() => c.events("turn/finished").length === 2);
	expect(asked(c)).toHaveLength(1);
	expect(c.events("notice")).toEqual([]);
});

test("a project file not in use isn't written; the rule holds for the session", async () => {
	const project = tempRoot();
	const c = connect(undefined, { tools: [powershell] });
	await c.ready(project);
	fake.replies.push(ps("npm test"), say("ok"), ps("npm test"), say("ok"));
	c.send("session/prompt", { text: "1" });
	await c.waitFor(() => asked(c).length === 1);
	const [suggestion] = asked(c)[0].suggestions as object[];
	answer(c, asked(c)[0].id, { decision: "allow_always", suggestion });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("notice")[0].text).toStartWith("Couldn't save the rule:");
	expect(existsSync(projectFile(project))).toBe(false);
	c.send("session/prompt", { text: "2" });
	await c.waitFor(() => c.events("turn/finished").length === 2);
	expect(asked(c)).toHaveLength(1);
});

test("a choice that wasn't offered saves nothing; the call runs once", async () => {
	const c = connect(undefined, { tools: [powershell] });
	await c.ready();
	fake.replies.push(ps("npm test"), say("ok"), ps("npm test"), say("ok"));
	c.send("session/prompt", { text: "1" });
	await c.waitFor(() => asked(c).length === 1);
	answer(c, asked(c)[0].id, {
		decision: "allow_always",
		suggestion: { rules: ["PowerShell"], destination: "session" },
	});
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("tool/finished")[0].status).toBe("ok");
	expect(c.events("notice")[0].text).toContain("wasn't offered");
	c.send("session/prompt", { text: "2" });
	await c.waitFor(() => asked(c).length === 2);
	answer(c, asked(c)[1].id, { decision: "allow" });
	await c.waitFor(() => c.events("turn/finished").length === 2);
});

test("session/set_mode: display names, later modes refused, state/changed carries the mode", async () => {
	const c = connect();
	await c.ready();
	expect(c.events("session/started")[0].mode).toBe("manual");
	expect(c.send("session/set_mode", { mode: "lowkey" })).toMatchObject({
		ok: true,
		result: { mode: "acceptEdits" },
	});
	expect(c.events("state/changed").at(-1)).toMatchObject({
		state: "idle",
		mode: "acceptEdits",
	});
	expect(c.send("session/set_mode", { mode: "plan" })).toEqual(
		error("invalid_params"),
	);
	expect(c.send("session/set_mode", { mode: "nope" })).toEqual(
		error("invalid_params"),
	);
	c.send("session/set_mode", { mode: "acceptEdits" });
	expect(c.events("notice").at(-1)?.text).toBe("Already in lowkey.");

	const d = connect();
	d.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: [],
	});
	expect(d.send("session/new", { cwd: ".", mode: "scheming" })).toEqual(
		error("invalid_params"),
	);
});

test("the starting mode: the request, then settings; a later mode in settings warns", async () => {
	const a = connect(undefined, {
		settings: fakeSettings({ settings: { mode: "lowkey" } as never }),
	});
	await a.ready();
	expect(a.events("session/started")[0].mode).toBe("acceptEdits");

	const b = connect(undefined, {
		settings: fakeSettings({ settings: { mode: "plan" } as never }),
	});
	await b.ready();
	expect(b.events("session/started")[0].mode).toBe("manual");
	expect(b.events("notice")[0].text).toBe(
		"settings: scheming (plan) comes in 6.4; for now: vibe-check (manual) or lowkey (acceptEdits) (starting in vibe-check)",
	);
});

test("lowkey: edits in the project run; .git still asks; option 2 switches to it", async () => {
	const project = tempRoot();
	const c = connect(undefined, { tools: coreTools() });
	const write = (file_path: string) => ({
		items: [call("write", { file_path, content: "x\n" })],
	});
	fake.replies.push(
		write("a.ts"),
		say("ok"),
		write("b.ts"),
		say("ok"),
		write(".git/hooks/x"),
		say("ok"),
	);
	await c.ready(project);
	c.send("session/prompt", { text: "a" });
	await c.waitFor(() => asked(c).length === 1);
	expect(asked(c)[0].suggestions).toEqual([{ mode: "acceptEdits" }]);
	answer(c, asked(c)[0].id, {
		decision: "allow_always",
		suggestion: { mode: "acceptEdits" },
	});
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("state/changed").at(-1)?.mode).toBe("acceptEdits");

	c.send("session/prompt", { text: "b" });
	await c.waitFor(() => c.events("turn/finished").length === 2);
	expect(asked(c)).toHaveLength(1);
	expect(readFileSync(join(project, "b.ts"), "utf8")).toBe("x\n");

	c.send("session/prompt", { text: "git" });
	await c.waitFor(() => asked(c).length === 2);
	expect(asked(c)[1].suggestions).toEqual([
		{ rules: ["Edit(.git/hooks/**)"], destination: "session" },
	]);
	answer(c, asked(c)[1].id, { decision: "deny", message: "leave .git alone" });
	await c.waitFor(() => c.events("turn/finished").length === 3);
	expect(existsSync(join(project, ".git"))).toBe(false);
});

test("the mode is saved with the session and comes back; the request's mode wins", async () => {
	const root = tempRoot();
	const project = tempRoot();
	const a = connect(root);
	fake.replies.push(say("ok"));
	await a.ready(project);
	a.send("session/prompt", { text: "hi" });
	await a.waitFor(() => a.events("turn/finished").length === 1);
	a.send("session/set_mode", { mode: "lowkey" });
	const id = a.events("session/started")[0].session_id as string;
	a.host.close();

	const resume = (mode?: string) => {
		const c = connect(root);
		c.send("initialize", {
			client: { name: "t", version: "0" },
			capabilities: [],
		});
		c.send("session/resume", { session_id: id, cwd: project, mode });
		return c;
	};
	const b = resume();
	await b.waitFor(() => b.events("session/started").length > 0);
	expect(b.events("session/started")[0].mode).toBe("acceptEdits");
	b.host.close();
	const c = resume("vibe-check");
	await c.waitFor(() => c.events("session/started").length > 0);
	expect(c.events("session/started")[0].mode).toBe("manual");
});

// --- 2.8: ask_user ---

const readyToAsk = async (c: ReturnType<typeof connect>, cwd = "E:\\x") => {
	c.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: ["user_ask"],
	});
	c.send("session/new", { cwd });
	await c.waitFor(() => c.events("session/started").length > 0);
};
const colors = [
	{
		question: "Which color?",
		header: "Color",
		options: [
			{ label: "Blue", description: "calm", preview: null },
			{ label: "Red", description: "loud", preview: null },
		],
		multiSelect: false,
	},
];
const questionsAsked = (c: ReturnType<typeof connect>) =>
	c.out.filter((m) => m.kind === "request" && m.type === "user/ask");

test("ask_user is offered only to a front end that declared user_ask", async () => {
	const a = connect(undefined, { tools: coreTools() });
	await a.ready();
	expect(a.events("session/started")[0].tools).not.toContain("ask_user");
	const b = connect(undefined, { tools: coreTools() });
	await readyToAsk(b);
	expect(b.events("session/started")[0].tools).toContain("ask_user");
});

test("user/ask waits for the answer, which reaches the model; null stops the turn", async () => {
	const c = connect(undefined, { tools: coreTools() });
	await readyToAsk(c);
	fake.replies.push(
		{ items: [call("ask_user", { questions: colors })] },
		say("blue it is"),
		{ items: [call("ask_user", { questions: colors })] },
	);
	c.send("session/prompt", { text: "pick" });
	await c.waitFor(() => questionsAsked(c).length === 1);
	expect(questionsAsked(c)[0]).toMatchObject({
		tool_call_id: c.events("tool/started")[0].tool_call_id,
		questions: colors,
	});
	expect(c.states().at(-1)).toBe("waiting_for_user");
	answer(c, questionsAsked(c)[0].id, { answers: { "Which color?": ["Blue"] } });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("tool/finished")[0].output).toBe(
		'Your questions have been answered: "Which color?"="Blue". You can now continue with these answers in mind.',
	);

	c.send("session/prompt", { text: "again" });
	await c.waitFor(() => questionsAsked(c).length === 2);
	answer(c, questionsAsked(c)[1].id, { answers: null });
	await c.waitFor(() => c.events("turn/finished").length === 2);
	expect(c.events("tool/finished")[1]).toMatchObject({
		status: "denied",
		output: "error: the user declined to answer",
	});
	expect(c.events("turn/finished")[1].stop_reason).toBe("interrupted");
});

test("questions show real values; answers go back as the model wrote them", async () => {
	const project = tempRoot();
	const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
	writeFileSync(join(project, "app.ts"), `const key = "${key}";\n`);
	const c = connect(undefined, { tools: coreTools() });
	const placeholder = "[REDACTED:api_key#1]";
	fake.replies.push(
		{
			items: [call("read", { file_path: "app.ts", offset: null, limit: null })],
		},
		{
			items: [
				call("ask_user", {
					questions: [
						{
							question: `Rotate ${placeholder}?`,
							header: "Key",
							options: [
								{
									label: `Keep ${placeholder}`,
									description: "",
									preview: null,
								},
								{ label: "Rotate", description: "", preview: null },
							],
							multiSelect: false,
						},
					],
				}),
			],
		},
		say("ok"),
	);
	await readyToAsk(c, project);
	c.send("session/prompt", { text: "check the key" });
	await c.waitFor(() => questionsAsked(c).length === 1);
	const shown = questionsAsked(c)[0].questions as typeof colors;
	expect(shown[0].question).toBe(`Rotate ${key}?`);
	expect(shown[0].options[0].label).toBe(`Keep ${key}`);
	answer(c, questionsAsked(c)[0].id, {
		answers: { [`Rotate ${key}?`]: [`Keep ${key}`] },
	});
	await c.waitFor(() => c.events("turn/finished").length === 1);
	const sent = JSON.stringify(fake.bodies.at(-1));
	expect(sent).toContain(
		`\\"Rotate ${placeholder}?\\"=\\"Keep ${placeholder}\\"`,
	);
	expect(sent).not.toContain(key);
	expect(c.events("tool/finished")[1].output).toStartWith(
		"Your questions have been answered:",
	);
});

test("a bad answer counts as declined; an interrupt withdraws the question", async () => {
	const c = connect(undefined, { tools: coreTools() });
	await readyToAsk(c);
	fake.replies.push(
		{ items: [call("ask_user", { questions: colors })] },
		{ items: [call("ask_user", { questions: colors })] },
	);
	c.send("session/prompt", { text: "1" });
	await c.waitFor(() => questionsAsked(c).length === 1);
	answer(c, questionsAsked(c)[0].id, { answers: "Blue" });
	await c.waitFor(() => c.events("turn/finished").length === 1);
	expect(c.events("notice").at(-1)?.text).toBe(
		"The front end sent an invalid answer to the questions; treated as declined.",
	);
	expect(c.events("turn/finished")[0].stop_reason).toBe("interrupted");

	c.send("session/prompt", { text: "2" });
	await c.waitFor(() => questionsAsked(c).length === 2);
	c.send("session/interrupt");
	await c.waitFor(() => c.events("turn/finished").length === 2);
	expect(c.out).toContainEqual({
		kind: "cancel",
		id: questionsAsked(c)[1].id,
		reason: "interrupted",
	});
});

// --- 2.9: cleanup ---

test("with cleanup, the sweep runs once a session opens and never takes that session", async () => {
	const dir = tempRoot();
	const root = join(dir, "projects");
	const project = tempRoot();
	const a = connect(root);
	fake.replies.push(say("ok"));
	await a.ready(project);
	a.send("session/prompt", { text: "hi" });
	await a.waitFor(() => a.events("turn/finished").length === 1);
	const id = a.events("session/started")[0].session_id as string;
	a.host.close();
	const file = findSession(id, project, root) as string;
	const other = join(dirname(file), "other.jsonl");
	writeFileSync(other, "{}\n");
	const old = (Date.now() - 40 * 86_400_000) / 1000;
	utimesSync(file, old, old);
	utimesSync(other, old, old);

	const b = connect(root, { cleanup: { dir } });
	b.send("initialize", {
		client: { name: "t", version: "0" },
		capabilities: [],
	});
	b.send("session/resume", { session_id: id, cwd: project });
	await b.waitFor(() => !existsSync(other));
	expect(existsSync(file)).toBe(true);
	expect(existsSync(join(dir, ".last-cleanup"))).toBe(true);
});

test("a background command: listed, stopped by id, and its end starts a turn by itself (3.3)", async () => {
	const c = connect(undefined, { tools: coreTools() });
	await c.ready(tempRoot());
	fake.replies.push(
		{
			items: [
				call("powershell", {
					command: "Write-Output hi",
					description: "Say hi",
					timeout: null,
					run_in_background: true,
				}),
			],
		},
		say("started"),
		say("it said hi"),
	);
	c.send("session/prompt", { text: "go" });
	const until = async (ok: () => boolean) => {
		for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(50);
		expect(ok()).toBe(true);
	};
	await until(() => c.events("task/finished").length === 1);
	expect(c.events("task/finished")[0]).toMatchObject({
		task_id: expect.stringMatching(/^b[0-9a-f]{6}$/),
		status: "completed",
		summary: 'Background command "Say hi" completed (exit code 0)',
	});
	// The notice turn: a second turn/finished with no prompt typed.
	await until(() => c.events("turn/finished").length === 2);
	const notice = fake.bodies.at(-1)?.input.at(-1) as { content: string };
	expect(notice.content).toContain("<task-notification>");
	const listed = c.send("tasks/list").result as { tasks: object[] };
	expect(listed.tasks).toMatchObject([
		{ description: "Say hi", command: "Write-Output hi", status: "completed" },
	]);
	expect(c.send("tasks/stop", { task_id: "bnope00" }).result).toEqual({
		stopped: false,
		text: "No task found with ID: bnope00",
	});
	expect(c.send("tasks/background").result).toEqual({ moved: 0 });
	c.host.close();
});
