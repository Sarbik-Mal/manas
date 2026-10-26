import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../testing/fake-openai";
import {
	liveSettings,
	loadSettings,
	projectFile,
	SettingsError,
	userFile,
} from "./settings";

// A temp home and project folder (not a git repo unless asked).
function setup(user?: string, project?: string) {
	const home = tempRoot();
	const cwd = tempRoot();
	const put = (file: string, text?: string) => {
		if (text === undefined) return;
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, text);
	};
	put(userFile(home), user);
	put(projectFile(cwd), project);
	return {
		home,
		cwd,
		load: (flags = {}) => loadSettings({ cwd, home, flags }),
	};
}

test("no files: nothing set, no warnings", () => {
	expect(setup().load()).toMatchObject({
		settings: {},
		rules: { allow: [], ask: [], deny: [] },
		warnings: [],
	});
});

test("layers: flags > project > user; objects merge per key; lists join", () => {
	const { load } = setup(
		`{
			// JSONC: comments and trailing commas are fine
			"effort": "low",
			"models": { "main": "gpt-5.6-luna", "cheap": "gpt-4o-mini", },
			"permissions": { "deny": ["Read"], "allow": ["Grep"] },
			"limits": { "parallelAgents": 2 },
		}`,
		`{
			"effort": "medium",
			"models": { "main": "gpt-4o-mini" },
			"permissions": { "deny": ["PowerShell(rm *)", "Read"] },
			"limits": { "scratchpadMB": 10 },
		}`,
	);
	const { settings, rules } = load({ effort: "high", deny: ["web_fetch"] });
	expect(settings.effort).toBe("high");
	expect(settings.models).toEqual({
		main: "gpt-4o-mini",
		cheap: "gpt-4o-mini",
	});
	expect(settings.limits).toEqual({ parallelAgents: 2, scratchpadMB: 10 });
	expect(rules).toEqual({
		allow: ["Grep"],
		ask: [],
		deny: ["Read", "PowerShell(rm *)", "web_fetch"],
	});
});

test("fatal: anything that could change what's allowed", () => {
	const fatal: [string, string][] = [
		[
			'{\n  "effort": "low"\n  "mode": "manual"\n}',
			"line 3: JSONC Parse error",
		],
		[
			'{ "permissions": { "deny": "Read" } }',
			"permissions.deny: must be array",
		],
		[
			'{ "permissions": { "deny": ["Read("] } }',
			'permissions.deny[0]: "Read(" is not Tool or Tool(...)',
		],
		[
			'{ "permissions": { "deny": ["Edit", "Raed"] } }',
			'permissions.deny[1]: unknown tool "Raed"',
		],
		[
			'{ "permissions": { "dney": ["Read"] } }',
			"permissions: must not have additional properties",
		],
		["[1, 2]", "must be an object"],
	];
	for (const [text, message] of fatal) {
		const { load, home } = setup(text);
		expect(load).toThrow(SettingsError);
		expect(load).toThrow(message);
		expect(load).toThrow(userFile(home));
	}
	expect(() => setup().load({ deny: ["Raed"] })).toThrow(
		'flags: permissions.deny[0]: unknown tool "Raed"',
	);
});

test("warnings: other mistakes drop just that key", () => {
	const { load } = setup(
		'{ "effort": 5, "mode": "yolo", "colour": "red", "limits": { "cleanupPeriodDays": 0 }, "models": { "main": "gpt-4o-mini" } }',
	);
	const { settings, warnings } = load();
	expect(settings).toEqual({ models: { main: "gpt-4o-mini" } });
	expect(warnings).toHaveLength(4);
	expect(warnings.join("\n")).toContain("effort: must be string (ignored)");
	expect(warnings.join("\n")).toContain('unknown key "colour" (ignored)');
	expect(warnings.join("\n")).toContain(
		"limits.cleanupPeriodDays: must be >= 1",
	);
});

test("git guard: a tracked .manas is ignored; otherwise it's excluded once", () => {
	const git = (cwd: string, ...args: string[]) =>
		Bun.spawnSync(
			["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
			{ cwd },
		);
	const tracked = setup(undefined, '{ "effort": "max" }');
	git(tracked.cwd, "init", "-q");
	git(tracked.cwd, "add", "-f", ".manas/settings.json");
	git(tracked.cwd, "commit", "-q", "-m", "x");
	const a = tracked.load();
	expect(a.settings).toEqual({});
	expect(a.warnings[0]).toContain("is tracked in git, so it was ignored");

	const fine = setup(undefined, '{ "effort": "max" }');
	git(fine.cwd, "init", "-q");
	expect(fine.load().settings).toEqual({ effort: "max" });
	fine.load();
	const exclude = readFileSync(
		join(fine.cwd, ".git", "info", "exclude"),
		"utf8",
	);
	expect(exclude.split("\n").filter((l) => l === ".manas/")).toHaveLength(1);
});

test("live: a change is picked up; a broken file keeps the last good settings", async () => {
	const { cwd, home } = setup('{ "effort": "low" }');
	const live = liveSettings(() => loadSettings({ cwd, home }), 10);
	const events: { ok: boolean; error?: string }[] = [];
	live.subscribe((e) => events.push(e));
	const waitFor = async (n: number) => {
		for (let i = 0; i < 300 && events.length < n; i++) await Bun.sleep(10);
	};
	writeFileSync(userFile(home), '{ "permissions": { "deny": ["Read"] } }');
	await waitFor(1);
	expect(events[0]).toEqual({ ok: true });
	expect(live.current.rules.deny).toEqual(["Read"]);
	writeFileSync(userFile(home), '{ "permissions": { "deny": ["Read" } }');
	await waitFor(2);
	expect(events[1]).toMatchObject({
		ok: false,
		error: expect.stringContaining("line 1"),
	});
	expect(live.current.rules.deny).toEqual(["Read"]);
	live.stop();
});
