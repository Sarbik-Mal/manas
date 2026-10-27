import {
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The cleanup (memory-management.md), Claude Code's retention sweep: once a
// day at startup, everything older than `days` by last activity goes:
// sessions with their vaults and backups, blobs no checkpoint list names,
// debug logs, and project folders left empty. Prompt history stays. A
// session's temp folder (scratchpad, task output) goes with the session.

const DAY = 86_400_000;

export type Swept = {
	sessions: number;
	blobs: number;
	logs: number;
	projects: number;
	// Couldn't be deleted (locked by another window): tried again next time.
	failed: number;
};

const mtime = (p: string) =>
	stat(p).then(
		(s) => s.mtimeMs,
		() => undefined,
	);
const list = (p: string) => readdir(p).catch(() => [] as string[]);

// undefined: it ran less than a day ago.
export async function sweep({
	dir,
	days,
	keep,
	now = Date.now(),
	temp = join(tmpdir(), "manas"),
}: {
	// ~/.manas
	dir: string;
	days: number;
	// The session this process opened: never deleted, however old.
	keep?: string;
	now?: number;
	// %TEMP%\manas: <project>\<session> folders (3.4).
	temp?: string;
}): Promise<Swept | undefined> {
	const marker = join(dir, ".last-cleanup");
	const last = await mtime(marker);
	if (last !== undefined && now - last < DAY) return undefined;
	await writeFile(marker, new Date(now).toISOString());
	await utimes(marker, now / 1000, now / 1000);

	const cutoff = now - days * DAY;
	const out: Swept = { sessions: 0, blobs: 0, logs: 0, projects: 0, failed: 0 };
	const gone = async (p: string) => {
		try {
			await rm(p, { recursive: true, force: true });
			return true;
		} catch {
			out.failed++;
			return false;
		}
	};
	const older = async (p: string, than: number) => {
		const m = await mtime(p);
		return m !== undefined && m < than;
	};

	const projects = join(dir, "projects");
	const deleted = new Set<string>();
	for (const name of await list(projects)) {
		const project = join(projects, name);
		const sessions = join(project, "sessions");
		const backups = join(project, "backups");
		const live = new Set(keep ? [keep] : []);
		const entries = await list(sessions);
		for (const f of entries.filter((f) => f.endsWith(".jsonl"))) {
			const id = f.slice(0, -".jsonl".length);
			if (live.has(id) || !(await older(join(sessions, f), cutoff))) {
				live.add(id);
				continue;
			}
			// The session file first: if it stays (locked), so does the rest.
			if (!(await gone(join(sessions, f)))) {
				live.add(id);
				continue;
			}
			out.sessions++;
			deleted.add(join(name, id));
			await gone(join(sessions, id));
			await gone(join(backups, id));
		}
		// A vault or checkpoint list whose session file is gone.
		for (const f of entries.filter((f) => !f.endsWith(".jsonl")))
			if (!live.has(f) && (await older(join(sessions, f), cutoff)))
				await gone(join(sessions, f));
		for (const id of await list(backups))
			if (id !== "blobs" && !live.has(id))
				if (await older(join(backups, id), cutoff))
					await gone(join(backups, id));

		// Blobs: kept if a remaining checkpoint list names them (any 64-hex
		// string counts, so a doubt keeps it). A day's grace, so a backup
		// another window is taking right now is never lost.
		const used = new Set<string>();
		for (const id of await list(backups)) {
			if (id === "blobs") continue;
			const text = await readFile(
				join(backups, id, "checkpoints.jsonl"),
				"utf8",
			).catch(() => "");
			for (const hash of text.match(/[0-9a-f]{64}/g) ?? []) used.add(hash);
		}
		const blobs = join(backups, "blobs");
		for (const b of await list(blobs)) {
			if (used.has(b) || !(await older(join(blobs, b), now - DAY))) continue;
			if (await gone(join(blobs, b))) out.blobs++;
		}

		if (await empty(project)) {
			if (await gone(project)) out.projects++;
		}
	}

	// A temp folder goes with its session, or once old if its session never
	// had a file (opened and closed, or a crash).
	for (const name of await list(temp)) {
		for (const id of await list(join(temp, name))) {
			if (id === keep) continue;
			const has = await mtime(join(projects, name, "sessions", `${id}.jsonl`));
			const old = await older(join(temp, name, id), cutoff);
			if (deleted.has(join(name, id)) || (has === undefined && old))
				await gone(join(temp, name, id));
		}
		// Only when bare: another window's new session may hold empty folders.
		if ((await list(join(temp, name))).length === 0)
			await gone(join(temp, name));
	}

	const logs = join(dir, "logs");
	for (const f of await list(logs)) {
		if (!/^debug-.*\.jsonl$/.test(f)) continue;
		if (!(await older(join(logs, f), cutoff))) continue;
		if (await gone(join(logs, f))) out.logs++;
	}
	return out;
}

// Only empty folders inside (prompt-history.bin, or any file, keeps it).
async function empty(p: string): Promise<boolean> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(p, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const e of entries) {
		if (!e.isDirectory() || !(await empty(join(p, e.name)))) return false;
	}
	return true;
}
