// Parses bash commands with tree-sitter's bash grammar (3.5), as Claude Code
// does, into the same shape the PowerShell parser gives. Only plain words,
// quotes, separators and simple redirects are understood; anything else is
// "too complex" and asks.
import bashWasm from "tree-sitter-bash/tree-sitter-bash.wasm" with {
	type: "file",
};
import { Language, type Node, Parser } from "web-tree-sitter";
import treeSitterWasm from "web-tree-sitter/tree-sitter.wasm" with {
	type: "file",
};
import type { ParseResult } from "./powershell";

// Git Bash paths and Windows paths, as Claude Code converts them:
// `C:\x` ↔ `/c/x` (also `/cygdrive/c/x`); a UNC path keeps its slashes.
export function toPosix(p: string) {
	if (p.startsWith("\\\\")) return p.replaceAll("\\", "/");
	const m = /^([A-Za-z]):[/\\]/.exec(p);
	if (m) return `/${m[1].toLowerCase()}${p.slice(2).replaceAll("\\", "/")}`;
	return p.replaceAll("\\", "/");
}
export function toWindows(p: string) {
	if (p.startsWith("//")) return p.replaceAll("/", "\\");
	const m = /^(?:\/cygdrive)?\/([A-Za-z])(\/|$)/.exec(p);
	if (m)
		return `${m[1].toUpperCase()}:${p.slice(m[0].length - m[2].length) || "\\"}`.replaceAll(
			"/",
			"\\",
		);
	return p.replaceAll("/", "\\");
}

let loading: Promise<Parser> | undefined;
const parser = () =>
	(loading ??= (async () => {
		await Parser.init({ locateFile: () => treeSitterWasm });
		const p = new Parser();
		p.setLanguage(await Language.load(bashWasm));
		return p;
	})());

// Nodes a command may hold. Expansions, substitutions, subshells, functions,
// loops, heredocs and arithmetic are left out: their effect can't be known
// before the command runs.
const PLAIN = new Set([
	"program",
	"list",
	"pipeline",
	"command",
	"command_name",
	"word",
	"string",
	"string_content",
	"raw_string",
	"number",
	"concatenation",
	"redirected_statement",
	"file_redirect",
	"file_descriptor",
	"variable_assignment",
	"variable_name",
	"comment",
]);

// Claude Code's wrappers, stripped before rules are matched: `timeout 30 npm
// test` is `npm test`. The value is how many of the following words are its
// own (flags aside): timeout's duration.
const WRAPPERS: Record<string, number> = {
	timeout: 1,
	time: 0,
	nice: 0,
	nohup: 0,
	stdbuf: 0,
	command: 0,
	builtin: 0,
	noglob: 0,
};
// Flags of the wrappers that take a value.
const WRAPPER_VALUES = new Set(["-s", "--signal", "-k", "--kill-after", "-n"]);

// Claude Code's environment variables that may lead a command and still let
// a rule match it (`NODE_ENV=test npm test`).
const SAFE_VARS = new Set(
	"GOEXPERIMENT GOOS GOARCH CGO_ENABLED GO111MODULE RUST_BACKTRACE RUST_LOG NODE_ENV PYTHONUNBUFFERED PYTHONDONTWRITEBYTECODE PYTEST_DISABLE_PLUGIN_AUTOLOAD PYTEST_DEBUG ANTHROPIC_API_KEY LANG LANGUAGE LC_ALL LC_CTYPE LC_TIME CHARSET TERM COLORTERM NO_COLOR FORCE_COLOR TZ LS_COLORS LSCOLORS GREP_COLOR GREP_COLORS GCC_COLORS TIME_STYLE BLOCK_SIZE BLOCKSIZE COLUMNS LINES CLICOLOR CLICOLOR_FORCE CI DEBIAN_FRONTEND GIT_TERMINAL_PROMPT".split(
		" ",
	),
);

// A word's value as bash sees it: quotes off, backslash escapes undone.
function value(n: Node): string {
	switch (n.type) {
		case "raw_string":
			return n.text.slice(1, -1);
		case "string":
			return n.text.slice(1, -1).replace(/\\(["\\$`\n])/g, "$1");
		case "concatenation":
			return n.namedChildren.map((c) => (c ? value(c) : "")).join("");
		default:
			return n.text.replace(/\\(.)/gs, "$1");
	}
}

export async function parseBash(command: string): Promise<ParseResult> {
	const tree = (await parser()).parse(command);
	const out: ParseResult = {
		errors: [],
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
		assigns: [],
	};
	if (!tree) return { ...out, errors: ["could not parse"] };
	const walk = (n: Node) => {
		if (out.tooComplex) return;
		if (n.isError || n.isMissing || n.type === "ERROR") {
			out.errors.push(`syntax error near "${n.text.slice(0, 40)}"`);
			return;
		}
		if (n.isNamed && !PLAIN.has(n.type)) {
			out.tooComplex = `Contains ${n.type.replace(/_/g, " ")}`;
			return;
		}
		if (n.type === "file_redirect") {
			const target = n.childForFieldName("destination");
			if (target) out.redirections.push(value(target));
		}
		if (n.type === "variable_assignment" && n.parent?.type !== "command")
			out.assigns?.push(n.childForFieldName("name")?.text ?? "");
		if (n.type === "command") return command_(n);
		for (const c of n.children) if (c) walk(c);
	};
	const command_ = (n: Node) => {
		for (const c of n.children) if (c) walk(c);
		if (out.tooComplex || out.errors.length > 0) return;
		const words: string[] = [];
		let plain = true;
		for (const c of n.namedChildren) {
			if (!c || c.type === "file_redirect") continue;
			if (c.type === "variable_assignment") {
				const name = c.childForFieldName("name")?.text ?? "";
				out.assigns?.push(name);
				// Another variable leading the command: no rule covers it.
				if (!SAFE_VARS.has(name)) plain = false;
				continue;
			}
			words.push(value(c.type === "command_name" ? (c.firstChild ?? c) : c));
		}
		// Wrappers first: their own flags and values, then the real command.
		while (words.length > 0 && words[0] in WRAPPERS) {
			let skip = WRAPPERS[words.shift() as string];
			while (words[0]?.startsWith("-")) {
				const flag = words.shift() as string;
				if (WRAPPER_VALUES.has(flag)) words.shift();
			}
			while (skip-- > 0) words.shift();
		}
		// Bare xargs (no flags) runs what follows on its input.
		if (words[0] === "xargs" && words[1] && !words[1].startsWith("-"))
			words.shift();
		const [name = null, ...args] = words;
		out.commands.push({
			name,
			resolved: name,
			module: null,
			type: "Application",
			args,
			kinds: [],
			plain,
		});
	};
	walk(tree.rootNode);
	tree.delete();
	return out;
}
