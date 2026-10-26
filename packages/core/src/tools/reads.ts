import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { io } from "./textfile";

// What the model has read this session (tools.md §1), so edit and write can
// insist on a read first and spot a file that changed since. Saved with the
// session, so a resume keeps it (Claude Code rebuilds it from the transcript).
// ponytail: only the read tool counts; Claude Code also counts cat/head on one
// file through Bash, so PowerShell Get-Content could join if models use it.

export type Read = {
	// The key: the real path, lowercased (see fileKey).
	path: string;
	// sha256 of the bytes on disk when read.
	hash: string;
	mtime: number;
	offset: number | null;
	limit: number | null;
	// Cut off at the token limit (a PARTIAL view): doesn't count for edits.
	partial: boolean;
	// Set by an edit: the model hasn't seen the file whole as it is now, so
	// the next read sends the full text rather than the "unchanged" stub.
	edited?: boolean;
};

// One key per file: Windows ignores case, and the real path folds junctions,
// symlinks and 8.3 short names (PROGRA~1). A file that doesn't exist yet
// (a write) has no real path, so it's resolved as typed.
export function fileKey(path: string) {
	let p = resolve(path);
	try {
		// A long path goes in with `\\?\` (textfile.ts) and may come back with it.
		p = realpathSync.native(io(p)).replace(/^\\\\\?\\/, "");
	} catch {}
	return p.toLowerCase();
}

export const sha256 = (bytes: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export function readRecord(saved: Read[] = [], save?: (r: Read) => void) {
	const reads = new Map(saved.map((r) => [r.path, r]));
	return {
		get: (path: string) => reads.get(fileKey(path)),
		set(path: string, r: Omit<Read, "path">) {
			const read = { path: fileKey(path), ...r };
			reads.set(read.path, read);
			save?.(read);
		},
		// A conversation rewind: the model no longer has those reads in view.
		clear: () => reads.clear(),
	};
}
export type ReadRecord = ReturnType<typeof readRecord>;
