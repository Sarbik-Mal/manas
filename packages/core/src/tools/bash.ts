import { parseBash, toPosix, toWindows } from "../permissions/bash";
import { defineTool } from "./registry";
import {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	type Meaning,
	meaningOf,
	oneIs,
	runShell,
	SHELL_OUTPUT_MAX,
	shellSchema,
} from "./shell";

// The bash tool (3.5): Git Bash, only when it's found at startup. Run as
// Claude Code runs its own: a login shell that first loads a snapshot of the
// user's aliases and functions. The script, the snapshot and the folder file
// travel in environment variables, so nothing of the user's lands on disk.

// Claude Code's exit-1 table for bash.
const MEANINGS: Record<string, (code: number) => Meaning> = {
	grep: oneIs("No matches found"),
	rg: oneIs("No matches found"),
	egrep: oneIs("No matches found"),
	fgrep: oneIs("No matches found"),
	"git grep": oneIs("No matches found"),
	find: oneIs("Some directories were inaccessible"),
	diff: oneIs("Files differ"),
	"git diff": oneIs("Files differ"),
	test: oneIs("Condition is false"),
	"[": oneIs("Condition is false"),
};

// pwd -W, not Claude Code's pwd -P: Git Bash mounts folders such as %TEMP%
// as /tmp, which -P reports and no Windows path can be read back from.
const LAUNCHER =
	'__s=$MANAS_BASH_SNAPSHOT; __c=$MANAS_BASH_CMD; __p=$MANAS_BASH_PWD; unset MANAS_BASH_SNAPSHOT MANAS_BASH_CMD MANAS_BASH_PWD; eval "$__s" 2>/dev/null; eval "$__c" < /dev/null && pwd -W >| "$__p"';

// What a login shell doesn't already give every command: alias expansion,
// the aliases, the functions ~/.bashrc adds, and the shell options.
const SNAPSHOT = `__base=" $(declare -F | cut -d' ' -f3 | tr '\\n' ' ') "
[ -f ~/.bashrc ] && . ~/.bashrc >/dev/null 2>&1 </dev/null
echo 'shopt -s expand_aliases'
alias -p
for __f in $(declare -F | cut -d' ' -f3); do case "$__base" in *" $__f "*) ;; *) declare -f "$__f";; esac; done
shopt -p`;
// Windows caps one environment variable at 32,767 characters.
const SNAPSHOT_MAX = 30_000;

// ponytail: a snapshot over 30K characters is left out (an env var's cap);
// write it to the session's temp folder if users' bashrc files get that big.
async function takeSnapshot(bash: string) {
	try {
		const p = Bun.spawn([bash, "-l", "-c", SNAPSHOT], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const timer = setTimeout(() => p.kill(), 10_000);
		const text = await new Response(p.stdout).text();
		clearTimeout(timer);
		return (await p.exited) === 0 && text.length <= SNAPSHOT_MAX
			? text
			: "shopt -s expand_aliases";
	} catch {
		return "shopt -s expand_aliases";
	}
}

export function bashTool(bash: string) {
	let snapshot: Promise<string> | undefined;
	return defineTool({
		name: "bash",
		description: `This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell syntax: \`/dev/null\` not \`NUL\`, forward slashes, \`$VAR\` not \`%VAR%\` or \`$env:VAR\`. For POSIX scripts; the powershell tool is the main shell.

Each call is a new bash process: variables don't carry over, but the folder does, shared with the powershell tool. After a cd, later commands and relative paths in the file tools start there, as long as it stays inside the project; outside it, the folder goes back to the project. Your aliases and functions from ~/.bashrc are available.

Don't use it for file work that has a tool: glob (not find or ls), grep (not grep or rg), read (not cat, head or tail), edit or write (not sed, awk or echo >). Talk to the user in your reply, not with echo.

Commands that can change things ask the user first, unless their rules allow them. Quote paths with spaces in double quotes. Commands run with no input: anything that prompts reads end-of-file, so never use interactive commands (git rebase -i, git add -i, an editor).

Several commands: independent ones as separate calls in parallel; dependent ones chained with &&; use ; only when later commands should run even if earlier ones fail.

Git: prefer a new commit to amending one. Before a destructive operation (reset --hard, push --force, checkout --), look for a safer way. Never skip hooks (--no-verify) or signing unless the user asks; if a hook fails, fix the cause. Commit or push only when the user asks. For a multi-line commit message use a heredoc: git commit -m "$(cat <<'EOF' ... EOF)".

Timeout: ${DEFAULT_TIMEOUT_MS / 60_000} minutes unless set (at most ${MAX_TIMEOUT_MS / 60_000}). A command still running at its timeout moves to the background (a sleep is stopped instead), and you get its ID and output file. Long output is saved to a file: you get its path and the first 2,000 characters; read or grep the file for the rest. A failed command's long output is cut to its start and end.

Temporary files go in the scratchpad directory named in the environment, not /tmp.

You can use run_in_background to run a command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. No & needed. Stop a background command with task_stop.

Avoid unnecessary sleep: don't sleep between commands that can run immediately. If waiting for a background task you started with run_in_background, you will be notified when it completes — do not poll.`,
		schema: shellSchema,
		deferred: false,
		readOnly: false,
		maxResultChars: SHELL_OUTPUT_MAX,
		permission: { command: (i) => i.command },
		title: (i) => i.description ?? i.command,
		async run(input, ctx) {
			snapshot ??= takeSnapshot(bash);
			const snap = await snapshot;
			return runShell(
				{
					spawn: (command, pwdFile) => ({
						argv: [bash, "-c", "-l", LAUNCHER],
						env: {
							MANAS_BASH_SNAPSHOT: snap,
							MANAS_BASH_CMD: command,
							MANAS_BASH_PWD: toPosix(pwdFile),
						},
					}),
					stderr: (s) => s,
					meaning: (command, code) =>
						meaningOf(parseBash(command), code, MEANINGS),
					parse: parseBash,
					cwd: toWindows,
					sleep: /^\s*sleep\b/,
				},
				input,
				ctx,
			);
		},
	});
}
