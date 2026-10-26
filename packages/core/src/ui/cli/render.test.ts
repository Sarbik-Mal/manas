import { expect, test } from "bun:test";
import { parseCommand } from "./commands";
import * as r from "./render";

const uni = { unicode: true, color: false };
const ascii = { unicode: false, color: false };

test("tool rows: first string field or short JSON, cut, Claude's symbols", () => {
	expect(r.toolStarted("read", { path: "src/app.ts", limit: null }, uni)).toBe(
		"⏺ read(src/app.ts)",
	);
	expect(r.toolStarted("wait", { ms: 5 }, uni)).toBe('⏺ wait({"ms":5})');
	expect(r.toolStarted("grep", { q: "x".repeat(70) }, uni)).toBe(
		`⏺ grep(${"x".repeat(60)}…)`,
	);
	expect(r.toolFinished("ok", "120 lines\nmore", uni)).toBe(
		"  ⎿ ok · 120 lines",
	);
	expect(r.toolFinished("error", "error: no such file", uni)).toBe(
		"  ⎿ error: no such file",
	);
	expect(r.toolFinished("interrupted", "interrupted by user", uni)).toBe(
		"  ⎿ interrupted",
	);
	expect(r.toolFinished("ok", "y".repeat(90), uni)).toBe(
		`  ⎿ ok · ${"y".repeat(80)}…`,
	);
});

test("the old console gets ASCII", () => {
	expect(r.toolStarted("read", { path: "a" }, ascii)).toBe("* read(a)");
	expect(r.toolFinished("ok", "done", ascii)).toBe("  > ok - done");
	expect(r.interrupted(ascii)).toBe("  > Interrupted");
	expect(
		r.header({ version: "1", model: "m", effort: null, cwd: "C:\\p" }, ascii),
	).toBe("manas 1 - m - C:\\p - Esc interrupts, /help");
	expect(r.detectStyle({})).toEqual({ unicode: false, color: true });
	expect(r.detectStyle({ TERM_PROGRAM: "vscode", NO_COLOR: "1" })).toEqual({
		unicode: true,
		color: false,
	});
	expect(r.detectStyle({ WT_SESSION: "x" }).unicode).toBe(true);
});

test("colors: dim tool rows, red errors, yellow warnings", () => {
	const c = { unicode: true, color: true };
	expect(r.toolStarted("read", {}, c)).toBe("\x1b[2m⏺ read({})\x1b[0m");
	expect(r.notice("error", "x", c)).toBe("\x1b[31mx\x1b[0m");
	expect(r.notice("warn", "x", c)).toBe("\x1b[33mx\x1b[0m");
	expect(
		r.header({ version: "1", model: "m", effort: "high", cwd: "p" }, uni),
	).toBe("manas 1 · m (high) · p · Esc interrupts, /help");
});

test("commands", () => {
	expect(parseCommand("hello")).toBeUndefined();
	expect(parseCommand("/ not a command")).toBeUndefined();
	for (const name of ["help", "exit", "clear", "doctor"]) {
		expect(parseCommand(`/${name}`)).toEqual({ name } as never);
	}
	expect(parseCommand(" /model gpt-4o-mini ")).toEqual({
		name: "model",
		arg: "gpt-4o-mini",
	});
	expect(parseCommand("/effort")).toEqual({ name: "effort", arg: undefined });
	expect(parseCommand("/rewind")).toEqual({ name: "unknown", text: "/rewind" });
});
