import { statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import Type, { type TSchema } from "typebox";
import { rgPath } from "../platform/win/bin";
import { sha256 } from "./reads";
import { defineTool, type ToolCtx } from "./registry";
import { readBytes, statOf } from "./textfile";

// read, grep and glob (tools.md §1), shaped like Claude Code's: same inputs,
// limits and notices, so a model used to those tools needs no new habits.

const strict = { additionalProperties: false } as const;
const nullable = <T extends TSchema>(t: T, description: string) =>
	Type.Union([t, Type.Null()], { description });

// Relative paths resolve against the shell's folder (the project unless a
// `cd` moved it); results inside it show relative.
const full = (ctx: ToolCtx, p: string | null) =>
	resolve(ctx.shell.cwd, p ?? ".");
const shown = (ctx: ToolCtx, p: string) => {
	const rel = relative(ctx.shell.cwd, p);
	return rel.startsWith("..") || isAbsolute(rel) ? p : rel;
};

// --- read ---

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;
// ponytail: ~25K tokens estimated as characters / 4; use a real tokenizer if
// reads come out too big for the context.
const MAX_CHARS = 25_000 * 4;
const UNSUPPORTED =
	/\.(xlsx?|xlsm|docx?|pptx?|pdf|zip|7z|rar|gz|tar|exe|dll|parquet|png|jpe?g|gif|webp|bmp|ico|heic|mp3|mp4|wav|mov)$/i;

// ponytail: points at an earlier result, so compaction (when it comes) must
// clear the read record, or the model is sent to text it no longer has.
const UNCHANGED =
	"File unchanged since last read. The content from the earlier read result in this conversation is still current; refer to that instead of re-reading.";

// UTF-8 (a BOM is dropped) or UTF-16 by its BOM; anything else with a NUL
// byte early on is binary.
function decode(b: Uint8Array) {
	if (b[0] === 0xff && b[1] === 0xfe)
		return new TextDecoder("utf-16le").decode(b.subarray(2));
	if (b[0] === 0xfe && b[1] === 0xff)
		return new TextDecoder("utf-16be").decode(b.subarray(2));
	if (b.subarray(0, 8192).includes(0)) return undefined;
	return new TextDecoder().decode(b);
}

export const read = defineTool({
	name: "read",
	description:
		"Reads a text file. Returns lines with numbers (number, tab, line), starting at 1. " +
		`Reads up to ${MAX_LINES} lines by default; use offset and limit for other parts, especially of large files. ` +
		"A path may be absolute or relative to the current folder. Reads files only: list a folder with glob.",
	schema: Type.Object(
		{
			file_path: Type.String({ description: "The file to read." }),
			offset: nullable(
				Type.Integer({ minimum: 1 }),
				"First line to read (from 1), or null for the start.",
			),
			limit: nullable(
				Type.Integer({ minimum: 1 }),
				`How many lines to read, or null for up to ${MAX_LINES}.`,
			),
		},
		strict,
	),
	deferred: false,
	readOnly: true,
	// Caps itself (~25K tokens), so it never spills, as in Claude Code.
	maxResultChars: Number.POSITIVE_INFINITY,
	permission: { path: (i) => i.file_path },
	async run({ file_path, offset, limit }, ctx) {
		const path = full(ctx, file_path);
		const info = statOf(path);
		if (!info) throw new Error(`file not found: ${file_path}`);
		if (info.isDirectory())
			throw new Error(
				`${file_path} is a folder, not a file; list it with glob`,
			);
		const size = info.size;
		if (UNSUPPORTED.test(path))
			throw new Error(`reading ${extname(path)} files isn't supported yet`);
		const whole = offset === null && limit === null;
		if (whole && size > MAX_BYTES) {
			throw new Error(
				`${file_path} is ${Math.round(size / 1024)} KB, over the 256 KB limit for a whole-file read. Read it in parts with offset and limit, or search it with grep.`,
			);
		}
		const bytes = await readBytes(path, file_path);
		const text = decode(bytes);
		if (text === undefined)
			throw new Error(`${file_path} is a binary file, not text`);
		// The same part of an unchanged file: the earlier result still holds
		// (Claude Code's wording), so it isn't sent twice.
		const hash = sha256(bytes);
		const seen = ctx.reads.get(path);
		if (
			seen &&
			!seen.edited &&
			seen.hash === hash &&
			seen.offset === offset &&
			seen.limit === limit
		) {
			return UNCHANGED;
		}
		const record = (partial: boolean) =>
			ctx.reads.set(path, {
				hash,
				mtime: info.mtimeMs,
				offset,
				limit,
				partial,
			});
		if (text === "") {
			record(false);
			return `${file_path} exists but is empty.`;
		}
		const lines = text.split(/\r?\n/);
		if (lines.at(-1) === "") lines.pop();
		const start = offset ?? 1;
		if (start > lines.length) {
			return `${file_path} has ${lines.length} lines; offset ${start} is past the end.`;
		}
		const end = Math.min(lines.length, start - 1 + (limit ?? MAX_LINES));
		let out = "";
		let last = start - 1;
		for (let n = start; n <= end; n++) {
			const line = `${String(n).padStart(6)}\t${lines[n - 1]}\n`;
			if (out.length + line.length > MAX_CHARS) break;
			out += line;
			last = n;
		}
		if (last < end && !whole) {
			throw new Error(
				`lines ${start}-${end} of ${file_path} are over the ~25K token limit for one read; read fewer lines, or search with grep.`,
			);
		}
		if (last < start) {
			throw new Error(
				`line ${start} of ${file_path} alone is over the ~25K token limit; search it with grep.`,
			);
		}
		record(last < end);
		if (last < end) {
			out += `\nPARTIAL view: the file is over the ~25K token limit for one read. Showing lines ${start}-${last} of ${lines.length}; read the rest with offset and limit.`;
		} else if (start > 1 || last < lines.length) {
			out += `\n(Showing lines ${start}-${last} of ${lines.length}.)`;
		}
		return out.trimEnd();
	},
});

// --- glob ---

const GLOB_CAP = 100;
const GLOB_TIMEOUT_MS = 20_000;
const IN_GIT = /(^|[\\/])\.git([\\/]|$)/;

export const glob = defineTool({
	name: "glob",
	description:
		'Finds files by name pattern, such as "**/*.ts" or "src/**/*.json". ' +
		`Returns paths, newest first, at most ${GLOB_CAP}. Includes dotfiles and git-ignored files.`,
	schema: Type.Object(
		{
			pattern: Type.String({ description: "The glob pattern." }),
			path: nullable(
				Type.String(),
				"The folder to search in, or null for the current folder.",
			),
		},
		strict,
	),
	deferred: false,
	readOnly: true,
	permission: { path: (i) => i.path ?? "." },
	async run({ pattern, path }, ctx) {
		const root = full(ctx, path);
		const info = statSync(root, { throwIfNoEntry: false });
		if (!info) throw new Error(`folder not found: ${path}`);
		if (!info.isDirectory()) throw new Error(`${path} is not a folder`);
		const found: { file: string; mtime: number }[] = [];
		const deadline = Date.now() + GLOB_TIMEOUT_MS;
		let timedOut = false;
		for await (const f of new Bun.Glob(pattern).scan({
			cwd: root,
			dot: true,
			onlyFiles: true,
		})) {
			if (ctx.signal.aborted) throw new Error("interrupted");
			if (Date.now() > deadline) {
				timedOut = true;
				break;
			}
			if (IN_GIT.test(f)) continue;
			const file = resolve(root, f);
			if (ctx.denied(file)) continue;
			let mtime = 0;
			try {
				mtime = statSync(file).mtimeMs;
			} catch {}
			found.push({ file, mtime });
		}
		if (found.length === 0)
			return timedOut
				? "No files found before the 20 s limit."
				: "No files found";
		found.sort((a, b) => b.mtime - a.mtime);
		const lines = found.slice(0, GLOB_CAP).map((f) => shown(ctx, f.file));
		if (found.length > GLOB_CAP) {
			lines.push(
				`(Results are truncated: showing ${GLOB_CAP} of ${found.length}, newest first. Use a more specific pattern or path.)`,
			);
		}
		if (timedOut)
			lines.push(
				"(The search stopped at the 20 s limit; results may be missing.)",
			);
		return lines.join("\n");
	},
});

// --- grep ---

const HEAD_LIMIT = 250;
const int = (d: string) => nullable(Type.Integer({ minimum: 0 }), d);
const bool = (d: string) => nullable(Type.Boolean(), d);

export const grep = defineTool({
	name: "grep",
	description:
		"Searches file contents with ripgrep. Full regex syntax (ripgrep, not grep: escape literal braces, e.g. interface\\{\\}). " +
		"Respects .gitignore, includes hidden files. Filter with glob or type. " +
		'output_mode: "files_with_matches" (paths only, the default), "content" (matching lines), "count" (matches per file). ' +
		`Results are limited to ${HEAD_LIMIT} lines or entries unless head_limit is set (0 for no limit); page with offset. ` +
		"Use this instead of searching through the shell.",
	schema: Type.Object(
		{
			pattern: Type.String({ description: "The regular expression to find." }),
			path: nullable(
				Type.String(),
				"File or folder to search, or null for the current folder.",
			),
			glob: nullable(
				Type.String(),
				'Only files matching this, e.g. "*.{ts,tsx}".',
			),
			type: nullable(
				Type.String(),
				'Only this file type, e.g. "js", "py", "rust".',
			),
			output_mode: Type.Union(
				[
					Type.Literal("content"),
					Type.Literal("files_with_matches"),
					Type.Literal("count"),
					Type.Null(),
				],
				{ description: "What to return; null for files_with_matches." },
			),
			"-A": int("Lines to show after each match (content mode)."),
			"-B": int("Lines to show before each match (content mode)."),
			"-C": int("Lines to show before and after each match (content mode)."),
			context: int("Same as -C."),
			"-i": bool("true for a case-insensitive search."),
			"-n": bool("Line numbers in content mode; null means true."),
			"-o": bool(
				"true to print only the matching part of each line (content mode).",
			),
			head_limit: int(
				`Return at most this many lines or entries; null for ${HEAD_LIMIT}, 0 for no limit.`,
			),
			offset: int("Skip this many lines or entries first."),
			multiline: bool("true to let a match span lines (. matches newlines)."),
		},
		strict,
	),
	deferred: false,
	readOnly: true,
	permission: { path: (i) => i.path ?? "." },
	async run(i, ctx) {
		const mode = i.output_mode ?? "files_with_matches";
		const args = [
			"--no-config",
			"--hidden",
			"--sort",
			"path", // stable order, so offset pages line up
			"--null", // file names end in NUL, so each can be checked
			"--max-columns",
			"500",
		];
		if (mode === "files_with_matches") args.push("--files-with-matches");
		else if (mode === "count") args.push("--count");
		else {
			if (i["-n"] !== false) args.push("--line-number");
			const c = i["-C"] ?? i.context;
			if (c !== null) args.push("--context", String(c));
			if (i["-A"] !== null) args.push("--after-context", String(i["-A"]));
			if (i["-B"] !== null) args.push("--before-context", String(i["-B"]));
			if (i["-o"]) args.push("--only-matching");
		}
		if (i["-i"]) args.push("--ignore-case");
		if (i.multiline) args.push("--multiline", "--multiline-dotall");
		if (i.type) args.push("--type", i.type);
		if (i.glob) args.push("--glob", i.glob);
		// Last, so it wins over the model's glob (in rg the last match counts).
		args.push("--glob", "!.git");
		const target = i.path === null ? "." : shown(ctx, full(ctx, i.path));
		args.push("--regexp", i.pattern, "--", target);

		const p = Bun.spawn([await rgPath(), ...args], {
			cwd: ctx.shell.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			signal: ctx.signal,
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (ctx.signal.aborted) throw new Error("interrupted");
		if (code === 2 && !out) throw new Error(`${err.trim()}`);

		// `.\src\a.ts` → `src\a.ts`; files the user denied reading are dropped.
		const clean = (f: string) => f.replace(/^\.[\\/]/, "");
		const allowed = (f: string) => !ctx.denied(resolve(ctx.shell.cwd, f));
		let entries: string[];
		if (mode === "files_with_matches") {
			entries = out
				.split("\0")
				.map((f) => f.trim())
				.filter((f) => f && allowed(f))
				.map(clean);
		} else {
			entries = [];
			for (const line of out.split(/\r?\n/)) {
				const at = line.indexOf("\0");
				if (at < 0) {
					if (line) entries.push(line); // "--" between context groups, or a single file's lines
				} else if (allowed(line.slice(0, at))) {
					entries.push(`${clean(line.slice(0, at))}:${line.slice(at + 1)}`);
				}
			}
		}
		if (entries.length === 0) return "No matches found";
		const skip = i.offset ?? 0;
		const limit =
			i.head_limit === 0 ? entries.length : (i.head_limit ?? HEAD_LIMIT);
		const page = entries.slice(skip, skip + limit);
		if (page.length === 0) return `No entries at offset ${skip}`;
		const rest = entries.length - skip - page.length;
		if (rest > 0) {
			page.push(
				`(Showing ${skip + 1}-${skip + page.length} of ${entries.length}; use offset ${skip + page.length} for more.)`,
			);
		}
		return page.join("\n");
	},
});
