import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	type Stats,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

// Settings files (settings.md): user, then project, then flags; later layers
// win for single values, objects merge per key, lists join, and a deny
// anywhere wins. JSONC, so comments and trailing commas are fine.

const MODES = [
	"manual",
	"acceptEdits",
	"plan",
	"auto",
	"dontAsk",
	"vibe-check",
	"lowkey",
	"scheming",
	"let-it-cook",
	"ghost",
];

// Every tool planned in tools.md, so a rule naming an unknown tool (a typo
// like "Raed") is caught instead of silently matching nothing.
const TOOLS = [
	"read",
	"edit",
	"write",
	"grep",
	"glob",
	"notebook_edit",
	"lsp",
	"powershell",
	"bash",
	"monitor",
	"task_stop",
	"run_cell",
	"run_code",
	"agent",
	"send_message",
	"list_agents",
	"ask_user",
	"enter_plan",
	"exit_plan",
	"todo",
	"probe",
	"web_fetch",
	"web_search",
	"tool_search",
	"call_tool",
	"skill",
	"cron_create",
	"cron_list",
	"cron_delete",
	"schedule_wakeup",
	"enter_worktree",
	"exit_worktree",
];

// `WebFetch` and `web_fetch` are the same tool.
export const toolKey = (name: string) => name.toLowerCase().replaceAll("_", "");
const KNOWN = new Set(TOOLS.map(toolKey));

const Strings = Type.Array(Type.String());
const closed = { additionalProperties: false } as const;

// Claude Code's hook format (3.7): command hooks on the events Manas can fire.
export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"PostToolBatch",
	"UserPromptSubmit",
	"Stop",
	"StopFailure",
	"SessionStart",
	"SessionEnd",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
// `if` only means something where there's a tool (Claude's rule).
const IF_EVENTS = new Set([
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
]);
const HookHandler = Type.Object(
	{
		type: Type.Literal("command"),
		command: Type.String({ minLength: 1 }),
		args: Type.Optional(Strings),
		shell: Type.Optional(
			Type.Union([Type.Literal("bash"), Type.Literal("powershell")]),
		),
		timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		if: Type.Optional(Type.String()),
		onFailure: Type.Optional(
			Type.Union([Type.Literal("continue"), Type.Literal("block")]),
		),
	},
	closed,
);
export type HookHandler = Static<typeof HookHandler>;
const HookMatcher = Type.Object({
	matcher: Type.Optional(Type.String()),
	hooks: Type.Array(HookHandler),
});
export type HookMatcher = Static<typeof HookMatcher>;

const KEYS = {
	$schema: Type.String(),
	mode: Type.Union(MODES.map((m) => Type.Literal(m))),
	// Names are checked against the capability table where they are used.
	models: Type.Object(
		{
			main: Type.Optional(Type.String()),
			cheap: Type.Optional(Type.String()),
			reviewer: Type.Optional(Type.String()),
		},
		closed,
	),
	effort: Type.String(),
	// How long answers are (OpenAI's text.verbosity); new sessions only.
	verbosity: Type.Union([
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
	]),
	permissions: Type.Object(
		{
			allow: Type.Optional(Strings),
			ask: Type.Optional(Strings),
			deny: Type.Optional(Strings),
		},
		closed,
	),
	environment: Type.Object(
		{ production: Type.Optional(Strings), notes: Type.Optional(Type.String()) },
		closed,
	),
	// How much of a command's ok output comes inline before it's saved to a
	// file (3.4; Claude Code's bashOutputMaxChars).
	shellOutputMaxChars: Type.Integer({ minimum: 1, maximum: 128_000 }),
	network: Type.Object({ allowDomains: Type.Optional(Strings) }, closed),
	limits: Type.Object(
		{
			parallelAgents: Type.Optional(Type.Integer({ minimum: 1 })),
			webSearchesPerTurn: Type.Optional(Type.Integer({ minimum: 0 })),
			cleanupPeriodDays: Type.Optional(Type.Integer({ minimum: 1 })),
		},
		closed,
	),
	hooks: Type.Record(Type.String(), Type.Array(HookMatcher)),
	disableAllHooks: Type.Boolean(),
} satisfies Record<string, TSchema>;

type Keys = typeof KEYS;
export type Settings = {
	[K in keyof Keys]?: Static<Keys[K]>;
};
// A rule plus the folder its `/` anchor means: the project for project and
// flag rules, ~/.manas for user rules (as Claude Code does).
export type Rule = { text: string; base: string };
export type Rules = { allow: Rule[]; ask: Rule[]; deny: Rule[] };
export type Flags = {
	model?: string;
	effort?: string;
	allow?: string[];
	deny?: string[];
};

// A mistake that could change what's allowed: Manas refuses to start.
export class SettingsError extends Error {}

export type Loaded = {
	settings: Settings;
	rules: Rules;
	warnings: string[];
	files: string[];
};

export const userFile = (home = homedir()) =>
	join(home, ".manas", "settings.json");
export const projectFile = (cwd: string) =>
	join(cwd, ".manas", "settings.json");

export function loadSettings({
	cwd,
	home = homedir(),
	flags = {},
}: {
	cwd: string;
	home?: string;
	flags?: Flags;
}): Loaded {
	const warnings: string[] = [];
	const files = [userFile(home)];
	const layers: Settings[] = [readLayer(userFile(home), warnings)];
	const bases = [join(home, ".manas")];
	const guard = gitGuard(cwd);
	if (guard) warnings.push(guard);
	else {
		files.push(projectFile(cwd));
		const project = readLayer(projectFile(cwd), warnings);
		// The cleanup covers every project, so one value: the user's.
		if (project.limits?.cleanupPeriodDays !== undefined) {
			warnings.push(
				`settings ${projectFile(cwd)}: limits.cleanupPeriodDays is ignored here; only your user settings set it, since the cleanup covers every project`,
			);
			delete project.limits.cleanupPeriodDays;
		}
		layers.push(project);
		bases.push(cwd);
	}
	const fromFlags: Settings = {};
	if (flags.model) fromFlags.models = { main: flags.model };
	if (flags.effort) fromFlags.effort = flags.effort;
	if (flags.allow || flags.deny) {
		fromFlags.permissions = { allow: flags.allow, deny: flags.deny };
		checkRules("flags", fromFlags.permissions);
	}
	layers.push(fromFlags);
	bases.push(cwd);

	const rules: Rules = { allow: [], ask: [], deny: [] };
	layers.forEach((layer, i) => {
		for (const list of ["allow", "ask", "deny"] as const) {
			for (const text of layer.permissions?.[list] ?? []) {
				const base = bases[i];
				const same = (r: Rule) => r.text === text && r.base === base;
				if (!rules[list].some(same)) rules[list].push({ text, base });
			}
		}
	});
	return { settings: merge(layers), rules, warnings, files };
}

// One file. Missing: empty. Unparseable or bad `permissions`: fatal. Any
// other bad key: a warning, and the key is dropped.
function readLayer(file: string, warnings: string[]): Settings {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	if (!text.trim()) return {};
	let raw: unknown;
	try {
		raw = Bun.JSONC.parse(text);
	} catch (err) {
		throw new SettingsError(
			`settings ${file} line ${badLine(text)}: ${(err as Error).message}`,
		);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new SettingsError(`settings ${file}: must be an object`);
	}
	const out: Record<string, unknown> = {};
	for (const [key, read] of Object.entries(raw)) {
		const schema = KEYS[key as keyof Keys];
		if (!schema) {
			warnings.push(`settings ${file}: unknown key "${key}" (ignored)`);
			continue;
		}
		const value = key === "hooks" ? cleanHooks(read, file, warnings) : read;
		const problems = Value.Errors(schema, value).map(
			(e) => `${key}${e.instancePath.replaceAll("/", ".")}: ${e.message}`,
		);
		if (key === "permissions") {
			if (problems.length > 0) {
				throw new SettingsError(`settings ${file}: ${problems.join("; ")}`);
			}
			checkRules(`settings ${file}`, value as Settings["permissions"]);
		} else if (problems.length > 0) {
			warnings.push(`settings ${file}: ${problems.join("; ")} (ignored)`);
			continue;
		}
		out[key] = value;
	}
	return out;
}

// One bad hook warns and goes; the others stay. A field Manas doesn't have
// (`async`, another `type`) drops its handler, so a hook copied from Claude Code
// never silently does something else.
function cleanHooks(raw: unknown, file: string, warnings: string[]) {
	const warn = (text: string) =>
		warnings.push(`settings ${file}: hooks.${text} (ignored)`);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const out: Record<string, HookMatcher[]> = {};
	for (const [event, list] of Object.entries(raw)) {
		if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
			warn(`${event}: not an event Manas fires`);
			continue;
		}
		if (!Array.isArray(list)) {
			warn(`${event}: must be a list`);
			continue;
		}
		for (const [i, entry] of list.entries()) {
			const hooks = (entry as { hooks?: unknown } | null)?.hooks;
			const matcher = (entry as { matcher?: unknown } | null)?.matcher;
			if (
				!Array.isArray(hooks) ||
				(matcher !== undefined && typeof matcher !== "string")
			) {
				warn(`${event}[${i}]: needs a hooks list and a text matcher`);
				continue;
			}
			const kept = hooks.filter((h, j) => {
				const at = `${event}[${i}].hooks[${j}]`;
				const bad = Value.Errors(HookHandler, h).map(
					(e) => `${e.instancePath.slice(1) || "handler"}: ${e.message}`,
				);
				if (bad.length > 0) warn(`${at}: ${bad.join("; ")}`);
				else if (h.if !== undefined && !IF_EVENTS.has(event))
					warn(`${at}: "if" only works on tool events`);
				else if (h.if !== undefined && !parseRule(h.if))
					warn(`${at}: "if" must be Tool or Tool(...)`);
				else return true;
				return false;
			}) as HookHandler[];
			if (kept.length > 0)
				out[event] = [
					...(out[event] ?? []),
					{
						...(matcher !== undefined && { matcher: matcher as string }),
						hooks: kept,
					},
				];
		}
	}
	return out;
}

// `Tool` or `Tool(specifier)`, naming a tool from tools.md.
export function parseRule(rule: string) {
	const m = /^([A-Za-z_][\w]*)(?:\((.+)\))?$/s.exec(rule.trim());
	if (!m) return undefined;
	return { tool: m[1], specifier: m[2] };
}

function checkRules(where: string, p: Settings["permissions"] = {}) {
	for (const list of ["allow", "ask", "deny"] as const) {
		for (const [i, rule] of (p[list] ?? []).entries()) {
			const at = `${where}: permissions.${list}[${i}]`;
			const parsed = parseRule(rule);
			if (!parsed) {
				throw new SettingsError(`${at}: "${rule}" is not Tool or Tool(...)`);
			}
			if (!KNOWN.has(toolKey(parsed.tool))) {
				throw new SettingsError(`${at}: unknown tool "${parsed.tool}"`);
			}
		}
	}
}

// "Yes, and don't ask again": adds an allow rule to a settings file, keeping
// its comments and layout. The file and its folder are made if missing.
// Throws if the file doesn't parse (the rule is then kept for the session).
export function saveRule(file: string, rule: string) {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {}
	const parsed = (text: string) => {
		try {
			return Bun.JSONC.parse(text || "{}") as Settings;
		} catch {
			throw new SettingsError(`settings ${file} doesn't parse`);
		}
	};
	const allow = parsed(text).permissions?.allow;
	if (Array.isArray(allow) && allow.includes(rule)) return;
	const base = text.trim() ? text : "{}\n";
	const tabs = !/\n {2}\S/.test(base);
	const next = applyEdits(
		base,
		modify(base, ["permissions", "allow", -1], rule, {
			isArrayInsertion: true,
			formattingOptions: {
				insertSpaces: !tabs,
				tabSize: tabs ? 1 : 2,
				eol: base.includes("\r\n") ? "\r\n" : "\n",
			},
		}),
	);
	if (!parsed(next).permissions?.allow?.includes(rule))
		throw new SettingsError(`settings ${file}: the rule didn't save`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next);
}

const LISTS = new Set([
	"permissions.allow",
	"permissions.ask",
	"permissions.deny",
	"environment.production",
	"network.allowDomains",
]);

// Later layers win; objects merge per key; lists join without repeats.
function merge(layers: Settings[]): Settings {
	const out: Record<string, unknown> = {};
	for (const layer of layers) {
		for (const [key, value] of Object.entries(layer)) {
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const into = (out[key] ?? {}) as Record<string, unknown>;
				for (const [k, v] of Object.entries(value)) {
					if (v === undefined) continue;
					into[k] =
						(LISTS.has(`${key}.${k}`) || key === "hooks") &&
						Array.isArray(into[k])
							? [...new Set([...(into[k] as unknown[]), ...(v as unknown[])])]
							: v;
				}
				out[key] = into;
			} else {
				out[key] = value;
			}
		}
	}
	return out as Settings;
}

// Bun's JSONC errors have no position. The first prefix of the file that
// fails for a reason other than "it ends early" ends on the bad line.
function badLine(text: string) {
	const lines = text.split("\n");
	for (let n = 1; n <= lines.length; n++) {
		try {
			Bun.JSONC.parse(lines.slice(0, n).join("\n"));
		} catch (err) {
			if (!/end of (input|file)/i.test((err as Error).message)) return n;
		}
	}
	return lines.length;
}

// settings.md: `.manas` never goes into git. It's added to the repo's local
// ignore list once; if it's tracked anyway (a cloned repo), the project's
// settings are ignored so a repo can't bring its own rules. Returns a warning.
function gitGuard(cwd: string): string | undefined {
	const git = (...args: string[]) => {
		try {
			const r = Bun.spawnSync(["git", ...args], { cwd });
			return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
		} catch {
			return undefined; // git isn't installed
		}
	};
	const exclude = git("rev-parse", "--git-path", "info/exclude");
	if (exclude === undefined) return undefined;
	if (git("ls-files", ".manas")) {
		return `${projectFile(cwd)} is tracked in git, so it was ignored. Settings in a repo could change what Manas may do; keep .manas out of git.`;
	}
	const file = resolve(cwd, exclude);
	let current = "";
	try {
		current = readFileSync(file, "utf8");
	} catch {}
	if (!current.split(/\r?\n/).includes(".manas/")) {
		try {
			const sep = current && !current.endsWith("\n") ? "\n" : "";
			appendFileSync(file, `${sep}.manas/\n`);
		} catch {}
	}
	return undefined;
}

// Calls `onChange` when any of `files` changes (or appears or disappears).
// ponytail: polls with fs.watchFile, which also covers files that don't exist
// yet; switch to fs.watch if a 1 s delay ever matters.
export function watchSettings(
	files: string[],
	onChange: () => void,
	intervalMs = 1000,
) {
	// Bun fires once for a file that doesn't exist, with nothing changed;
	// only a real change (or the file appearing or going) counts.
	const listener = (curr: Stats, prev: Stats) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) onChange();
	};
	for (const f of files) watchFile(f, { interval: intervalMs }, listener);
	return () => {
		for (const f of files) unwatchFile(f, listener);
	};
}

// The settings in use, swapped on reload. A broken reload keeps the last good
// ones, so rules never silently vanish.
export function liveSettings(load: () => Loaded, intervalMs?: number) {
	let current = load();
	const listeners = new Set<(e: { ok: boolean; error?: string }) => void>();
	const stop = watchSettings(
		current.files,
		() => {
			try {
				current = load();
				for (const l of listeners) l({ ok: true });
			} catch (err) {
				for (const l of listeners)
					l({ ok: false, error: (err as Error).message });
			}
		},
		intervalMs,
	);
	return {
		get current() {
			return current;
		},
		subscribe(l: (e: { ok: boolean; error?: string }) => void) {
			listeners.add(l);
			return () => {
				listeners.delete(l);
			};
		},
		stop,
	};
}
export type LiveSettings = ReturnType<typeof liveSettings>;
