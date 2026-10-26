import { afterAll, beforeEach, expect, test } from "bun:test";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import Type, { type TSchema } from "typebox";
import { buildRegistry, defineTool, type Tool } from "../tools/registry";
import { type LoopEvent, runTurn } from "./turn";

// A scripted fake OpenAI: each request takes the next reply from `replies`.
// A reply is the output items to send; `hold` sends one delta and stays open.
type Reply = { items?: object[]; text?: string; hold?: boolean };
let replies: Reply[] = [];
let bodies: { input: ResponseInputItem[] }[] = [];
const sse = (e: object) => `data: ${JSON.stringify(e)}\n\n`;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		bodies.push(await req.json());
		const { items = [], text, hold } = replies.shift() ?? {};
		const body = new ReadableStream({
			start(c) {
				if (text)
					c.enqueue(sse({ type: "response.output_text.delta", delta: text }));
				if (hold) return;
				for (const item of items) {
					c.enqueue(sse({ type: "response.output_item.done", item }));
				}
				c.close();
			},
		});
		return new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
	},
});
process.env.OPENAI_BASE_URL = `http://localhost:${server.port}/v1`;
process.env.OPENAI_API_KEY = "test-key";
afterAll(() => server.stop());
beforeEach(() => {
	replies = [];
	bodies = [];
});

const message = (text: string) => ({
	type: "message",
	id: "msg_1",
	status: "completed",
	role: "assistant",
	content: [{ type: "output_text", text, annotations: [] }],
});
const say = (text: string): Reply => ({ text, items: [message(text)] });
let n = 0;
const call = (name: string, args: unknown) => ({
	type: "function_call",
	id: `fc_${++n}`,
	call_id: `call_${n}`,
	name,
	arguments: typeof args === "string" ? args : JSON.stringify(args),
	status: "completed",
});
const tool = <S extends TSchema>(
	name: string,
	schema: S,
	run: Tool<S>["run"],
) =>
	defineTool({
		name,
		description: name,
		schema,
		deferred: false,
		readOnly: true,
		run,
	});
const none = Type.Object({}, { additionalProperties: false });
const echo = tool(
	"echo",
	Type.Object(
		{ x: Type.Union([Type.String(), Type.Null()]) },
		{ additionalProperties: false },
	),
	async (input) => JSON.stringify(input),
);
const tools = (...list: Tool[]) => ({ registry: buildRegistry(list) });

const drain = async (gen: AsyncGenerator<LoopEvent>) => {
	const events: LoopEvent[] = [];
	for await (const e of gen) events.push(e);
	return events;
};
const outputs = (h: ResponseInputItem[]) =>
	h.flatMap((i) => (i.type === "function_call_output" ? [i.output] : []));
// OpenAI rejects a request where a function_call has no output.
const allAnswered = (h: ResponseInputItem[]) =>
	h.every(
		(i) =>
			i.type !== "function_call" ||
			h.some(
				(o) => o.type === "function_call_output" && o.call_id === i.call_id,
			),
	);

test("a text-only turn streams and ends", async () => {
	replies = [say("hi there")];
	const history: ResponseInputItem[] = [];
	const events = await drain(runTurn(history, "hi"));
	expect(events).toEqual([
		{ type: "text", delta: "hi there" },
		{ type: "turn_finished", stopReason: "done" },
	]);
	expect(history).toEqual([
		{ role: "user", content: "hi" },
		message("hi there") as ResponseInputItem,
	]);
});

test("a tool result goes back to the model, then it answers", async () => {
	const c = call("echo", { x: "a" });
	replies = [{ items: [c] }, say("done")];
	const history: ResponseInputItem[] = [];
	const events = await drain(runTurn(history, "go", tools(echo)));
	expect(bodies).toHaveLength(2);
	expect(bodies[1].input.at(-1)).toEqual({
		type: "function_call_output",
		call_id: c.call_id,
		output: '{"x":"a"}',
	});
	expect(events.map((e) => e.type)).toEqual([
		"tool_started",
		"tool_finished",
		"text",
		"turn_finished",
	]);
});

test("calls run in parallel, results come back in call order", async () => {
	let running = 0;
	let peak = 0;
	const wait = tool(
		"wait",
		Type.Object({ ms: Type.Integer() }, { additionalProperties: false }),
		async ({ ms }) => {
			peak = Math.max(peak, ++running);
			await Bun.sleep(ms);
			running--;
			return `waited ${ms}`;
		},
	);
	replies = [
		{ items: [call("wait", { ms: 50 }), call("wait", { ms: 5 })] },
		say("ok"),
	];
	const history: ResponseInputItem[] = [];
	await drain(runTurn(history, "go", tools(wait)));
	expect(peak).toBe(2);
	expect(outputs(history)).toEqual(["waited 50", "waited 5"]);
});

test("unknown tool, bad JSON and a throwing tool go back as errors", async () => {
	const boom = tool("boom", none, async () => {
		throw new Error("disk on fire");
	});
	replies = [
		{ items: [call("nope", {}), call("echo", "{oops"), call("boom", {})] },
		say("ok"),
	];
	const history: ResponseInputItem[] = [];
	const events = await drain(runTurn(history, "go", tools(echo, boom)));
	expect(outputs(history)).toEqual([
		'error: unknown tool "nope"',
		"error: arguments are not valid JSON",
		"error: disk on fire",
	]);
	expect(events.at(-1)).toEqual({ type: "turn_finished", stopReason: "done" });
});

test("an interrupt mid-stream keeps the partial text and stops", async () => {
	replies = [{ text: "partial", hold: true }];
	const ac = new AbortController();
	const history: ResponseInputItem[] = [];
	const events: LoopEvent[] = [];
	for await (const e of runTurn(history, "write a lot", {
		signal: ac.signal,
	})) {
		events.push(e);
		if (e.type === "text") ac.abort();
	}
	expect(events.at(-1)).toEqual({
		type: "turn_finished",
		stopReason: "interrupted",
	});
	expect(history).toEqual([
		{ role: "user", content: "write a lot" },
		{ role: "assistant", content: "partial" },
		{ role: "developer", content: "[interrupted by user]" },
	]);
	expect(bodies).toHaveLength(1);
});

test("an interrupt during a stuck tool answers every call, and the next turn works", async () => {
	// Ignores the signal on purpose: the loop must not wait for it.
	const stuck = tool("stuck", none, () => new Promise(() => {}));
	replies = [{ items: [call("echo", { x: null }), call("stuck", {})] }];
	const ac = new AbortController();
	const history: ResponseInputItem[] = [];
	const events: LoopEvent[] = [];
	for await (const e of runTurn(history, "go", {
		...tools(echo, stuck),
		signal: ac.signal,
	})) {
		events.push(e);
		if (e.type === "tool_started" && e.name === "stuck") ac.abort();
	}
	expect(events.filter((e) => e.type === "tool_finished")).toMatchObject([
		{ status: "ok" },
		{ status: "interrupted", output: "interrupted by user" },
	]);
	expect(history.at(-1)).toEqual({
		role: "developer",
		content: "[interrupted by user]",
	});
	expect(bodies).toHaveLength(1);

	replies = [say("hello again")];
	await drain(runTurn(history, "next"));
	expect(bodies).toHaveLength(2);
	expect(allAnswered(bodies[1].input)).toBe(true);
});

test("reasoning items are sent back on the next round", async () => {
	const reasoning = {
		type: "reasoning",
		id: "rs_1",
		summary: [],
		encrypted_content: "secret-thoughts",
	};
	replies = [{ items: [reasoning, call("echo", { x: null })] }, say("ok")];
	await drain(runTurn([], "go", tools(echo)));
	expect(bodies[1].input).toContainEqual(reasoning as ResponseInputItem);
});
