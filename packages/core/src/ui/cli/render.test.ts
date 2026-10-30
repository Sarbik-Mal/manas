import { expect, test } from "bun:test";
import { parseCommand } from "./commands";
import * as r from "./render";

const uni = { unicode: true, color: false };
const ascii = { unicode: false, color: false };

test("a rewind lists what it can't put back", () => {
	const lost = { unrestorable: ["a.txt", "b.txt"], untracked: true };
	const text = r.rewound("code", { restored: [], failed: [], ...lost }, uni);
	expect(text).toBe(
		"Restored 0 files.\nCan't be restored (a command changed them and Manas had no copy): a.txt, b.txt\nNew files weren't tracked for some commands: the project has over 100,000 files.",
	);
	expect(r.lost({ unrestorable: [], untracked: false }, uni)).toEqual([]);
});

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

test("searches and reads show a count, as in Claude Code", () => {
	const as = (name: string, input: unknown = {}) => ({ name, input });
	const row = (output: string, tool: { name: string; input: unknown }) =>
		r.toolFinished("ok", output, uni, tool);
	expect(row("dup.ts\na.ts\n(Results are truncated: …)", as("glob"))).toBe(
		"  ⎿ ok · Found 2 files",
	);
	expect(row("No files found", as("glob"))).toBe("  ⎿ ok · No files found");
	expect(row("     1\tlet a = 1;\n     2\tlet b;", as("read"))).toBe(
		"  ⎿ ok · Read 2 lines",
	);
	expect(row("File unchanged since last read.", as("read"))).toBe(
		"  ⎿ ok · File unchanged since last read.",
	);
	expect(row("a.ts", as("grep", { output_mode: null }))).toBe(
		"  ⎿ ok · Found 1 file",
	);
	expect(
		row("a.ts:1:x\n--\nb.ts:4:x", as("grep", { output_mode: "content" })),
	).toBe("  ⎿ ok · Found 2 lines");
	expect(row("No matches found", as("grep"))).toBe("  ⎿ ok · No matches found");
	expect(row("ran: ls", as("powershell"))).toBe("  ⎿ ok · ran: ls");
});

test("the old console gets ASCII", () => {
	expect(r.toolStarted("read", { path: "a" }, ascii)).toBe("* read(a)");
	expect(r.toolFinished("ok", "done", ascii)).toBe("  > ok - done");
	expect(r.interrupted(ascii)).toBe("  > Interrupted");
	expect(
		r.header(
			{ version: "1", model: "m", effort: null, mode: "manual", cwd: "C:\\p" },
			ascii,
		),
	).toBe("manas 1 - m - vibe-check - C:\\p - Esc interrupts, /help");
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
		r.header(
			{
				version: "1",
				model: "m",
				effort: "high",
				mode: "acceptEdits",
				cwd: "p",
			},
			uni,
		),
	).toBe("manas 1 · m (high) · lowkey · p · Esc interrupts, /help");
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
	expect(parseCommand("/plan")).toEqual({ name: "unknown", text: "/plan" });
});

test("rewind rows: a prompt, or the undo / redo of the last code rewind", () => {
	const now = Date.parse("2026-10-27T10:00:00Z");
	const time = "2026-10-27T09:58:00Z";
	expect(
		r.rewindRow(
			2,
			{ checkpoint_id: "c1", prompt: "fix it", time, undo: null },
			now,
			uni,
		),
	).toBe("2. fix it · 2 min ago");
	const undo = {
		kind: "undo" as const,
		prompt: "fix it",
		paths: ["a.ts", "b.ts"],
	};
	const point = { checkpoint_id: "c3", prompt: null, time, undo };
	expect(r.rewindRow(1, point, now, uni)).toBe(
		'1. ↶ Undo rewind to "fix it" · a.ts, b.ts · 2 min ago',
	);
	expect(
		r.rewindRow(1, { ...point, undo: { ...undo, kind: "redo" } }, now, ascii),
	).toBe('1. Redo rewind to "fix it" - a.ts, b.ts - 2 min ago');
});

test("modes: the prompt marker, the switch line, option 2's wording", () => {
	expect(r.promptText("acceptEdits")).toBe("lowkey > ");
	expect(r.promptText("manual")).toBe("> ");
	expect(r.modeSwitched("acceptEdits", uni)).toBe(
		"lowkey on: edits in this project run without asking (Shift+Tab to change)",
	);
	expect(r.rememberLabel({ mode: "acceptEdits" })).toBe(
		"Yes, and switch to lowkey for this session",
	);
	expect(
		r.rememberLabel({
			rules: ["PowerShell(npm test *)"],
			destination: "project",
		}),
	).toBe("Yes, and don't ask again for PowerShell(npm test *) in this project");
	expect(
		r.rememberLabel({ rules: ["Edit(//d/x/**)"], destination: "session" }),
	).toBe("Yes, and allow Edit(//d/x/**) for this session");
});
