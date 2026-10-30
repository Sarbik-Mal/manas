import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// Finding Git Bash (3.5), in Claude Code's order: the override (it must be a
// bash.exe or sh.exe that exists), the two usual install folders, then git
// on PATH (its bin\bash.exe). A `bash` on PATH is never used: on Windows
// that's often WSL's.
export function findGitBash(
	env: Record<string, string | undefined> = process.env,
	exists: (p: string) => boolean = existsSync,
	which: (cmd: string) => string | null = (c) => Bun.which(c),
): { path: string | null; warning?: string } {
	let warning: string | undefined;
	const override = env.MANAS_GIT_BASH_PATH;
	if (override) {
		const shell = ["bash.exe", "sh.exe", "bash", "sh"].includes(
			basename(override).toLowerCase(),
		);
		if (shell && exists(override)) return { path: override };
		warning = `MANAS_GIT_BASH_PATH "${override}" ${shell ? "not found" : "is not a bash/sh binary"}; falling back to auto-detection`;
	}
	for (const p of [
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	])
		if (exists(p)) return { path: p, warning };
	const git = which("git");
	if (git) {
		const p = join(git, "..", "..", "bin", "bash.exe");
		if (exists(p)) return { path: p, warning };
	}
	return { path: null, warning };
}

let found: ReturnType<typeof findGitBash> | undefined;
// Once per process, before the first session's tool list is fixed.
export const gitBash = () => (found ??= findGitBash());
