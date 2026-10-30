import { basename, relative, resolve } from "node:path";
import { debugLog } from "../log/debug";
import { SECRET, unquote } from "../permissions/checks";
import { within } from "../permissions/engine";
import type { ParseResult } from "../permissions/powershell";
import { rgPath } from "../platform/win/bin";
import { NO_BACKUPS } from "./backups";
import { fileKey } from "./reads";
import type { ToolCtx } from "./registry";
import { readBytes, statOf } from "./textfile";

// Shell change detection (3.6, tools.md option b). Goes beyond Claude Code,
// which tracks only what its edit tools touched. Before a command that isn't
// read-only: copy the files it names and note every file's size and time.
// After it: a new file is recorded as created, so a rewind deletes it; a
// changed or deleted one with no copy is listed as lost.

// ponytail: only plainly named paths are copied, so `rm $x`, `git clean` and
// scripts can't come back (they are listed); a copy of the whole project first
// would cover them.
// ponytail: the scan respects .gitignore, so an ignored folder is neither
// copied nor listed; only a directly named ignored file is copied.
// ponytail: anything changed while a command runs counts as the command's, so
// a long background command can mark a file the user made for deletion. The
// rewind preview shows it first.
// ponytail: a rewind deletes a new file but leaves its empty folders.
// ponytail: every tracked file is re-read at each checkpoint, so a command that
// creates or names thousands of files slows later prompts.

export const LIMITS = { files: 1_000, bytes: 100 * 1024 ** 2, scan: 100_000 };

type Part = ParseResult["commands"][number];
export type Watched = {
	parse: (command: string) => Promise<ParseResult>;
	readOnly: (part: Part) => boolean;
	// A path as the command writes it, as a Windows path.
	path: (arg: string) => string;
};
type Seen = { path: string; size: number; time: number };

// Every file a command could be seen changing, or null past the limit.
async function scan(root: string, max: number) {
	const p = Bun.spawn(
		[
			await rgPath(),
			"--files",
			"--hidden",
			"--no-require-git",
			"--null",
			"--glob",
			"!.git",
			"--glob",
			"!node_modules",
		],
		{ cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	const names = (await new Response(p.stdout).text())
		.split("\0")
		.filter(Boolean);
	await p.exited;
	if (names.length > max) return null;
	const seen = new Map<string, Seen>();
	for (const name of names) {
		const path = resolve(root, name);
		const info = statOf(path);
		if (info && !info.isDirectory())
			seen.set(fileKey(path), { path, size: info.size, time: info.mtimeMs });
	}
	return seen;
}

function isReadOnly(parsed: ParseResult, spec: Watched) {
	return (
		parsed.errors.length === 0 &&
		!parsed.tooComplex &&
		!parsed.subexpressions &&
		parsed.invocations.length === 0 &&
		parsed.redirections.length === 0 &&
		parsed.commands.length > 0 &&
		parsed.commands.every(spec.readOnly)
	);
}

const CD = new Set(["cd", "chdir", "pushd", "set-location", "sl"]);

// The files a command names plainly: its files, what its folders hold and what
// its globs match. Followed through any `cd` it makes first.
function named(parsed: ParseResult, spec: Watched, ctx: ToolCtx, all: Seen[]) {
	const out = new Map<string, string>();
	const add = (path: string) => out.set(fileKey(path), path);
	const take = (arg: string, here: string) => {
		const a = unquote(arg);
		if (!a || a.startsWith("-") || /^~|\$/.test(a)) return;
		if (/[*?[]/.test(a)) {
			const glob = new Bun.Glob(a.replaceAll("\\", "/"));
			for (const f of all)
				if (glob.match(relative(here, f.path).replaceAll("\\", "/")))
					add(f.path);
			return;
		}
		const path = resolve(here, spec.path(a));
		if (!within(path, ctx.cwd)) return;
		const info = statOf(path);
		if (info?.isDirectory()) {
			for (const f of all) if (within(f.path, path)) add(f.path);
		} else if (info) add(path);
	};
	let here = ctx.shell.cwd;
	for (const part of parsed.commands) {
		if (!part.plain) continue;
		const name = (part.resolved ?? part.name ?? "").toLowerCase();
		const args = part.args.filter((a) => !a.startsWith("-"));
		if (CD.has(name) && args.length === 1) {
			here = resolve(here, spec.path(unquote(args[0])));
			continue;
		}
		// `Remove-Item a.txt, b.txt` comes as one argument.
		part.args.forEach((a, i) => {
			const list = part.kinds[i] === "ArrayLiteral" ? a.split(/\s*,\s*/) : [a];
			for (const one of list) take(one, here);
		});
	}
	for (const r of parsed.redirections) take(r, here);
	return [...out.values()];
}

// Runs before the command; what it returns runs once the command has ended.
// Nothing here ever fails the command.
export async function watchCommand(
	command: string,
	spec: Watched,
	ctx: ToolCtx,
	limits = LIMITS,
): Promise<(() => Promise<void>) | undefined> {
	const { backups } = ctx;
	const at = backups.list().at(-1)?.id;
	if (backups === NO_BACKUPS || !at) return undefined;
	// Never copied or tracked: a tracked file's contents go to disk at every
	// checkpoint.
	const hidden = (path: string) =>
		SECRET.some((s) => s.test(basename(path))) || !!ctx.denied(path);
	const failed = (err: unknown) =>
		debugLog({
			type: "shell_watch_failed",
			code: (err as { code?: string }).code,
		});
	let then: Map<string, Seen> | null = null;
	try {
		// Unparsed: nothing to copy, but it still gets scanned.
		const parsed = await spec.parse(command).catch(() => null);
		if (parsed && isReadOnly(parsed, spec)) return undefined;
		then = await scan(ctx.cwd, limits.scan);
		let files = 0;
		let bytes = 0;
		const all = [...(then?.values() ?? [])];
		for (const path of parsed ? named(parsed, spec, ctx, all) : []) {
			if (files >= limits.files) break;
			if (hidden(path) || backups.tracks(path)) continue;
			const size = statOf(path)?.size ?? 0;
			if (bytes + size > limits.bytes) continue;
			try {
				backups.before(path, await readBytes(path, path), at);
				files++;
				bytes += size;
			} catch (err) {
				failed(err); // locked: listed as lost if the command changes it
			}
		}
	} catch (err) {
		failed(err);
	}
	return async () => {
		try {
			const now = await scan(ctx.cwd, limits.scan);
			if (!then || !now) {
				backups.untracked(at);
				return;
			}
			for (const [key, f] of now) {
				const old = then.get(key);
				if (!old) {
					if (hidden(f.path)) backups.lost(f.path, at);
					else backups.before(f.path, null, at);
				} else if (old.size !== f.size || old.time !== f.time)
					backups.lost(f.path, at);
			}
			for (const [key, f] of then) if (!now.has(key)) backups.lost(f.path, at);
		} catch (err) {
			failed(err);
		}
	};
}
