import { existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { debugLog } from "../log/debug";
import { within } from "../permissions/engine";
import { fileKey } from "./reads";

// The first checker (3.8): after a TypeScript edit the core runs the project's
// own tsc and puts the errors that edit caused in the result. Claude Code gets
// these from a language server or the editor and runs no tsc; the block and its
// caps are Claude's. A missing tsc or tsconfig.json is skipped, not installed.

// ponytail: tsc only; eslint comes with 5.4, a language server with LSP.
// ponytail: files a shell command changes aren't checked (as in Claude Code).
// ponytail: a tsconfig.json with only `references` reports nothing: -p doesn't
// build references. Check each referenced project if monorepos need it.
// ponytail: the first edit waits for two runs, and a big project is slow next
// to Claude's language server; add a server if 60 s proves too little.

const TS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const LIMIT_MS = 60_000;
const TIMEOUTS_TO_STOP = 3;
const PER_FILE = 10;
const TOTAL = 30;
const TEXT_MAX = 4_000;

export type TscError = {
	file: string;
	line: number;
	column: number;
	code: string;
	message: string;
};
// Tsc's own errors, with paths absolute. Indented lines belong to the error
// above them.
export function parseTsc(out: string, dir: string) {
	const errors: TscError[] = [];
	for (const line of out.split(/\r?\n/)) {
		const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
		const last = errors.at(-1);
		if (m)
			errors.push({
				file: resolve(dir, m[1]),
				line: Number(m[2]),
				column: Number(m[3]),
				code: m[4],
				message: m[5],
			});
		else if (last && /^\s+\S/.test(line)) last.message += `\n${line.trimEnd()}`;
	}
	return errors;
}

// Line numbers left out: a line added above an old error doesn't make it new.
const keyOf = (e: TscError) => `${fileKey(e.file)}|${e.code}|${e.message}`;
const counts = (errors: TscError[]) => {
	const out = new Map<string, number>();
	for (const e of errors) out.set(keyOf(e), (out.get(keyOf(e)) ?? 0) + 1);
	return out;
};
// What's over the baseline's count: a second identical error is new.
function newErrors(errors: TscError[], baseline: Map<string, number>) {
	const left = new Map(baseline);
	return errors.filter((e) => {
		const n = left.get(keyOf(e)) ?? 0;
		if (n === 0) return true;
		left.set(keyOf(e), n - 1);
		return false;
	});
}

// Claude Code's <new-diagnostics> block and caps, with paths from the project:
// errors can be in other files than the one edited.
export function render(errors: TscError[], cwd: string) {
	const files = new Map<string, TscError[]>();
	for (const e of errors) files.set(e.file, [...(files.get(e.file) ?? []), e]);
	let room = TOTAL;
	const blocks: string[] = [];
	for (const [file, list] of files) {
		const kept = list.slice(0, Math.min(PER_FILE, room));
		room -= kept.length;
		if (kept.length === 0) continue;
		const lines = kept.map(
			(e) => `  ✘ [Line ${e.line}:${e.column}] ${e.message} [${e.code}] (tsc)`,
		);
		blocks.push(`${relative(cwd, file)}:\n${lines.join("\n")}`);
	}
	let text = blocks.join("\n\n");
	if (text.length > TEXT_MAX)
		text = `${text.slice(0, TEXT_MAX - 12)}…[truncated]`;
	return `<new-diagnostics>The following new diagnostic issues were detected:\n\n${text}</new-diagnostics>`;
}

type Ran =
	| { status: "ok"; errors: TscError[] }
	| { status: "timeout" | "cancelled" | "failed" };
export type Project = { tsconfig: string; tsc: string };
export type RunTsc = (
	project: Project,
	cache: string,
	signal: AbortSignal,
) => Promise<Ran>;

// The nearest tsconfig.json from the file up to the project, and the nearest
// tsc from there up: a monorepo keeps it above the package.
export function findProject(path: string, cwd: string): Project | undefined {
	if (!within(path, cwd)) return undefined;
	let tsconfig: string | undefined;
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		if (existsSync(join(dir, "tsconfig.json"))) {
			tsconfig = join(dir, "tsconfig.json");
			break;
		}
		if (!within(dirname(dir), cwd) || dirname(dir) === dir) return undefined;
	}
	for (let dir = dirname(tsconfig); ; dir = dirname(dir)) {
		for (const name of ["tsc.exe", "tsc.cmd"]) {
			const tsc = join(dir, "node_modules", ".bin", name);
			if (existsSync(tsc)) return { tsconfig, tsc };
		}
		if (dirname(dir) === dir) return undefined;
	}
}

const runTsc: RunTsc = async ({ tsconfig, tsc }, cache, signal) => {
	const dir = dirname(tsconfig);
	const args = [
		"--noEmit",
		"--pretty",
		"false",
		"--incremental",
		"--tsBuildInfoFile",
		cache,
		"-p",
		tsconfig,
	];
	const p = Bun.spawn(
		tsc.endsWith(".cmd") ? ["cmd", "/c", tsc, ...args] : [tsc, ...args],
		{ cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	const finished = Promise.all([new Response(p.stdout).text(), p.exited]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stopped = new Promise<"timeout" | "cancelled">((res) => {
		timer = setTimeout(() => res("timeout"), LIMIT_MS);
		if (signal.aborted) res("cancelled");
		signal.addEventListener("abort", () => res("cancelled"), { once: true });
	});
	const first = await Promise.race([finished, stopped]);
	clearTimeout(timer);
	if (typeof first === "string") {
		Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(p.pid)]);
		return { status: first };
	}
	const [out, code] = first;
	const errors = parseTsc(out, dir);
	// tsc itself broke: the list says nothing, so the baseline stays.
	if (code !== 0 && errors.length === 0) return { status: "failed" };
	return { status: "ok", errors };
};

type State = Project & {
	baseline?: Map<string, number>;
	// The run that sets the baseline, shared by parallel edits.
	base?: Promise<void>;
	// That run timed out, and the edit it was for hasn't said so yet.
	missed?: boolean;
	running?: Promise<Ran>;
	queued?: Promise<Ran>;
};

export function openChecker({
	cwd,
	cache,
	enabled = () => true,
	denied = () => undefined,
	run = runTsc,
	find = findProject,
}: {
	cwd: string;
	// A folder for tsc's --incremental files.
	cache: string;
	enabled?: () => boolean;
	denied?: (path: string) => string | undefined;
	run?: RunTsc;
	find?: typeof findProject;
}) {
	const projects = new Map<string, State>();
	let timeouts = 0;
	let off = false;
	let offSaid = false;

	const stateOf = (path: string) => {
		if (!enabled()) {
			// Errors made while it was off aren't this edit's.
			projects.clear();
			return undefined;
		}
		if (off && offSaid) return undefined;
		if (!TS.has(extname(path).toLowerCase())) return undefined;
		const found = find(path, cwd);
		if (!found) return undefined;
		let s = projects.get(found.tsconfig);
		if (!s) {
			s = { ...found };
			projects.set(found.tsconfig, s);
		}
		return s;
	};
	const exec = async (s: State, signal: AbortSignal): Promise<Ran> => {
		const started = performance.now();
		let r: Ran;
		try {
			mkdirSync(cache, { recursive: true });
			r = await run(
				s,
				join(cache, `tsc-${Bun.hash(s.tsconfig).toString(36)}.tsbuildinfo`),
				signal,
			);
		} catch {
			r = { status: "failed" };
		}
		debugLog({
			kind: "checker",
			status: r.status,
			errors: r.status === "ok" ? r.errors.length : null,
			ms: Math.round(performance.now() - started),
		});
		if (r.status === "timeout") {
			timeouts++;
			if (timeouts >= TIMEOUTS_TO_STOP) off = true;
		} else if (r.status === "ok") timeouts = 0;
		return r;
	};
	// One run at a time. A call during a run waits for the next one, shared by
	// all who wait: the running one may predate its edit.
	const nextRun = (s: State, signal: AbortSignal) => {
		const start = () => {
			s.queued = undefined;
			const r = exec(s, signal);
			s.running = r;
			void r.finally(() => {
				if (s.running === r) s.running = undefined;
			});
			return r;
		};
		if (!s.running) return start();
		s.queued ??= s.running.then(start, start);
		return s.queued;
	};
	const timedOut = () => {
		const text = `Type check timed out after ${LIMIT_MS / 1000} s; this edit wasn't checked.`;
		if (!off) return text;
		offSaid = true;
		return `${text} Checking is off for this session: it timed out ${TIMEOUTS_TO_STOP} times in a row.`;
	};

	return {
		// Before an edit: the session's first for this project runs tsc, so the
		// errors already there aren't blamed on it.
		async before(path: string, signal: AbortSignal) {
			const s = stateOf(path);
			if (!s || s.baseline || off) return;
			s.base ??= exec(s, signal).then((r) => {
				s.base = undefined;
				if (r.status === "ok") s.baseline = counts(r.errors);
				else if (r.status === "timeout") s.missed = true;
			});
			await s.base;
		},
		// After it: the block, a timeout's note, or nothing.
		async after(path: string, signal: AbortSignal) {
			const s = stateOf(path);
			if (!s) return undefined;
			if (!s.baseline) {
				const missed = s.missed;
				s.missed = false;
				return missed ? timedOut() : undefined;
			}
			if (off) return timedOut();
			const r = await nextRun(s, signal);
			if (r.status === "timeout") return timedOut();
			if (r.status !== "ok") return undefined;
			const fresh = newErrors(r.errors, s.baseline);
			s.baseline = counts(r.errors);
			const shown = fresh.filter((e) => !denied(e.file));
			return shown.length > 0 ? render(shown, cwd) : undefined;
		},
	};
}
export type Checker = ReturnType<typeof openChecker>;
