import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	ResponseFunctionToolCall,
	ResponseInputItem,
} from "openai/resources/responses/responses";
import type { Read } from "../tools/reads";

// Sessions on disk (memory-management.md): one append-only .jsonl per session,
// in a readable folder per project, as Claude Code does.
// ponytail: lines are plaintext until the vault (1.8) scrubs each one first.

export const DEFAULT_ROOT = join(homedir(), ".manas", "projects");

export type Start = {
	model: string;
	effort: string | null;
	// Missing in sessions from before 1.10: nothing was sent.
	verbosity?: string;
	cwd: string;
	version: string;
	created: string;
};
export type Usage = {
	input: number;
	cached: number;
	output: number;
	reasoning: number;
};
type Line =
	| ({ kind: "start" } & Start)
	| { kind: "item"; item: ResponseInputItem }
	| { kind: "set"; model?: string; effort?: string | null }
	| { kind: "usage"; turn_id: string; usage: Usage }
	// What the model read (2.1): path, hash and time, never content.
	| { kind: "read"; read: Read }
	// A conversation rewind (2.6): history is cut back to `items` items, and
	// the reads before this line no longer count.
	| { kind: "rewind"; items: number };

export const CUT_OFF =
	"cut off: Manas ended before this finished. Check whether it took effect before running it again.";

// `E:\Experiments\manas` → `e--experiments-manas`. Windows paths ignore case.
export const projectDir = (cwd: string, root = DEFAULT_ROOT) =>
	join(root, cwd.toLowerCase().replace(/[^a-z0-9]/g, "-"), "sessions");

export const sessionFile = (dir: string, id: string) =>
	join(dir, `${id}.jsonl`);

// The file appears with the first item, so opening Manas and quitting leaves
// nothing behind. `start` is read then, so earlier model changes are in it.
// `onCreate`: the file was just made (the vault is saved from then on).
export function openStore(
	file: string,
	start: () => Start,
	onCreate: () => void = () => {},
) {
	let exists = false;
	try {
		statSync(file);
		exists = true;
	} catch {}
	const write = (line: Line) =>
		appendFileSync(file, `${JSON.stringify(line)}\n`);
	return {
		file,
		get exists() {
			return exists;
		},
		item(item: ResponseInputItem) {
			if (!exists) {
				mkdirSync(dirname(file), { recursive: true });
				write({ kind: "start", ...start() });
				exists = true;
				onCreate();
			}
			write({ kind: "item", item });
		},
		// Only once the file exists; before that the start line carries them.
		set(change: { model?: string; effort?: string | null }) {
			if (exists) write({ kind: "set", ...change });
		},
		usage(turn_id: string, usage: Usage) {
			if (exists) write({ kind: "usage", turn_id, usage });
		},
		read(read: Read) {
			if (exists) write({ kind: "read", read });
		},
		rewind(items: number) {
			if (exists) write({ kind: "rewind", items });
		},
	};
}
export type Store = ReturnType<typeof openStore>;

export type Loaded = {
	start: Start;
	items: ResponseInputItem[];
	reads: Read[];
	model: string;
	effort: string | null;
	skipped: number;
};

// Reads a session back. Lines that don't parse are skipped (a crash can leave
// the last one half-written). A tool call saved without its result gets one,
// appended to the file too, so the next request isn't rejected.
export function loadSession(file: string): Loaded {
	const lines: Line[] = [];
	let skipped = 0;
	for (const text of readFileSync(file, "utf8").split("\n")) {
		if (!text.trim()) continue;
		try {
			lines.push(JSON.parse(text));
		} catch {
			skipped++;
		}
	}
	const start = lines.find((l) => l.kind === "start");
	if (!start) throw new Error(`${basename(file)} has no start line`);
	let { model, effort } = start;
	const items: ResponseInputItem[] = [];
	const reads: Read[] = [];
	for (const l of lines) {
		if (l.kind === "item") items.push(l.item);
		if (l.kind === "read") reads.push(l.read);
		if (l.kind === "rewind") {
			items.length = Math.min(items.length, l.items);
			reads.length = 0;
		}
		if (l.kind === "set") {
			model = l.model ?? model;
			if (l.effort !== undefined) effort = l.effort;
		}
	}
	const answered = new Set(
		items.flatMap((i) =>
			i.type === "function_call_output" ? [i.call_id] : [],
		),
	);
	for (const i of items) {
		if (i.type !== "function_call") continue;
		const call = i as ResponseFunctionToolCall;
		if (answered.has(call.call_id)) continue;
		const fix: ResponseInputItem = {
			type: "function_call_output",
			call_id: call.call_id,
			output: CUT_OFF,
		};
		items.push(fix);
		appendFileSync(file, `${JSON.stringify({ kind: "item", item: fix })}\n`);
	}
	return { start, items, reads, model, effort, skipped };
}

export type Listed = {
	session_id: string;
	title: string;
	updated: string;
	messages: number;
};

// Newest first. The title is the first prompt, on one line.
export function listSessions(dir: string): Listed[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const out: (Listed & { ms: number })[] = [];
	for (const name of names) {
		const file = join(dir, name);
		let items: ResponseInputItem[];
		try {
			items = loadItemsOnly(file);
		} catch {
			continue;
		}
		const said = items.filter(
			(i) => "role" in i && (i.role === "user" || i.role === "assistant"),
		);
		const first = said.find((i) => "role" in i && i.role === "user");
		const ms = statSync(file).mtimeMs;
		out.push({
			session_id: name.slice(0, -".jsonl".length),
			title: first ? oneLine(textOf(first)) : "(no prompt)",
			updated: new Date(ms).toISOString(),
			messages: said.length,
			ms,
		});
	}
	return out.sort((a, b) => b.ms - a.ms).map(({ ms: _, ...rest }) => rest);
}

// Looks in this folder's project first, then in every project.
export function findSession(id: string, cwd: string, root = DEFAULT_ROOT) {
	if (!/^[\w-]+$/.test(id)) return undefined;
	const here = sessionFile(projectDir(cwd, root), id);
	const dirs = [dirname(here)];
	try {
		for (const p of readdirSync(root)) dirs.push(join(root, p, "sessions"));
	} catch {}
	for (const d of dirs) {
		const file = sessionFile(d, id);
		try {
			statSync(file);
			return file;
		} catch {}
	}
	return undefined;
}

// The text of a message item, whether `content` is a string or parts.
export function textOf(item: ResponseInputItem): string {
	const content = (item as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p: { text?: string }) => p.text ?? "").join("");
}

const oneLine = (s: string) => {
	const line = s.trim().split("\n")[0];
	return line.length > 60 ? `${line.slice(0, 60)}...` : line;
};

function loadItemsOnly(file: string): ResponseInputItem[] {
	const items: ResponseInputItem[] = [];
	for (const text of readFileSync(file, "utf8").split("\n")) {
		try {
			const l = JSON.parse(text) as Line;
			if (l.kind === "item") items.push(l.item);
		} catch {}
	}
	return items;
}
