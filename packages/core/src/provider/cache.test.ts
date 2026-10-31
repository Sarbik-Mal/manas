import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { disableDebugLog, enableDebugLog } from "../log/debug";
import { tempRoot } from "../testing/fake-openai";
import { cacheMonitor } from "./cache";

let dir: string;
beforeEach(() => {
	dir = tempRoot();
	enableDebugLog(dir);
});
afterEach(() => {
	disableDebugLog();
	rmSync(dir, { recursive: true, force: true });
});
const lines = () =>
	readdirSync(dir)
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

const tool = (name: string) => ({ name, description: name });
const req = (over = {}) => ({
	model: "gpt-5.6-luna",
	effort: "medium",
	instructions: "SECRET-INSTRUCTIONS",
	tools: [tool("read"), tool("edit")],
	input: ["a", "b", "c"],
	...over,
});
const use = (cached: number) => ({ input: 10_000, cached });

// A clock the test moves.
const clock = () => {
	let t = 0;
	return Object.assign(() => t, { tick: (ms: number) => (t += ms) });
};

test("steady hits, the first request and a small fall log nothing", () => {
	const watch = cacheMonitor();
	watch(req(), use(0));
	watch(req({ input: ["a", "b", "c", "d"] }), use(9_800));
	watch(req({ input: ["a", "b", "c", "d", "e"] }), use(9_900));
	// 95% of 9,900 is 9,405, so 9,500 is not a drop.
	watch(req({ input: ["a", "b", "c", "d", "e", "f"] }), use(9_500));
	expect(lines()).toEqual([]);
});

test("a fall under 2,000 tokens is not a break even below 95%", () => {
	const watch = cacheMonitor();
	watch(req(), use(1_900));
	watch(req(), use(0));
	expect(lines()).toEqual([]);
});

test("a break with nothing changed is unexplained, or an idle gap", () => {
	const now = clock();
	const watch = cacheMonitor(now);
	watch(req(), use(9_000));
	now.tick(60_000);
	watch(req(), use(0));
	now.tick(6 * 60_000);
	watch(req(), use(9_000));
	now.tick(6 * 60_000);
	watch(req(), use(0));
	const [a, b] = lines();
	expect(a).toMatchObject({
		kind: "cache",
		level: "warn",
		expected: false,
		from: 9_000,
		to: 0,
		input: 10_000,
		causes: ["unexplained"],
		idleMs: 60_000,
	});
	expect(b).toMatchObject({ level: "warn", causes: ["idle_over_5min"] });
});

test("changed tools or instructions warn and count the tools", () => {
	const watch = cacheMonitor();
	watch(req(), use(9_000));
	watch(req({ tools: [tool("read"), tool("grep"), tool("glob")] }), use(0));
	watch(req({ tools: [tool("read")], instructions: "other" }), use(9_000));
	watch(req({ tools: [tool("read")], instructions: "third" }), use(0));
	const [a, b] = lines();
	expect(a).toMatchObject({
		level: "warn",
		causes: ["tools_changed"],
		toolsAdded: 2,
		toolsRemoved: 1,
	});
	expect(b).toMatchObject({ level: "warn", causes: ["instructions_changed"] });
	expect(b.toolsAdded).toBeUndefined();
});

test("a model or effort change the user made is expected, logged at info", () => {
	const watch = cacheMonitor();
	watch(req(), use(9_000));
	watch(req({ effort: "high" }), use(0));
	watch(req({ effort: "high", model: "gpt-4o-mini" }), use(9_000));
	watch(
		req({ effort: "high", model: "gpt-4o-mini", verbosity: "low" }),
		use(0),
	);
	const [a, b] = lines();
	expect(a).toMatchObject({
		level: "info",
		expected: true,
		causes: ["effort_changed"],
	});
	// The model changed on the request after that, which hit: nothing to say.
	expect(lines()).toHaveLength(2);
	expect(b).toMatchObject({ level: "warn", causes: ["verbosity_changed"] });
});

test("an edited earlier item warns with its index; a shorter history is a rewind", () => {
	const watch = cacheMonitor();
	watch(req(), use(9_000));
	watch(req({ input: ["a", "X", "c", "d"] }), use(0));
	watch(req({ input: ["a", "X", "c", "d"] }), use(9_000));
	watch(req({ input: ["a", "X"] }), use(0));
	const [a, b] = lines();
	expect(a).toMatchObject({
		level: "warn",
		causes: ["history_rewritten"],
		firstChanged: 1,
	});
	expect(b).toMatchObject({
		level: "info",
		expected: true,
		causes: ["history_shortened"],
	});
});

test("a round without usage is skipped and keeps the baseline", () => {
	const watch = cacheMonitor();
	watch(req(), use(9_000));
	watch(req({ tools: [] }), undefined);
	expect(lines()).toEqual([]);
	watch(req(), use(0));
	expect(lines()).toHaveLength(1);
});

test("the log holds numbers and names only, never the prompt or tool text", () => {
	const watch = cacheMonitor();
	watch(req(), use(9_000));
	watch(req({ instructions: "changed", tools: [tool("grep")] }), use(0));
	const text = readdirSync(dir)
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.join("");
	expect(text).toContain('"kind":"cache"');
	expect(text).not.toContain("SECRET");
	expect(text).not.toContain("grep");
});
