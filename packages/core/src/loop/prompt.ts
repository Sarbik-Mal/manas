import { release, version } from "node:os";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import instructions from "../assets/prompts/instructions.md" with {
	type: "text",
};
import { textOf } from "../session/store";
import { EDITION } from "../tools/powershell";

// system-prompt.md: the instructions are the same for every session and
// project, so OpenAI caches them across sessions. Everything that varies goes
// in the session's first message, and later changes are appended, never edited in.
export const INSTRUCTIONS = instructions;

// The local date, no time: a clock in the prompt would break the cache.
export const today = () => new Date().toLocaleDateString("en-CA");

// The first message of a session (developer role): its environment and a git
// snapshot, as Claude Code gives. Saved with the session, so a resume reuses it.
// The scratchpad line is Claude Code's.
export function firstMessage(
	cwd: string,
	date = today(),
	scratch?: string,
	bash = false,
) {
	return [
		"<environment>",
		`Today's date: ${date}`,
		`OS: ${version()} ${release()}`,
		bash
			? `Shell: ${EDITION} (primary); Bash tool also available for POSIX scripts — each takes its own syntax.`
			: `Shell: ${EDITION} (the powershell tool)`,
		`Working directory: ${cwd}`,
		...(scratch
			? [
					`Scratchpad directory: ${scratch} — always use it for temporary files (intermediate results, scripts, outputs that don't belong in the project) instead of the system temp folder; it is session-specific, isolated from the project, and can be used without permission prompts.`,
				]
			: []),
		"</environment>",
		gitSnapshot(cwd),
	].join("\n");
}

const STATUS_MAX = 2000;

function gitSnapshot(cwd: string) {
	const git = (...args: string[]) => {
		try {
			const r = Bun.spawnSync(["git", ...args], { cwd });
			return r.exitCode === 0 ? r.stdout.toString().trimEnd() : undefined;
		} catch {
			return undefined; // git isn't installed
		}
	};
	if (git("rev-parse", "--is-inside-work-tree") !== "true")
		return "Not a git repository.";
	const main =
		git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")?.replace(
			/^origin\//,
			"",
		) ??
		["main", "master"].find(
			(b) =>
				git("rev-parse", "--verify", "--quiet", `refs/heads/${b}`) !==
				undefined,
		);
	let status = git("status", "--short") ?? "";
	if (status.length > STATUS_MAX) {
		status = `${status.slice(0, STATUS_MAX)}\n… (cut; run git status for the rest)`;
	}
	return [
		"<git_status>",
		"A snapshot from the start of the session; it doesn't update.",
		`Current branch: ${git("branch", "--show-current") || "(detached HEAD)"}`,
		...(main ? [`Main branch: ${main}`] : []),
		"Status:",
		status || "(clean)",
		"Recent commits:",
		git("log", "--oneline", "-5") || "(none)",
		"</git_status>",
	].join("\n");
}

const TOLD = /^Today's date(?:: | is now )(\d{4}-\d{2}-\d{2})/m;

// A note for the end of history when the day changed since the model was
// last told the date (a session resumed tomorrow), else undefined.
export function dateNote(history: ResponseInputItem[], date = today()) {
	for (let i = history.length - 1; i >= 0; i--) {
		const item = history[i];
		if (!("role" in item) || item.role !== "developer") continue;
		const told = TOLD.exec(textOf(item))?.[1];
		if (told) return told === date ? undefined : `Today's date is now ${date}.`;
	}
	return undefined;
}
