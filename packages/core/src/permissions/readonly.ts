// Which bash commands are read-only (3.5), ported from Claude Code 2.1.312:
// a list of commands that are read-only whatever their arguments, and per
// command the flags that keep it read-only (its `safeFlags` tables, in
// bash-readonly.json). Any other flag makes the command ask.
import TABLE from "../assets/bash-readonly.json";

// ponytail: ps, ss, tput, lsof, test, man, help and netstat are left out of
// the table (they always ask): Claude's extra code checks for them weren't
// ported. Port them if those commands come up often.

type Kind = "none" | "string" | "number" | "char" | "{}" | "EOF";
type Spec = { flags: Record<string, Kind>; doubleDash?: boolean };
const SPECS = TABLE as Record<string, Spec>;

// Claude's `uqe`: read-only with any arguments.
const ANY_ARGS = new Set(
	"cal uptime cat head tail wc stat strings hexdump od nl id uname free df du locale groups nproc basename dirname realpath cut paste tr column tac rev fold expand unexpand fmt comm cmp numfmt readlink diff true false sleep which type expr seq tsort pr echo ls".split(
		" ",
	),
);
// Only with no arguments.
const BARE = new Set(["pwd", "whoami", "alias"]);
const VERSION = [
	["node", "-v"],
	["node", "--version"],
	["python", "--version"],
	["python3", "--version"],
	["ip", "addr"],
	["docker", "ps"],
	["docker", "images"],
];
// find's actions that write or run something (Claude's list).
export const FIND_ACTIONS = new Set(
	"-delete -rm -exec -execdir -ok -okdir -fprint -fprint0 -fls -fprintf -files0-from".split(
		" ",
	),
);

const fits = (v: string, kind: Kind) =>
	kind === "number"
		? /^\d+$/.test(v)
		: kind === "char"
			? v.length === 1
			: kind === "{}"
				? v === "{}"
				: kind === "EOF"
					? v === "EOF"
					: true;

// Claude's flag check (`r2t`): every flag known, values of the right kind,
// bundled short flags (-la) only when none takes a value.
function flagsOk(name: string, args: string[], spec: Spec) {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") {
			if (spec.doubleDash !== false) return true;
			continue;
		}
		if (!/^-[a-zA-Z0-9_-]/.test(a)) continue;
		const eq = a.indexOf("=");
		const flag = eq === -1 ? a : a.slice(0, eq);
		const kind = spec.flags[flag];
		if (!kind) {
			if (name.startsWith("git") && /^-\d+$/.test(flag)) continue;
			// grep -A5, rg -C3
			if (/^(e|f)?grep$|^rg$/.test(name) && /^-[A-Za-z]\d+$/.test(flag)) {
				const k = spec.flags[flag.slice(0, 2)];
				if (k === "number" || k === "string") continue;
				return false;
			}
			if (!flag.startsWith("--") && flag.length > 2) {
				for (const c of flag.slice(1))
					if (spec.flags[`-${c}`] !== "none") return false;
				continue;
			}
			return false;
		}
		if (kind === "none") {
			if (eq !== -1) return false;
			continue;
		}
		const v = eq !== -1 ? a.slice(eq + 1) : args[++i];
		if (v === undefined) return false;
		if (kind === "string" && v.startsWith("-") && flag !== "--sort")
			return false;
		if (!fits(v, kind)) return false;
	}
	return true;
}

// Claude's extra checks for the commands whose flags alone don't decide.
function extraOk(key: string, args: string[]) {
	const positional = args.filter((a) => !a.startsWith("-"));
	switch (key) {
		case "git config --get":
			return true;
		case "git remote":
			return args.every((a) => a === "-v" || a === "--verbose");
		// Listing only: a name would create a branch or tag.
		case "git branch":
		case "git tag":
			return (
				positional.length === 0 || args.some((a) => /^(-l|--list)$/.test(a))
			);
		case "date":
			return positional.every((a) => a.startsWith("+"));
		case "hostname":
			return positional.length === 0;
		// Only printing: -n with p commands, no w or e.
		case "sed":
			return (
				args.includes("-n") &&
				positional.length >= 1 &&
				/^[\d,$]*p$/.test(positional[0])
			);
		case "xargs":
			return false; // decided by what it runs (bash.ts strips bare xargs)
	}
	// gh: a URL, user@host or a path with two slashes could reach elsewhere.
	if (key.startsWith("gh "))
		return !args.some((a) => {
			const v = a.startsWith("-") ? a.slice(a.indexOf("=") + 1) : a;
			return (
				v.includes("://") ||
				v.includes("@") ||
				(v.match(/\//g) ?? []).length >= 2
			);
		});
	return true;
}

export function bashReadOnly(name: string, args: string[]) {
	const n = name.toLowerCase().replace(/\.exe$/, "");
	if (BARE.has(n)) return args.length === 0;
	if (VERSION.some(([c, a]) => n === c && args.length === 1 && args[0] === a))
		return true;
	if (args.length === 1 && args[0] === "--version") return true;
	if (ANY_ARGS.has(n)) return true;
	if (n === "cd") return args.length <= 1;
	if (n === "find") return !args.some((a) => FIND_ACTIONS.has(a));
	if (n === "printf")
		return !args[0]?.startsWith("-") && !args.some((a) => a.includes("$"));
	// The longest table key that starts the command: `git stash list`.
	const words = [n, ...args];
	for (let k = 3; k >= 1; k--) {
		const key = words.slice(0, k).join(" ");
		const spec = SPECS[key];
		if (!spec) continue;
		const rest = words.slice(k);
		return flagsOk(n, rest, spec) && extraOk(key, rest);
	}
	return false;
}
