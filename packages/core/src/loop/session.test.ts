import { afterAll, beforeEach, expect, test } from "bun:test";
import Type from "typebox";
import { call, fakeOpenAI, say } from "../testing/fake-openai";
import { buildRegistry, defineTool } from "../tools/registry";
import { createSession, type SessionEvent } from "./session";

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

function start() {
	const events: SessionEvent[] = [];
	const session = createSession({
		registry: buildRegistry([gate]),
		model: "gpt-5.6-luna",
		emit: (e) => events.push(e),
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
