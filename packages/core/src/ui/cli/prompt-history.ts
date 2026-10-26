import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { protect, unprotect } from "../../platform/win/dpapi";
import { DEFAULT_ROOT, projectDir } from "../../session/store";

// ↑/↓ history across restarts, per folder (as Claude Code keeps it). Prompts
// can hold secrets, so the file is DPAPI-encrypted like the vault: only this
// Windows user on this PC can read it, and ↑ gives back the real text.

const MAX = 1000;

export const historyFile = (cwd: string, root = DEFAULT_ROOT) =>
	join(dirname(projectDir(cwd, root)), "prompt-history.bin");

// Newest first, as readline keeps it. Unreadable or missing: empty.
export function loadHistory(file: string): string[] {
	try {
		const json = new TextDecoder().decode(unprotect(readFileSync(file)));
		const list = JSON.parse(json);
		return Array.isArray(list) ? list.filter((l) => typeof l === "string") : [];
	} catch {
		return [];
	}
}

// `lines` (oldest first) go on top; repeats move up; the oldest fall off.
export function addToHistory(file: string, lines: string[]) {
	let list = loadHistory(file);
	for (const line of lines) {
		if (!line.trim()) continue;
		list = [line, ...list.filter((l) => l !== line)];
	}
	list = list.slice(0, MAX);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		`${file}.tmp`,
		protect(new TextEncoder().encode(JSON.stringify(list))),
	);
	renameSync(`${file}.tmp`, file);
	return list;
}
