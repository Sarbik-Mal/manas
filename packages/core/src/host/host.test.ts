import { afterAll, beforeEach, expect, test } from "bun:test";
import { fakeOpenAI, type Msg, say, tempRoot } from "../testing/fake-openai";
import { createHost } from "./host";

const fake = fakeOpenAI();
afterAll(fake.stop);
beforeEach(fake.reset);

// A front end on a fake transport: everything the host sends lands in `out`.
function connect(root = tempRoot()) {
	const out: Msg[] = [];
	const host = createHost((line) => out.push(JSON.parse(line)), { root });
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
	const ready = async () => {
		send("initialize", {
			client: { name: "test", version: "0" },
			capabilities: [],
		});
		const r = send("session/new", { cwd: "E:\\x" });
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
	await waitFor(() => states().at(-1) === "running");
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
