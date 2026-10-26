import { afterAll, beforeEach, expect, test } from "bun:test";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import Type from "typebox";
import { CUT_OFF } from "../session/store";
import {
	call,
	fakeOpenAI,
	message,
	say,
	tempRoot,
} from "../testing/fake-openai";
import { type Backups, openBackups } from "../tools/backups";
import { buildRegistry, defineTool } from "../tools/registry";
import { createSession, replayEvents, type SessionEvent } from "./session";

const fake = fakeOpenAI();
afterAll(fake.stop);
beforeEach(fake.reset);
const { replies, bodies } = fake;

// A tool that waits until the test opens the gate, so prompts can be sent
// while a turn is in its tool phase.
let open = () => {};
const gate = defineTool({
	name: "gate",
	description: "waits",
	schema: Type.Object({}, { additionalProperties: false }),
	deferred: false,
	readOnly: true,
	run: () =>
		new Promise<string>((resolve) => {
			open = () => resolve("opened");
		}),
});

function start(extra: { backups?: Backups } = {}) {
	const events: SessionEvent[] = [];
	const session = createSession({
		registry: buildRegistry([gate]),
		model: "gpt-5.6-luna",
		emit: (e) => events.push(e),
		...extra,
	});
	const waitFor = async (pred: (e: SessionEvent[]) => boolean) => {
		for (let i = 0; i < 400 && !pred(events); i++) await Bun.sleep(5);
		expect(pred(events)).toBe(true);
	};
	const idles = (n: number) => () =>
		events.filter((e) => e.type === "idle").length >= n;
	const has = (type: SessionEvent["type"]) => () =>
		events.some((e) => e.type === type);
	const lastUser = (i: number) =>
		bodies[i].input.filter((m) => "role" in m && m.role === "user").at(-1);
	return { session, events, waitFor, idles, has, lastUser };
}

test("two prompts in a row share one history", async () => {
	const { session, waitFor, idles } = start();
	replies.push(say("one"), say("two"));
	session.prompt("first");
	await waitFor(idles(1));
	session.prompt("second");
	await waitFor(idles(2));
	expect(bodies[1].input).toContainEqual(
		expect.objectContaining({ role: "user", content: "first" }),
	);
	expect(bodies[1].input.at(-1)).toEqual({ role: "user", content: "second" });
});

test("events come in order with ids, between running and idle", async () => {
	const { session, events, waitFor, idles } = start();
	replies.push(say("hello"));
	const id = session.prompt("hi");
	await waitFor(idles(1));
	expect(events).toEqual([
		{ type: "running" },
		{ type: "prompt_delivered", promptId: id, text: "hi" },
		{ type: "text", messageId: "m1", delta: "hello" },
		{ type: "message_done", messageId: "m1", text: "hello" },
		expect.objectContaining({
			type: "turn_finished",
			turnId: "t1",
			stopReason: "done",
		}),
		{ type: "idle" },
	]);
});

test("`next` joins the running turn after its tools; `later` waits for the turn", async () => {
	const { session, events, waitFor, idles, has, lastUser } = start();
	replies.push(
		{ items: [call("gate", {})] },
		say("round two"),
		say("later turn"),
	);
	session.prompt("go");
	await waitFor(has("tool_started"));
	const later = session.prompt("after", "later");
	const next = session.prompt("also", "next");
	open();
	await waitFor(idles(1));
	expect(lastUser(1)).toEqual({ role: "user", content: "also" });
	expect(lastUser(2)).toEqual({ role: "user", content: "after" });
	const order = events.map((e) => ("promptId" in e ? e.promptId : e.type));
	expect(order.indexOf(next)).toBeGreaterThan(order.indexOf("tool_finished"));
	expect(order.indexOf(later)).toBeGreaterThan(order.indexOf("turn_finished"));
	expect(events.filter((e) => e.type === "idle")).toHaveLength(1);
});

test("a checkpoint when each turn starts; a prompt folded into a turn gets none", async () => {
	const backups = openBackups(tempRoot(), "s1");
	const { session, waitFor, idles, has } = start({ backups });
	replies.push(
		{ items: [call("gate", {})] },
		say("round two"),
		say("later turn"),
	);
	session.prompt("go");
	await waitFor(has("tool_started"));
	session.prompt("after", "later");
	session.prompt("also", "next");
	open();
	await waitFor(idles(1));
	// "go" started at an empty history; "after" after go's turn (user, call,
	// result, folded "also", reply). "also" has no checkpoint of its own.
	expect(backups.list().map((c) => c.items)).toEqual([0, 5]);
});

test("`now` interrupts the running turn, then runs", async () => {
	const { session, events, waitFor, idles, lastUser } = start();
	replies.push({ text: "long…", hold: true }, say("ok"));
	session.prompt("write a lot");
	await waitFor(() => events.some((e) => e.type === "text"));
	session.prompt("stop, do this", "now");
	await waitFor(idles(1));
	expect(events.filter((e) => e.type === "turn_finished")).toMatchObject([
		{ stopReason: "interrupted" },
		{ stopReason: "done" },
	]);
	expect(lastUser(1)).toEqual({ role: "user", content: "stop, do this" });
});

test("an interrupt keeps the queue; queued prompts still run", async () => {
	const { session, events, waitFor, idles, lastUser } = start();
	replies.push({ text: "long…", hold: true }, say("ok"));
	session.prompt("write a lot");
	await waitFor(() => events.some((e) => e.type === "text"));
	const queued = session.prompt("then this", "later");
	expect(session.interrupt()).toEqual([queued]);
	await waitFor(idles(1));
	expect(lastUser(1)).toEqual({ role: "user", content: "then this" });
});

test("an interrupt with cancelQueued drops the queue", async () => {
	const { session, events, waitFor, idles } = start();
	replies.push({ text: "long…", hold: true });
	session.prompt("write a lot");
	await waitFor(() => events.some((e) => e.type === "text"));
	session.prompt("then this", "later");
	expect(session.interrupt(true)).toEqual([]);
	await waitFor(idles(1));
	expect(bodies).toHaveLength(1);
});

test("an API error ends that turn; the queue goes on", async () => {
	const { session, events, waitFor, idles } = start();
	replies.push({ status: 400 }, say("fine"));
	session.prompt("breaks");
	session.prompt("works", "later");
	await waitFor(idles(1));
	expect(events.filter((e) => e.type === "turn_finished")).toMatchObject([
		{ stopReason: "error", error: expect.stringContaining("400") },
		{ stopReason: "done" },
	]);
});

test("model and effort: silent before a reply, a warning after, from the next turn", async () => {
	const { session, events, waitFor, idles } = start();
	const notices = () =>
		events.flatMap((e) =>
			e.type === "notice" ? [`${e.level}: ${e.text.slice(0, 40)}`] : [],
		);
	session.setEffort("high");
	expect(notices()).toEqual([]);
	replies.push(say("one"), say("two"));
	session.prompt("hi");
	await waitFor(idles(1));
	expect(bodies[0]).toMatchObject({
		model: "gpt-5.6-luna",
		reasoning: { effort: "high" },
	});

	session.setEffort("high");
	session.setEffort("low");
	session.setModel("gpt-4o-mini");
	session.setEffort("max");
	expect(notices()).toEqual([
		"info: Already using effort high.",
		"warn: Heads up: your next reply will cost more",
		"warn: Heads up: your next reply will cost more",
		"info: gpt-4o-mini has no reasoning effort; it ",
	]);
	expect(events.filter((e) => e.type === "notice")[2]).toMatchObject({
		text: expect.stringContaining("Changing the model makes it start fresh"),
	});
	session.prompt("again");
	await waitFor(idles(2));
	expect(bodies[1].model).toBe("gpt-4o-mini");
	expect(bodies[1]).not.toHaveProperty("reasoning");

	expect(() => session.setModel("nope")).toThrow('unknown model "nope"');
	session.setModel("gpt-5.6-luna");
	expect(() => session.setEffort("minimal")).toThrow(
		'effort "minimal" not supported',
	);
	session.setEffort(undefined);
	expect(session.effort).toBeUndefined();
});

test("a resumed session sends its old history; replay maps every item kind", async () => {
	const items = [
		{ role: "user", content: "go" },
		{ type: "reasoning", id: "rs", summary: [], encrypted_content: "x" },
		{
			type: "function_call",
			call_id: "c1",
			name: "gate",
			arguments: '{"a":1}',
		},
		{ type: "function_call_output", call_id: "c1", output: "error: nope" },
		{ type: "function_call", call_id: "c2", name: "gate", arguments: "{}" },
		{ type: "function_call_output", call_id: "c2", output: CUT_OFF },
		message("done"),
		{ role: "user", content: "write a lot" },
		{ role: "assistant", content: "par" },
		{ role: "developer", content: "[interrupted by user]" },
	] as ResponseInputItem[];
	expect(replayEvents(items)).toEqual([
		{ type: "prompt_delivered", promptId: "r1", text: "go" },
		{ type: "tool_started", callId: "c1", name: "gate", input: { a: 1 } },
		{
			type: "tool_finished",
			callId: "c1",
			status: "error",
			output: "error: nope",
		},
		{ type: "tool_started", callId: "c2", name: "gate", input: {} },
		{
			type: "tool_finished",
			callId: "c2",
			status: "interrupted",
			output: CUT_OFF,
		},
		{ type: "message_done", messageId: "rm1", text: "done" },
		{ type: "prompt_delivered", promptId: "r2", text: "write a lot" },
		{ type: "message_done", messageId: "rm2", text: "par" },
		expect.objectContaining({
			type: "turn_finished",
			stopReason: "interrupted",
		}),
	]);

	const events: SessionEvent[] = [];
	const session = createSession({
		registry: buildRegistry([gate]),
		model: "gpt-4o-mini",
		items,
		emit: (e) => events.push(e),
	});
	replies.push(say("again"));
	session.prompt("next");
	for (let i = 0; i < 400 && !events.some((e) => e.type === "idle"); i++)
		await Bun.sleep(5);
	expect(bodies[0].model).toBe("gpt-4o-mini");
	expect(bodies[0].input.slice(0, items.length)).toEqual(items);
});

test("with a store: items, usage and changes are saved", async () => {
	const saved: string[] = [];
	const store = {
		file: "f",
		exists: true,
		item: (i: ResponseInputItem) =>
			saved.push(`item ${"role" in i ? i.role : i.type}`),
		set: (c: object) => saved.push(`set ${JSON.stringify(c)}`),
		usage: (t: string) => saved.push(`usage ${t}`),
		read: () => {},
	};
	const events: SessionEvent[] = [];
	const session = createSession({
		registry: buildRegistry([gate]),
		model: "gpt-5.6-luna",
		store,
		emit: (e) => events.push(e),
	});
	replies.push(say("hi"));
	session.prompt("hello");
	for (let i = 0; i < 400 && !events.some((e) => e.type === "idle"); i++)
		await Bun.sleep(5);
	session.setEffort("high");
	expect(saved).toEqual([
		"item user",
		"item assistant",
		"usage t1",
		'set {"effort":"high"}',
	]);
});

test("the first message opens a new session; a new day appends a note; instructions on every request", async () => {
	let date = "2026-10-26";
	const events: SessionEvent[] = [];
	const items: ResponseInputItem[] = [];
	const make = (from: ResponseInputItem[]) =>
		createSession({
			registry: buildRegistry([]),
			model: "gpt-5.6-luna",
			emit: (e) => events.push(e),
			items: from,
			context: () => `<environment>\nToday's date: ${date}\n</environment>`,
			today: () => date,
		});
	const idles = (n: number) => async () => {
		for (
			let i = 0;
			i < 400 && events.filter((e) => e.type === "idle").length < n;
			i++
		)
			await Bun.sleep(5);
	};
	const env: ResponseInputItem = {
		role: "developer",
		content: "<environment>\nToday's date: 2026-10-26\n</environment>",
	};

	const s = make([]);
	replies.push(say("one"), say("two"));
	s.prompt("first");
	await idles(1)();
	s.prompt("second");
	await idles(2)();
	expect(bodies[0].instructions).toContain("You are Manas");
	expect(bodies[0].input).toEqual([env, { role: "user", content: "first" }]);
	// Same day: the prefix is just extended.
	expect(bodies[1].input.slice(0, 2)).toEqual(bodies[0].input);
	expect(bodies[1].input[2]).toMatchObject({ role: "assistant" });
	expect(bodies[1].input).toHaveLength(4);

	// Resumed the next day: the saved first message stays, a note is appended.
	items.push(...s.history);
	date = "2026-10-27";
	const r = make(items);
	replies.push(say("three"));
	r.prompt("third");
	await idles(3)();
	expect(bodies[2].input[0]).toEqual(env);
	expect(bodies[2].input.slice(-2)).toEqual([
		{ role: "developer", content: "Today's date is now 2026-10-27." },
		{ role: "user", content: "third" },
	]);
	// Neither shows when the chat is replayed on screen.
	expect(JSON.stringify(replayEvents(r.history))).not.toContain("Today's date");
});
