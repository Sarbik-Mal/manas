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
import { fileKey, sha256 } from "./reads";
import { readBytes, statOf } from "./textfile";

// Backups and checkpoints (memory-management.md), Claude Code's model:
// - a checkpoint when each turn starts: every file this session has changed,
//   as it is right then;
// - before edit or write first touches a file in a turn: its bytes, or null
//   if it doesn't exist yet. Written before the change, so a crash leaves at
//   worst an extra backup.
// Whole files, stored once per content hash and shared by the project's
// sessions; the newest 100 checkpoints are kept. /rewind (2.6) reads them.
// ponytail: blobs no checkpoint points to stay until the cleanup (2.9).

export type Checkpoint = {
	id: string;
	// History length when the turn started: rewinding the chat cuts it here.
	items: number;
	time: string;
	// Path → blob hash, or null for "didn't exist".
	files: Record<string, string | null>;
};
type Line =
	| ({ kind: "checkpoint" } & Checkpoint)
	| { kind: "file"; checkpoint: string; path: string; blob: string | null };

const KEEP = 100; // Claude Code's

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
		} else {
			const c = checkpoints.find((x) => x.id === line.checkpoint);
			if (c) c.files[line.path] = line.blob;
			track(line.path);
		}
	}
	let last = Math.max(0, ...checkpoints.map((c) => Number(c.id.slice(1))));

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
		async checkpoint(items: number) {
			const files: Checkpoint["files"] = {};
			for (const path of tracked.values()) files[path] = await current(path);
			const c = {
				id: `c${++last}`,
				items,
				time: new Date().toISOString(),
				files,
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
		// Before edit or write changes `path`: `bytes` as it is now, or null if
		// it doesn't exist. Once per file per turn; the checkpoint already holds
		// a file it tracked before this turn.
		before(path: string, bytes: Uint8Array | null) {
			const c = checkpoints.at(-1);
			if (!c) throw new Error("no checkpoint to back up into");
			if (tracked.has(fileKey(path))) return;
			const blob = bytes === null ? null : store(bytes);
			c.files[path] = blob;
			track(path);
			append({ kind: "file", checkpoint: c.id, path, blob });
		},
		list: (): readonly Checkpoint[] => checkpoints,
		blobPath: (hash: string) => join(blobs, hash),
	};
}
export type Backups = ReturnType<typeof openBackups>;

// For contexts with nothing to undo (tests, a bare runTurn).
export const NO_BACKUPS: Backups = {
	checkpoint: async () => "",
	before: () => {},
	list: () => [],
	blobPath: (hash) => hash,
};
