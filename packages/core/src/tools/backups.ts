import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { diffLines } from "diff";
import { fileKey, sha256 } from "./reads";
import {
	decodeText,
	io,
	readBytes,
	retry,
	statOf,
	writeVerified,
} from "./textfile";

// Backups and checkpoints (memory-management.md), Claude Code's model:
// - a checkpoint when each turn starts: every file this session has changed,
//   as it is right then;
// - before edit or write first touches a file in a turn: its bytes, or null
//   if it doesn't exist yet. Written before the change, so a crash leaves at
//   worst an extra backup.
// Whole files, stored once per content hash and shared by the project's
// sessions; the newest 100 checkpoints are kept. /rewind (2.6) reads them.
// Blobs no checkpoint list names are deleted by the cleanup (2.9).

export type Checkpoint = {
	id: string;
	// History length when the turn started: rewinding the chat cuts it here.
	items: number;
	time: string;
	// Path → blob hash, or null for "didn't exist".
	files: Record<string, string | null>;
	// Not a prompt: the files as they were just before a code rewind, so it
	// can be undone. Using an undo point saves a redo point, and back.
	undo?: Undo;
	// Its prompt was rewound away (a conversation rewind): no longer listed,
	// but still used to find a later-touched file's earliest state.
	cut?: boolean;
	// Files a command changed with no copy to go back to (3.6).
	lost?: string[];
	// A command ran without a scan, so new files weren't noticed.
	untracked?: boolean;
};
export type Undo = {
	kind: "undo" | "redo";
	// The prompt the rewind went back to (as history holds it, placeholders).
	prompt: string;
	// The files it changes back, as the user sees their paths.
	paths: string[];
};
// What a rewind to a checkpoint would do to one file.
export type Change = {
	path: string;
	// The blob it goes back to; null: it didn't exist, so it's deleted.
	blob: string | null;
	action: "restore" | "delete" | "recreate";
	added: number;
	removed: number;
};
type Line =
	| ({ kind: "checkpoint" } & Checkpoint)
	| { kind: "file"; checkpoint: string; path: string; blob: string | null }
	| { kind: "cut"; from: string }
	| { kind: "lost"; checkpoint: string; path: string }
	| { kind: "untracked"; checkpoint: string };

const KEEP = 100; // Claude Code's
// Past this a file gets no line counts: diffing it would stall the preview.
const COUNT_MAX = 1024 ** 2;

export function openBackups(root: string, sessionId: string) {
	const blobs = join(root, "blobs");
	const file = join(root, sessionId, "checkpoints.jsonl");
	const checkpoints: Checkpoint[] = [];
	// Every file this session has backed up: its key → the path as recorded.
	const tracked = new Map<string, string>();
	const track = (path: string) => tracked.set(fileKey(path), path);

	// A resumed session's; a half-written last line is skipped.
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {}
	for (const raw of text.split("\n")) {
		let line: Line;
		try {
			line = JSON.parse(raw);
		} catch {
			continue;
		}
		if (line.kind === "checkpoint") {
			const { kind: _, ...c } = line;
			checkpoints.push(c);
			for (const p of Object.keys(c.files)) track(p);
		} else if (line.kind === "cut") {
			cutFrom(line.from);
		} else if (line.kind === "lost") {
			const c = checkpoints.find((x) => x.id === line.checkpoint);
			if (c) c.lost = [...(c.lost ?? []), line.path];
		} else if (line.kind === "untracked") {
			const c = checkpoints.find((x) => x.id === line.checkpoint);
			if (c) c.untracked = true;
		} else {
			const c = checkpoints.find((x) => x.id === line.checkpoint);
			if (c) c.files[line.path] = line.blob;
			track(line.path);
		}
	}
	let last = Math.max(0, ...checkpoints.map((c) => Number(c.id.slice(1))));

	function cutFrom(id: string) {
		const at = checkpoints.findIndex((c) => c.id === id);
		if (at >= 0) for (const c of checkpoints.slice(at)) c.cut = true;
	}
	// What restoring `id` puts back: each file as that checkpoint has it, or,
	// for one first touched later, its earliest recorded state (Claude Code's
	// rule; a null one is deleted).
	function target(id: string) {
		const at = checkpoints.findIndex((c) => c.id === id);
		if (at < 0) return undefined;
		const out = new Map<string, string | null>();
		for (const c of checkpoints.slice(at))
			for (const [path, blob] of Object.entries(c.files))
				if (!out.has(path)) out.set(path, blob);
		return out;
	}
	// The files a rewind to `id` would change, with line counts.
	async function changes(id: string): Promise<Change[] | undefined> {
		const t = target(id);
		if (!t) return undefined;
		const out: Change[] = [];
		for (const [path, blob] of t) {
			const info = statOf(path);
			let now: Uint8Array | null = null;
			try {
				if (info && !info.isDirectory()) now = await readBytes(path, path);
			} catch {
				// Can't read it (locked): listed, so restoring it fails on its own.
				const action = blob === null ? "delete" : "restore";
				out.push({ path, blob, action, added: 0, removed: 0 });
				continue;
			}
			if ((now && sha256(now)) === blob) continue;
			const then = blob === null ? null : readBlob(blob);
			let added = 0;
			let removed = 0;
			if ((now?.length ?? 0) <= COUNT_MAX && (then?.length ?? 0) <= COUNT_MAX)
				for (const part of diffLines(textOf(now), textOf(then))) {
					if (part.added) added += part.count ?? 0;
					if (part.removed) removed += part.count ?? 0;
				}
			const action =
				blob === null ? "delete" : now === null ? "recreate" : "restore";
			out.push({ path, blob, action, added, removed });
		}
		return out;
	}
	const readBlob = (hash: string) => {
		try {
			return readFileSync(join(blobs, hash));
		} catch {
			return null; // cleaned up: restoring this file fails
		}
	};

	const append = (line: Line) => {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(line)}\n`);
	};
	// Stored once: a temp file renamed into place, so a blob is never half
	// written; one that exists already is the same bytes.
	const store = (bytes: Uint8Array) => {
		const hash = sha256(bytes);
		const path = join(blobs, hash);
		if (!existsSync(path)) {
			mkdirSync(blobs, { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, bytes);
			try {
				renameSync(tmp, path);
			} catch {
				rmSync(tmp, { force: true }); // another session stored it first
			}
		}
		return hash;
	};
	const current = async (path: string) => {
		const info = statOf(path);
		if (!info || info.isDirectory()) return null;
		return store(await readBytes(path, path));
	};

	return {
		// When a turn starts, before its prompt joins history.
		async checkpoint(items: number, undo?: Undo) {
			const files: Checkpoint["files"] = {};
			for (const path of tracked.values()) files[path] = await current(path);
			const c = {
				id: `c${++last}`,
				items,
				time: new Date().toISOString(),
				files,
				...(undo && { undo }),
			};
			checkpoints.push(c);
			append({ kind: "checkpoint", ...c });
			if (checkpoints.length > KEEP) {
				checkpoints.splice(0, checkpoints.length - KEEP);
				const tmp = `${file}.tmp`;
				writeFileSync(
					tmp,
					checkpoints
						.map((x) => `${JSON.stringify({ kind: "checkpoint", ...x })}\n`)
						.join(""),
				);
				renameSync(tmp, file);
			}
			return c.id;
		},
		// Before edit, write or a command changes `path`: `bytes` as it is now,
		// or null if it doesn't exist. Once per file per turn; the checkpoint
		// already holds a file it tracked before this turn. `id`: a background
		// command's starting checkpoint, which may be trimmed by now.
		before(path: string, bytes: Uint8Array | null, id?: string) {
			const c = id ? checkpoints.find((x) => x.id === id) : checkpoints.at(-1);
			if (!c) {
				if (id) return;
				throw new Error("no checkpoint to back up into");
			}
			if (tracked.has(fileKey(path))) return;
			const blob = bytes === null ? null : store(bytes);
			c.files[path] = blob;
			track(path);
			append({ kind: "file", checkpoint: c.id, path, blob });
		},
		tracks: (path: string) => tracked.has(fileKey(path)),
		// A command changed `path` and there's no copy: /rewind says so (3.6).
		lost(path: string, id: string) {
			const c = checkpoints.find((x) => x.id === id);
			if (!c || tracked.has(fileKey(path)) || c.lost?.includes(path)) return;
			c.lost = [...(c.lost ?? []), path];
			append({ kind: "lost", checkpoint: id, path });
		},
		untracked(id: string) {
			const c = checkpoints.find((x) => x.id === id);
			if (!c || c.untracked) return;
			c.untracked = true;
			append({ kind: "untracked", checkpoint: id });
		},
		// What a rewind to `id` can't put back.
		unrestorable(id: string) {
			const at = checkpoints.findIndex((c) => c.id === id);
			const later = at < 0 ? [] : checkpoints.slice(at);
			return {
				unrestorable: [...new Set(later.flatMap((c) => c.lost ?? []))],
				untracked: later.some((c) => c.untracked),
			};
		},
		list: (): readonly Checkpoint[] => checkpoints,
		blobPath: (hash: string) => join(blobs, hash),
		preview: changes,
		// Puts every changed file back, byte for byte; a file that fails (locked,
		// backup gone) doesn't stop the rest.
		async restore(id: string) {
			const restored: string[] = [];
			const failed: { path: string; error: string }[] = [];
			for (const c of (await changes(id)) ?? []) {
				try {
					if (c.blob === null) {
						await retry(c.path, () => rmSync(io(c.path), { force: true }));
					} else {
						const bytes = readBlob(c.blob);
						if (!bytes) throw new Error("its backup is gone");
						await writeVerified(c.path, bytes, c.path);
					}
					restored.push(c.path);
				} catch (err) {
					failed.push({ path: c.path, error: (err as Error).message });
				}
			}
			return { restored, failed };
		},
		// A conversation rewind to `id`: it and later checkpoints leave the list.
		cut(id: string) {
			cutFrom(id);
			append({ kind: "cut", from: id });
		},
	};
}
export type Backups = ReturnType<typeof openBackups>;

// For line counts: the text, however it's encoded (lossy for unknown ones).
function textOf(bytes: Uint8Array | null) {
	if (!bytes) return "";
	const t = decodeText(bytes);
	return typeof t === "string" ? new TextDecoder().decode(bytes) : t.text;
}

// For contexts with nothing to undo (tests, a bare runTurn).
export const NO_BACKUPS: Backups = {
	checkpoint: async () => "",
	before: () => {},
	tracks: () => false,
	lost: () => {},
	untracked: () => {},
	unrestorable: () => ({ unrestorable: [], untracked: false }),
	list: () => [],
	blobPath: (hash) => hash,
	preview: async () => undefined,
	restore: async () => ({ restored: [], failed: [] }),
	cut: () => {},
};
