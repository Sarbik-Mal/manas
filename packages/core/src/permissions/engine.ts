import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { parseRule, type Rule, type Rules, toolKey } from "../config/settings";
import { type ParseResult, parsePowerShell } from "./powershell";

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
export type Decision =
	| { behavior: "allow"; reason: string }
	| { behavior: "deny"; reason: string; rule: string }
	| { behavior: "ask"; reason: string; suggestions: string[] };
export type Context = {
	rules: Rules;
	session: Rule[]; // "don't ask again this session"
	cwd: string;
	home?: string;
};

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
	const command = tool.permission?.command?.(input);
	const parsed = command === undefined ? undefined : await parse(command);
	const target = tool.permission?.path?.(input);
	const path =
		target === undefined ? undefined : posix(resolve(ctx.cwd, target));

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
	const allows = [...ctx.rules.allow, ...ctx.session];
	const bare = allows.find((rule) => {
		const r = parseRule(rule.text);
		return r && r.specifier === undefined && covers(r.tool, tool.name);
	});
	if (bare) return { behavior: "allow", reason: `allowed by ${bare.text}` };

	if (parsed) {
		const unclear = unclearReason(parsed);
		if (unclear) {
			return { behavior: "ask", reason: unclear, suggestions: [] };
		}
		const open = parsed.commands.filter(
			(p) => !readOnly(p) && !allows.some((rule) => hits(rule, p)),
		);
		if (open.length === 0)
			return { behavior: "allow", reason: "read-only or allowed" };
		return {
			behavior: "ask",
			reason: "this command can change things",
			suggestions: [...new Set(open.map(suggestCommand))].slice(0, 5),
		};
	}
	if (allows.some((rule) => hits(rule)))
		return { behavior: "allow", reason: "allowed by your settings" };
	if (tool.readOnly) return { behavior: "allow", reason: "read-only" };
	return {
		behavior: "ask",
		reason: `${tool.name} can change things`,
		suggestions: [
			path ? suggestPath(tool.name, path, ctx.cwd) : ruleName(tool.name),
		],
	};
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

// Why `command` isn't read-only, or undefined if every part is.
export async function notReadOnly(command: string) {
	const parsed = await parse(command);
	const unclear = unclearReason(parsed);
	if (unclear) return unclear;
	const open = parsed.commands.filter((p) => !readOnly(p));
	if (open.length === 0) return undefined;
	const names = open.map((p) => p.resolved ?? p.name);
	return `${[...new Set(names)].join(", ")} can change things or read secrets`;
}

async function parse(command: string): Promise<ParseResult> {
	try {
		return await parsePowerShell(command);
	} catch (err) {
		return {
			errors: [(err as Error).message],
			commands: [],
			redirections: [],
			invocations: [],
		};
	}
}

// Anything the parser can't vouch for asks, whatever the allowlist says.
function unclearReason(p: ParseResult) {
	if (p.errors.length > 0) return "the command didn't parse";
	if (p.commands.some((c) => c.name === null))
		return "the command runs something chosen at run time";
	if (p.invocations.length > 0) return "the command calls .NET methods";
	if (p.redirections.length > 0) return "the command writes to a file";
	return undefined;
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
const GIT_READ = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"ls-files",
	"rev-parse",
]);
const SECRET = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /^id_rsa/i];

// tools.md's read-only allowlist, minus everything never auto-allowed.
export function readOnly(part: Part): boolean {
	const name = (part.resolved ?? part.name ?? "")
		.toLowerCase()
		.replace(/\.exe$/, "");
	const args = part.args.map((a) => a.replace(/^['"]|['"]$/g, ""));
	if (NEVER.has(name) || NEVER.has((part.name ?? "").toLowerCase()))
		return false;
	for (const a of args) {
		if (/(^|\$)env:/i.test(a)) return false; // env vars often hold keys
		if (a.startsWith("\\\\")) return false; // UNC paths, as in Claude Code
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
	const [sub, ...rest] = args;
	if (name === "git") {
		if (rest.some((a) => /^--output/i.test(a))) return false;
		if (GIT_READ.has(sub)) return true;
		if (sub === "remote") return rest.length === 1 && rest[0] === "-v";
		if (sub === "stash") return rest.length === 1 && rest[0] === "list";
		if (sub === "branch")
			return rest.every((a) =>
				/^(-a|-r|-v|-vv|--all|--remotes|--list)$/.test(a),
			);
		if (sub === "tag") return rest.every((a) => /^(-l|--list)$/.test(a));
		return false;
	}
	if (name === "npm") return sub === "ls";
	if (name === "pip" || name === "pip3")
		return ["list", "show", "freeze"].includes(sub);
	return false;
}

// One rule per part: the command, plus a subcommand-like first word for
// programs (`git push *`), as Claude Code suggests.
function suggestCommand(part: Part) {
	const name = part.resolved ?? part.name ?? "";
	const first = part.args[0];
	const sub =
		part.type !== "Cmdlet" &&
		part.type !== "Alias" &&
		first &&
		/^[a-z][\w-]*$/i.test(first)
			? ` ${first}`
			: "";
	return `PowerShell(${name}${sub} *)`;
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
	return `${ruleName(toolName)}(${spec})`;
}

const ruleName = (name: string) =>
	name === "powershell"
		? "PowerShell"
		: name.charAt(0).toUpperCase() + name.slice(1);
