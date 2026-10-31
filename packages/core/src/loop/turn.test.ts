import { afterAll, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import Type, { type TSchema } from "typebox";
import { disableDebugLog, enableDebugLog } from "../log/debug";
import { cacheMonitor } from "../provider/cache";
import {
	call,
	fakeOpenAI,
	message,
	say,
	tempRoot,
} from "../testing/fake-openai";
import { buildRegistry, defineTool, type Tool } from "../tools/registry";
import { type LoopEvent, runTurn } from "./turn";

const fake = fakeOpenAI();
afterAll(fake.stop);
beforeEach(fake.reset);
const { replies, bodies } = fake;

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
const zero = { input: 0, cached: 0, output: 0, reasoning: 0 };

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
	replies.push(say("hi there"));
	const history: ResponseInputItem[] = [];
	const events = await drain(runTurn(history, "hi"));
	expect(events).toEqual([
		{ type: "text", delta: "hi there" },
		{ type: "message_done", text: "hi there" },
		{ type: "turn_finished", stopReason: "done", usage: zero },
	]);
	expect(history).toEqual([
		{ role: "user", content: "hi" },
		message("hi there") as ResponseInputItem,
	]);
});

test("a tool result goes back to the model, then it answers", async () => {
	const c = call("echo", { x: "a" });
	replies.push({ items: [c] }, say("done"));
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
		"message_done",
		"turn_finished",
	]);
});

test("usage is summed over the turn's rounds", async () => {
	replies.push(
		{
			items: [call("echo", { x: null })],
			usage: { input: 10, cached: 4, output: 2, reasoning: 1 },
		},
		{ ...say("ok"), usage: { input: 20, cached: 8, output: 3, reasoning: 0 } },
	);
	const events = await drain(runTurn([], "go", tools(echo)));
	expect(events.at(-1)).toMatchObject({
		usage: { input: 30, cached: 12, output: 5, reasoning: 1 },
	});
});

test("calls run in parallel; events in finish order, results in call order", async () => {
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
	replies.push(
		{ items: [call("wait", { ms: 50 }), call("wait", { ms: 5 })] },
		say("ok"),
	);
	const history: ResponseInputItem[] = [];
	const events = await drain(runTurn(history, "go", tools(wait)));
	expect(peak).toBe(2);
	expect(
		events.flatMap((e) => (e.type === "tool_finished" ? [e.output] : [])),
	).toEqual(["waited 5", "waited 50"]);
	expect(outputs(history)).toEqual(["waited 50", "waited 5"]);
});

test("unknown tool, bad JSON and a throwing tool go back as errors", async () => {
	const boom = tool("boom", none, async () => {
		throw new Error("disk on fire");
	});
	replies.push(
		{ items: [call("nope", {}), call("echo", "{oops"), call("boom", {})] },
		say("ok"),
	);
	const history: ResponseInputItem[] = [];
	const events = await drain(runTurn(history, "go", tools(echo, boom)));
	expect(outputs(history)).toEqual([
		'error: unknown tool "nope"',
		"error: arguments are not valid JSON",
		"error: disk on fire",
	]);
	expect(events.at(-1)).toMatchObject({ stopReason: "done" });
});

test("injected prompts join after the tool results, before the next round", async () => {
	replies.push({ items: [call("echo", { x: null })] }, say("ok"));
	const history: ResponseInputItem[] = [];
	let asked = 0;
	await drain(
		runTurn(history, "go", {
			...tools(echo),
			inject: () => (++asked === 1 ? ["also this"] : []),
		}),
	);
	expect(bodies[1].input.slice(-2)).toEqual([
		expect.objectContaining({ type: "function_call_output" }),
		{ role: "user", content: "also this" },
	]);
});

test("an API error ends the turn with the error, not a throw", async () => {
	replies.push({ status: 400 });
	const history: ResponseInputItem[] = [];
	const events = await drain(runTurn(history, "go"));
	expect(events).toEqual([
		{
			type: "turn_finished",
			stopReason: "error",
			usage: zero,
			error: expect.stringContaining("400"),
		},
	]);
	expect(history).toEqual([{ role: "user", content: "go" }]);
});

test("an interrupt mid-stream keeps the partial text and stops", async () => {
	replies.push({ text: "partial", hold: true });
	const ac = new AbortController();
	const history: ResponseInputItem[] = [];
	const events: LoopEvent[] = [];
	for await (const e of runTurn(history, "write a lot", {
		signal: ac.signal,
	})) {
		events.push(e);
		if (e.type === "text") ac.abort();
	}
	expect(events.slice(-2)).toEqual([
		{ type: "message_done", text: "partial" },
		{ type: "turn_finished", stopReason: "interrupted", usage: zero },
	]);
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
	replies.push({ items: [call("echo", { x: null }), call("stuck", {})] });
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

	replies.push(say("hello again"));
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
	replies.push({ items: [reasoning, call("echo", { x: null })] }, say("ok"));
	await drain(runTurn([], "go", tools(echo)));
	expect(bodies[1].input).toContainEqual(reasoning as ResponseInputItem);
});

test("a cache that falls between rounds is warned about in the debug log", async () => {
	const dir = tempRoot();
	enableDebugLog(dir);
	try {
		replies.push(
			{
				items: [call("echo", { x: null })],
				usage: { input: 10_000, cached: 9_000, output: 2, reasoning: 0 },
			},
			{
				...say("ok"),
				usage: { input: 10_100, cached: 0, output: 2, reasoning: 0 },
			},
		);
		await drain(runTurn([], "go", { ...tools(echo), cache: cacheMonitor() }));
		const log = readdirSync(dir)
			.map((f) => readFileSync(join(dir, f), "utf8"))
			.join("");
		expect(log).toContain('"kind":"cache","level":"warn"');
		expect(log).toContain('"from":9000,"to":0');
	} finally {
		disableDebugLog();
		rmSync(dir, { recursive: true, force: true });
	}
});
