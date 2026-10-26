import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Type from "typebox";
import { showDiff } from "./diff";
import { sha256 } from "./reads";
import { defineTool, type ToolCtx } from "./registry";

// edit (tools.md §1), shaped like Claude Code's Edit: exact text, once (or
// every copy with replace_all), only in a file the model has read. Every
// check runs before the approval prompt, so you're never asked about an edit
// that can't apply.
// ponytail: CRLF, BOM, UTF-16 and other encodings are refused until 2.4; no
// backup until 2.5. No \uXXXX swap as Claude Code tries (rare, and it was
// reported breaking exact matches).

const MAX_BYTES = 1024 ** 3; // Claude Code's limit

export const NOT_READ =
	"File has not been read yet. Read it first before writing to it.";
export const STALE =
	"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

type Input = {
	file_path: string;
	old_string: string;
	new_string: string;
	replace_all: boolean | null;
};
type Plan = {
	path: string;
	// Of the bytes the plan was made from: run refuses if they changed since.
	hash: string;
	after: string;
	diff: string;
	how: "exact" | "quotes" | "loose";
	stale: boolean;
};

// Curly quotes as straight ones, one character for one, so positions in the
// folded text are positions in the real one.
const fold = (s: string) => s.replace(/[‘’‚‛]/g, "'").replace(/[“-‟]/g, '"');

const find = (text: string, s: string) => {
	const at: number[] = [];
	for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + s.length))
		at.push(i);
	return at;
};

// Ported from v1: finds `old` ignoring trailing spaces and how many blank
// lines separate lines (models miscount them when copying from read). Whole
// lines only, and the match must be unique.
export function findLoose(
	text: string,
	old: string,
): { start: number; end: number } | "none" | "many" {
	const lines: { norm: string; start: number; end: number; next: number }[] =
		[];
	for (let at = 0; ; ) {
		const nl = text.indexOf("\n", at);
		const end = nl < 0 ? text.length : nl;
		lines.push({
			norm: text.slice(at, end).trimEnd(),
			start: at,
			end,
			next: nl < 0 ? end : end + 1,
		});
		if (nl < 0) break;
		at = nl + 1;
	}
	// Runs of blank lines count as one, on both sides.
	const doc = lines.filter(
		(l, i) => l.norm !== "" || i === 0 || lines[i - 1].norm !== "",
	);
	const needle = old
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l, i, all) => l !== "" || i === 0 || all[i - 1] !== "");
	while (needle[0] === "") needle.shift();
	while (needle.at(-1) === "") needle.pop();
	if (needle.length === 0) return "none";
	const hits: number[] = [];
	for (let i = 0; i + needle.length <= doc.length; i++) {
		if (needle.every((l, j) => doc[i + j].norm === l)) hits.push(i);
	}
	if (hits.length !== 1) return hits.length ? "many" : "none";
	const last = doc[hits[0] + needle.length - 1];
	// An old_string ending in a line break replaces that break too.
	return {
		start: doc[hits[0]].start,
		end: old.endsWith("\n") ? last.next : last.end,
	};
}

// What edit and write share: placeholders back to real values, or why not.
export function restoreAll(ctx: ToolCtx, ...texts: string[]) {
	const out = texts.map((t) => ctx.vault.restore(t));
	const unknown = out.flatMap((o) => o.unknown);
	if (unknown.length > 0)
		return `${unknown[0]} isn't a placeholder this session knows; read the file again to get a current one.`;
	return out.map((o) => o.text);
}

// The checks before a file is changed, in Claude Code's order: a missing
// file (write creates it), or its text and whether it changed since the read.
export function openForChange(
	ctx: ToolCtx,
	file_path: string,
	verb: "edited" | "written",
):
	| string
	| { path: string; missing: true }
	| {
			path: string;
			missing: false;
			text: string;
			hash: string;
			stale: boolean;
	  } {
	const path = resolve(ctx.cwd, file_path);
	if (ctx.denied(path))
		return `File is covered by a Read deny rule in your permission settings and cannot be ${verb}.`;
	const info = statSync(path, { throwIfNoEntry: false });
	if (!info) return { path, missing: true };
	if (info.isDirectory()) return `${file_path} is a folder, not a file.`;
	if (/\.ipynb$/i.test(path))
		return `${file_path} is a Jupyter notebook; changing notebooks isn't supported yet.`;
	if (info.size > MAX_BYTES)
		return `${file_path} is too large to change (over 1 GiB).`;

	const bytes = readFileSync(path);
	const unsupported = (what: string) =>
		`${file_path} ${what}; changing such files isn't supported yet. Tell the user, and don't change it through the shell.`;
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
		return unsupported("starts with a UTF-8 byte-order mark");
	if (
		(bytes[0] === 0xff && bytes[1] === 0xfe) ||
		(bytes[0] === 0xfe && bytes[1] === 0xff)
	)
		return unsupported("is UTF-16");
	if (bytes.includes(0)) return unsupported("is binary");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return unsupported("isn't valid UTF-8");
	}
	if (text.includes("\r"))
		return unsupported("has Windows (CRLF) line endings");

	const seen = ctx.reads.get(path);
	if (!seen) return NOT_READ;
	if (seen.partial)
		return "File has only been read in part (a PARTIAL view). Read the rest with offset and limit before changing it.";
	const hash = sha256(bytes);
	return { path, missing: false, text, hash, stale: seen.hash !== hash };
}

// Every check, in Claude Code's order. Returns why the edit can't apply, or
// what it will do.
async function plan(i: Input, ctx: ToolCtx): Promise<string | Plan> {
	// The model sees placeholders; the file gets the real values.
	const restored = restoreAll(ctx, i.old_string, i.new_string);
	if (typeof restored === "string") return restored;
	const [old, neu] = restored;
	if (old === neu)
		return "No changes to make: old_string and new_string are exactly the same.";
	if (old === "")
		return "old_string is empty. edit only replaces existing text; to create a file, use write.";
	const file = openForChange(ctx, i.file_path, "edited");
	if (typeof file === "string") return file;
	if (file.missing) return `File does not exist: ${i.file_path}`;
	const { path, text, hash, stale } = file;

	const all = i.replace_all === true;
	const exact = find(text, old);
	if (stale && !(exact.length === 1 || (exact.length > 1 && all))) return STALE;
	let spans: { start: number; end: number }[];
	let how: Plan["how"] = "exact";
	if (exact.length > 1 && !all) {
		return `Found ${exact.length} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${i.old_string}`;
	}
	if (exact.length > 0) {
		spans = exact.map((start) => ({ start, end: start + old.length }));
	} else {
		const folded = find(fold(text), fold(old));
		if (folded.length > 1)
			return `old_string matches ${folded.length} places once curly and straight quotes count as the same. Include more surrounding lines to make it unique.`;
		if (folded.length === 1) {
			spans = [{ start: folded[0], end: folded[0] + old.length }];
			how = "quotes";
		} else {
			const loose = findLoose(fold(text), fold(old));
			if (loose === "many")
				return "old_string matches several places once blank lines, trailing spaces and quote styles are ignored. Include more surrounding lines to make it unique.";
			if (loose === "none")
				return `String to replace not found in file.\nString: ${i.old_string}`;
			spans = [loose];
			how = "loose";
		}
	}
	let after = text;
	for (const s of [...spans].reverse())
		after = after.slice(0, s.start) + neu + after.slice(s.end);
	const diff = showDiff(text, after);
	return { path, hash, after, diff, how, stale };
}

// validate's plan, kept for preview and run (the same input object goes
// through every step of a call).
const plans = new WeakMap<object, Plan>();

export const edit = defineTool({
	name: "edit",
	description:
		"Replaces exact text in a file. Read the file first in this conversation, or the edit fails. " +
		"old_string must match the file exactly, including indentation, and appear once; leave out read's line-number prefix (number + tab). " +
		"Set replace_all to true to replace every copy. To create a file or replace it whole, use write.",
	schema: Type.Object(
		{
			file_path: Type.String({ description: "The file to change." }),
			old_string: Type.String({ description: "The exact text to replace." }),
			new_string: Type.String({
				description:
					"The text to put in its place (different from old_string).",
			}),
			replace_all: Type.Union([Type.Boolean(), Type.Null()], {
				description: "true to replace every copy of old_string; null for one.",
			}),
		},
		{ additionalProperties: false },
	),
	deferred: false,
	readOnly: false,
	permission: { path: (i) => i.file_path },
	title: (i) => `edit ${i.file_path}`,
	async validate(i, ctx) {
		const p = await plan(i, ctx);
		if (typeof p === "string") return p;
		plans.set(i, p);
	},
	preview: (i) => plans.get(i)?.diff,
	async run(i, ctx) {
		let p: string | Plan | undefined = plans.get(i);
		plans.delete(i);
		p ??= await plan(i, ctx);
		if (typeof p === "string") throw new Error(p);
		if (sha256(readFileSync(p.path)) !== p.hash) {
			throw new Error(
				`${i.file_path} changed while waiting for approval. Read it again.`,
			);
		}
		writeFileSync(p.path, p.after);
		const before = ctx.reads.get(p.path);
		ctx.reads.set(p.path, {
			hash: sha256(Buffer.from(p.after)),
			mtime: statSync(p.path).mtimeMs,
			offset: before?.offset ?? null,
			limit: before?.limit ?? null,
			partial: false,
			edited: true,
		});
		const done =
			i.replace_all === true
				? `The file ${i.file_path} has been updated. All occurrences were successfully replaced.`
				: `The file ${i.file_path} has been updated successfully.`;
		if (p.stale)
			return `${done} (The file contains other changes not in your context. Read it before edits that depend on surrounding content.)`;
		if (p.how !== "exact")
			return `${done} (Matched loosely: blank lines, trailing spaces or quote styles differed from old_string.)`;
		return `${done} (file state is current in your context; no need to read it back)`;
	},
});
