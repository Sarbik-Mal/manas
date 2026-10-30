import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { parseRule, type Rule, type Rules, toolKey } from "../config/settings";
import { parseBash, toWindows } from "./bash";
import {
	changesLocation,
	flagged,
	flaggedBash,
	SECRET,
	unquote,
} from "./checks";
import { type ParseResult, parsePowerShell } from "./powershell";
import { bashReadOnly } from "./readonly";

// The permission engine (tools.md, settings.md): rules first, deny, then ask,
// then allow; then the defaults. Matching follows Claude Code's rules, so
// rules written for it mean the same here.

// What the engine needs from a tool. Shells give their command, file tools
// their path; the registry's tools carry these fields.
export type Checked = {
	name: string;
	readOnly: boolean;
	permission?: {
		command?: (input: unknown) => string;
		path?: (input: unknown) => string;
	};
};
// What "Yes, and don't ask again" would do: add rules to a settings file
// (or this session), or switch to lowkey.
export type Destination = "session" | "project" | "user";
export type Suggestion =
	| { rules: string[]; destination: Destination }
	| { mode: "acceptEdits" };
export type Decision =
	| { behavior: "allow"; reason: string }
	| { behavior: "deny"; reason: string; rule: string }
	| { behavior: "ask"; reason: string; suggestions: Suggestion[] };
export type Context = {
	rules: Rules;
	session: Rule[]; // "don't ask again this session"
	cwd: string; // the project: anchors rules, bounds lowkey
	here?: string; // where relative paths resolve (the shell's folder), or cwd
	home?: string;
	mode?: Mode;
	scratch?: string; // the session's scratchpad (3.4)
};

// --- Modes (architecture.md §8) ---

export type Mode = "manual" | "acceptEdits";
export const MODE_NAMES: Record<Mode, string> = {
	manual: "vibe-check",
	acceptEdits: "lowkey",
};
const ALIASES: Record<string, string> = {
	"vibe-check": "manual",
	lowkey: "acceptEdits",
	scheming: "plan",
	"let-it-cook": "auto",
	ghost: "dontAsk",
};
const LATER: Record<string, string> = {
	plan: "scheming (plan) comes in 6.4",
	auto: "let-it-cook (auto) comes in 8.5",
	dontAsk: "ghost (dontAsk) comes in 8.7",
};

// A plain or display name, any case. Throws for unknown modes and the ones
// not built yet.
export function parseMode(name: string): Mode {
	const lower = name.toLowerCase();
	const plain =
		ALIASES[lower] ??
		[...Object.keys(MODE_NAMES), ...Object.keys(LATER)].find(
			(m) => m.toLowerCase() === lower,
		);
	if (plain === "manual" || plain === "acceptEdits") return plain;
	const ok = "vibe-check (manual) or lowkey (acceptEdits)";
	if (plain && LATER[plain]) throw new Error(`${LATER[plain]}; for now: ${ok}`);
	throw new Error(`unknown mode "${name}": ${ok}`);
}

// Still ask in lowkey, at any depth (Claude Code's list, .manas for .claude).
const PROTECTED = new Set([
	".git",
	".vscode",
	".idea",
	".husky",
	".manas",
	".npmrc",
	".mcp.json",
]);

type Part = ParseResult["commands"][number];

// A rule's tool also covers its siblings, as in Claude Code.
const COVERS: Record<string, string[]> = {
	edit: ["edit", "write", "notebookedit"],
	read: ["read", "grep", "glob"],
};
const covers = (ruleTool: string, toolName: string) =>
	(COVERS[toolKey(ruleTool)] ?? [toolKey(ruleTool)]).includes(
		toolKey(toolName),
	);

export async function decide(
	tool: Checked,
	input: unknown,
	ctx: Context,
): Promise<Decision> {
	const home = ctx.home ?? homedir();
	const here = ctx.here ?? ctx.cwd;
	const command = tool.permission?.command?.(input);
	const bash = toolKey(tool.name) === "bash";
	const parsed = command === undefined ? undefined : await parse(command, bash);
	const target = tool.permission?.path?.(input);
	const path = target === undefined ? undefined : posix(resolve(here, target));
	// An edit lowkey may run: in the project (after links), not protected.
	const editable =
		target !== undefined &&
		covers("edit", tool.name) &&
		inProject(resolve(here, target), ctx.cwd);

	// Does `rule` cover this call? For a command: any part (deny, ask) or one
	// given part (allow).
	const hits = (rule: Rule, part?: Part) => {
		const r = parseRule(rule.text);
		if (!r || !covers(r.tool, tool.name)) return false;
		if (r.specifier === undefined) return true;
		if (parsed) {
			const parts = part ? [part] : parsed.commands;
			return parts.some((p) => commandMatches(r.specifier as string, p));
		}
		if (path) return pathMatches(r.specifier, path, rule.base, ctx.cwd, home);
		return false; // domain:, agent types: matched once those tools exist
	};

	for (const rule of ctx.rules.deny) {
		if (hits(rule)) {
			return {
				behavior: "deny",
				reason: `denied by your settings (${rule.text})`,
				rule: rule.text,
			};
		}
	}
	for (const rule of ctx.rules.ask) {
		if (hits(rule)) {
			return {
				behavior: "ask",
				reason: `your settings ask first (${rule.text})`,
				suggestions: [],
			};
		}
	}
	// Too long to review at a glance: asks whatever the rules say, as in
	// Claude Code.
	if (command !== undefined && command.length > MAX_COMMAND)
		return {
			behavior: "ask",
			reason: "the command is longer than 10,000 characters",
			suggestions: [],
		};
	// The scratchpad's files are the session's own, in every mode (Claude
	// Code's rule); protected names there still ask.
	if (
		target !== undefined &&
		ctx.scratch &&
		covers("edit", tool.name) &&
		inProject(resolve(here, target), ctx.scratch)
	)
		return { behavior: "allow", reason: "scratchpad: a file for this session" };
	if (ctx.mode === "acceptEdits" && editable)
		return { behavior: "allow", reason: "lowkey: an edit in the project" };
	const allows = [...ctx.rules.allow, ...ctx.session];
	const bare = allows.find((rule) => {
		const r = parseRule(rule.text);
		return r && r.specifier === undefined && covers(r.tool, tool.name);
	});
	if (bare) return { behavior: "allow", reason: `allowed by ${bare.text}` };

	if (parsed) {
		// Asks whatever specific allow rules say; approved once only.
		const flag = bash ? flaggedBash(parsed) : flagged(parsed);
		if (flag) return { behavior: "ask", reason: flag, suggestions: [] };
		// After a cd, relative paths can't be checked against the folder the
		// command started in (Claude Code asks there too).
		const lowkey = ctx.mode === "acceptEdits" && !changesLocation(parsed);
		// An allow rule covers a part only with plain arguments: `$p` or
		// `(...)` could be anything.
		const open = parsed.commands.filter(
			(p) =>
				!(bash ? p.plain && bashReadOnly(p.name ?? "", p.args) : readOnly(p)) &&
				!(p.plain && allows.some((rule) => hits(rule, p))) &&
				!(
					lowkey &&
					(bash ? fileCommand(p, here, ctx.cwd) : fileCmdlet(p, here, ctx.cwd))
				),
		);
		if (open.length === 0)
			return { behavior: "allow", reason: "read-only or allowed" };
		// A rule couldn't cover a part with variables, so none is offered.
		const rules = [
			...new Set(
				open
					.filter((p) => p.plain)
					.map((p) => suggestCommand(p, bash ? "Bash" : "PowerShell")),
			),
		].slice(0, 5);
		return {
			behavior: "ask",
			reason: open.every((p) => p.plain)
				? "this command can change things"
				: "an argument is a variable or an expression, which can't be checked ahead",
			suggestions: rules.length > 0 ? [{ rules, destination: "project" }] : [],
		};
	}
	if (allows.some((rule) => hits(rule)))
		return { behavior: "allow", reason: "allowed by your settings" };
	if (tool.readOnly) return { behavior: "allow", reason: "read-only" };
	// As in Claude Code: an edit in the project offers lowkey; anything else
	// a rule for this session (file approvals aren't saved).
	return {
		behavior: "ask",
		reason: `${tool.name} can change things`,
		suggestions: [
			editable
				? { mode: "acceptEdits" }
				: {
						rules: [
							path
								? suggestPath(tool.name, path, ctx.cwd)
								: ruleName(tool.name),
						],
						destination: "session",
					},
		],
	};
}

// `abs` is `cwd` or inside it, once links are followed.
export function within(abs: string, cwd: string) {
	const rel = relative(real(cwd), real(abs));
	return !rel.startsWith("..") && !isAbsolute(rel);
}

// Inside `cwd` once links are followed (a junction out doesn't count), and
// not under a protected name.
function inProject(abs: string, cwd: string) {
	const rel = relative(real(cwd), real(abs));
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
	return !rel.split(/[\\/]/).some((part) => PROTECTED.has(part.toLowerCase()));
}

// The real path of the nearest folder that exists, plus the rest.
function real(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		const up = dirname(p);
		return up === p ? p : join(real(up), basename(p));
	}
}

// The bare deny rule covering a whole tool, if any (it's left out of the
// tool list at session start).
export function deniedBy(name: string, rules: Rules) {
	return rules.deny.find((rule) => {
		const r = parseRule(rule.text);
		return r && r.specifier === undefined && covers(r.tool, name);
	})?.text;
}

// The deny rule that stops reading `path`, if any. Search tools drop such
// files from their results, as Claude Code applies Read rules to Grep and Glob.
export function deniedPath(
	path: string,
	rules: Rules,
	cwd: string,
	home = homedir(),
) {
	const target = posix(resolve(cwd, path));
	return rules.deny.find((rule) => {
		const r = parseRule(rule.text);
		return (
			r?.specifier !== undefined &&
			covers(r.tool, "read") &&
			pathMatches(r.specifier, target, rule.base, cwd, home)
		);
	})?.text;
}

async function parse(command: string, bash: boolean): Promise<ParseResult> {
	try {
		return await (bash ? parseBash(command) : parsePowerShell(command));
	} catch (err) {
		return {
			errors: [(err as Error).message],
			commands: [],
			redirections: [],
			invocations: [],
			subexpressions: false,
			expandable: false,
			splatting: false,
			stopParsing: false,
			types: [],
			scopedAssignments: [],
			usings: false,
			requires: false,
			background: false,
		};
	}
}

// --- Commands ---

// `npm test *` matches `npm test` and `npm test --watch`, not `npm testx`.
// Case-insensitive; tried on the canonical name (dir → Get-ChildItem) and on
// the name as typed.
function commandMatches(pattern: string, part: Part) {
	const p = pattern.trim();
	const optionalRest = p.endsWith(" *");
	const body = (optionalRest ? p.slice(0, -2) : p)
		.split("*")
		.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	const re = new RegExp(`^${body}${optionalRest ? "( .*)?" : ""}$`, "is");
	const args = part.args.join(" ");
	return [part.resolved, part.name].some(
		(n) => n !== null && re.test(`${n} ${args}`.trim()),
	);
}

const VERBS = new Set(
	"get test measure select sort group format compare resolve split join convertfrom convertto".split(
		" ",
	),
);
const READ_CMDLETS = new Set(["where-object", "set-location", "write-output"]);
const NEVER = new Set(
	"invoke-expression iex invoke-webrequest iwr invoke-restmethod irm curl wget cmdkey".split(
		" ",
	),
);
// tools.md's read-only allowlist, minus everything never auto-allowed (the
// rest of that list is in checks.ts). Plain arguments only: `Get-Content $p`
// could read anything.
export function readOnly(part: Part): boolean {
	if (!part.plain) return false;
	const name = (part.resolved ?? part.name ?? "")
		.toLowerCase()
		.replace(/\.exe$/, "");
	const args = part.args.map((a) => a.replace(/^['"]|['"]$/g, ""));
	if (NEVER.has(name) || NEVER.has((part.name ?? "").toLowerCase()))
		return false;
	for (const a of args) {
		const base = a.split(/[\\/]/).pop() ?? "";
		if (SECRET.some((s) => s.test(base))) return false;
	}
	if (
		part.type === "Cmdlet" ||
		part.type === "Function" ||
		part.type === "Alias"
	) {
		// Built-in Microsoft modules only: a third-party Get-* asks.
		if (!part.module?.startsWith("Microsoft.")) return false;
		return VERBS.has(name.split("-")[0]) || READ_CMDLETS.has(name);
	}
	if (args.length === 1 && args[0] === "--version") return true;
	if (["where", "whoami", "hostname"].includes(name)) return true;
	const [sub] = args;
	// Claude Code's git tables, shared with bash (3.5).
	if (name === "git") return bashReadOnly("git", args);
	if (name === "npm") return sub === "ls";
	if (name === "pip" || name === "pip3")
		return ["list", "show", "freeze"].includes(sub);
	return false;
}

const MAX_COMMAND = 10_000;

// Claude Code's lowkey cmdlets, with the parameters each may use (any other
// asks). Paths come from -Path and the like, or the first positional;
// set/add-content take the value as the second positional.
const PATH_PARAMS = ["-path", "-literalpath", "-pspath", "-lp"];
const SHARED = ["-force", "-whatif", "-confirm", "-usetransaction"];
const FILTERS = ["-filter", "-include", "-exclude", "-credential", "-stream"];
const CONTENT = {
	switches: [...SHARED, "-passthru", "-nonewline", "-asbytestream"],
	values: [...FILTERS, "-value", "-encoding"],
	value: true,
};
const FILE_CMDLETS: Record<
	string,
	{ switches: string[]; values: string[]; value: boolean }
> = {
	"set-content": CONTENT,
	"add-content": CONTENT,
	"remove-item": {
		switches: [...SHARED, "-recurse"],
		values: FILTERS,
		value: false,
	},
	"clear-content": { switches: SHARED, values: FILTERS, value: false },
};

// Does lowkey let this part through: one of the four cmdlets, known
// parameters only, every path a plain one inside the project?
function fileCmdlet(part: Part, here: string, cwd: string) {
	const spec = FILE_CMDLETS[(part.resolved ?? "").toLowerCase()];
	if (!spec || !part.module?.startsWith("Microsoft.")) return false;
	const paths: string[] = [];
	const positional: string[] = [];
	let namedPath = false;
	let namedValue = false;
	// `a.txt,b.txt` is two paths; a quoted one is one.
	const addPaths = (a: string) =>
		paths.push(...(/^['"]/.test(a) ? [a] : a.split(",")));
	for (let i = 0; i < part.args.length; i++) {
		const m = /^-(\w+)(?::(.+))?$/s.exec(part.args[i]);
		if (!m) {
			positional.push(part.args[i]);
			continue;
		}
		const flag = `-${m[1].toLowerCase()}`;
		// A switch alone, or as -Confirm:$false.
		if (
			spec.switches.includes(flag) &&
			(m[2] === undefined || /^\$(true|false)$/i.test(m[2]))
		)
			continue;
		const value = m[2] ?? part.args[++i];
		if (value === undefined) return false;
		if (PATH_PARAMS.includes(flag)) {
			namedPath = true;
			addPaths(value);
		} else if (spec.values.includes(flag)) {
			if (flag === "-value") namedValue = true;
		} else return false;
	}
	if (!namedPath && positional.length > 0) addPaths(positional.shift() ?? "");
	const valueSlots = spec.value && !namedValue ? 1 : 0;
	if (positional.length > valueSlots) return false;
	// A quote inside a positional value asks (Claude Code: use -Value).
	if (positional.some((v) => /['"]/.test(unquote(v)))) return false;
	return (
		paths.length > 0 &&
		paths.every((p) => {
			const bare = unquote(p);
			// Wildcards, variables, escapes, quotes, `~` and provider paths
			// (env:, HKCU:) can't be checked as written.
			if (!bare || /[*?[\]$`'"]/.test(bare) || bare.startsWith("~"))
				return false;
			if (bare.lastIndexOf(":") > (/^[a-z]:/i.test(bare) ? 1 : -1))
				return false;
			const name = basename(bare);
			if (name === "." || name === "..") return false;
			return inProject(resolve(here, bare), cwd);
		})
	);
}

// Claude Code's lowkey commands for bash (`cFo`): every path plain and in the
// project. sed counts only as `sed -i <script> <files>`.
const FILE_COMMANDS = new Set([
	"mkdir",
	"touch",
	"rm",
	"rmdir",
	"mv",
	"cp",
	"sed",
]);
function fileCommand(part: Part, here: string, cwd: string) {
	const name = part.name ?? "";
	if (!FILE_COMMANDS.has(name) || !part.plain) return false;
	const paths = part.args.filter((a) => !a.startsWith("-"));
	if (name === "sed") {
		const flags = part.args.filter((a) => a.startsWith("-"));
		if (!flags.every((f) => /^(-i|--in-place)$/.test(f)) || flags.length !== 1)
			return false;
		paths.shift();
	}
	return (
		paths.length > 0 &&
		paths.every((p) => {
			// Globs, `~`, variables and escapes can't be checked as written.
			if (!p || /[*?[\]$`~{}]/.test(p)) return false;
			const name = basename(p);
			if (name === "." || name === "..") return false;
			return inProject(resolve(here, toWindows(p)), cwd);
		})
	);
}

// One rule per part: the command, plus a subcommand-like first word for
// programs (`git push *`), as Claude Code suggests.
function suggestCommand(part: Part, tool: string) {
	const name = part.resolved ?? part.name ?? "";
	const first = part.args[0];
	const sub =
		part.type !== "Cmdlet" &&
		part.type !== "Alias" &&
		first &&
		/^[a-z][\w-]*$/i.test(first)
			? ` ${first}`
			: "";
	return `${tool}(${name}${sub} *)`;
}

// --- Paths ---

// `E:\a\b` → `/e/a/b`, lowercased (Windows paths ignore case).
export const posix = (p: string) =>
	p
		.replace(/\\/g, "/")
		.replace(/^([a-z]):/i, (_, d: string) => `/${d}`)
		.toLowerCase();

// gitignore-style, with Claude Code's anchors: `//abs`, `~/home`, `/` = the
// rule's settings root, anything else = the project folder. A pattern with no
// slash matches at any depth.
function pathMatches(
	spec: string,
	path: string,
	base: string,
	cwd: string,
	home: string,
) {
	let pattern: string;
	if (spec.startsWith("//")) pattern = spec.slice(1);
	else if (spec.startsWith("~/")) pattern = `${posix(home)}/${spec.slice(2)}`;
	else if (spec.startsWith("/")) pattern = `${posix(base)}${spec}`;
	else {
		const rel = spec.replace(/^\.\//, "");
		pattern = rel.includes("/")
			? `${posix(cwd)}/${rel}`
			: `${posix(cwd)}/**/${rel}`;
	}
	if (pattern.endsWith("/")) pattern += "**";
	return new Bun.Glob(pattern.toLowerCase()).match(path);
}

function suggestPath(toolName: string, path: string, cwd: string) {
	const dir = path.slice(0, path.lastIndexOf("/"));
	const rel = relative(posix(cwd), dir).replace(/\\/g, "/");
	const spec =
		rel.startsWith("..") || rel.includes(":")
			? `/${dir}/**`
			: rel
				? `${rel}/**`
				: "**";
	// Edit(...) covers write too, as in Claude Code.
	return `${covers("edit", toolName) ? "Edit" : ruleName(toolName)}(${spec})`;
}

const ruleName = (name: string) =>
	name === "powershell"
		? "PowerShell"
		: name.charAt(0).toUpperCase() + name.slice(1);
