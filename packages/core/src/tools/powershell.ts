import { readOnly } from "../permissions/engine";
import { parsePowerShell } from "../permissions/powershell";
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

export { cut } from "./shell";

// The PowerShell tool (tools.md §2). Spawned as Claude Code spawns its own.

export const SHELL = Bun.which("pwsh") ?? "powershell.exe";
const IS_51 = !/pwsh/i.test(SHELL);
export const EDITION = IS_51
	? "Windows PowerShell 5.1 (powershell.exe)"
	: "PowerShell 7 (pwsh)";

// The script travels in an environment variable, not on the command line
// (-EncodedCommand fails past ~12K characters); the launcher clears it so
// the command's own children don't see it.
const SCRIPT_VAR = "MANAS_SHELL_SCRIPT";
const LAUNCHER = `$__m = $env:${SCRIPT_VAR}; $env:${SCRIPT_VAR} = $null; Invoke-Expression -Command $__m`;

// Progress bars off, UTF-8 out and for `>` and pipes into programs, no ANSI
// colours (Claude Code's set). On a line of its own, so error positions point
// at the model's command (line 2).
const PREFIX =
	"$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
	"try { $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8' } catch {}; " +
	"if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { try { $OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}; " +
	"if ($null -ne $PSStyle) { try { $PSStyle.OutputRendering = 'PlainText' } catch {} } }\n";

// using, param(), begin{} and [attributes] must open a script, so those
// commands go without the prefix (as in Claude Code).
function mustLead(command: string) {
	const rest = command.replace(/^(\s|;|#[^\n]*|<#[\s\S]*?(#>|$))*/, "");
	return (
		/^using\s+(namespace|module|assembly)\b/i.test(rest) ||
		/^param\s*\(/i.test(rest) ||
		/^(begin|process|end|clean|dynamicparam)\s*\{/i.test(rest) ||
		(/^\[\w/.test(rest) && !/^\[[\w.]+\]::/.test(rest))
	);
}

// The exit code, and the folder the command ended in for the next call.
const suffix = (pwdFile: string) =>
	"\n; $_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }" +
	`\n; (Get-Location).Path | Out-File -FilePath '${pwdFile.replace(/'/g, "''")}' -Encoding utf8 -NoNewline` +
	"\n; if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $host.SetShouldExit($_ec) } else { exit $_ec }";

// 5.1 writes errors to stderr as CLIXML in some modes.
export function fromClixml(s: string) {
	if (!s.startsWith("#< CLIXML")) return s;
	return [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
		.map((m) => m[1])
		.join("")
		.replace(/_x([0-9A-F]{4})_/gi, (_, h: string) =>
			String.fromCharCode(Number.parseInt(h, 16)),
		)
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

const MEANINGS: Record<string, (code: number) => Meaning> = {
	grep: oneIs("No matches found"),
	rg: oneIs("No matches found"),
	egrep: oneIs("No matches found"),
	fgrep: oneIs("No matches found"),
	findstr: oneIs("No matches found"),
	"git grep": oneIs("No matches found"),
	where: oneIs("No matching files found"),
	fc: oneIs("Files differ"),
	diff: oneIs("Files differ"),
	"git diff": oneIs("Files differ"),
	robocopy: (code) => ({
		failed: code < 0 || code >= 8,
		note:
			code === 0
				? "No files copied (already in sync)"
				: code < 8
					? code & 1
						? "Files copied successfully"
						: "Robocopy completed (no errors)"
					: undefined,
	}),
};
const FORMATTERS = new Set(
	"select-object sort-object group-object get-unique format-table format-list format-wide out-string out-host".split(
		" ",
	),
);

export const meaning = (command: string, code: number) =>
	meaningOf(parsePowerShell(command), code, MEANINGS, (n) => FORMATTERS.has(n));

const SYNTAX_51 = `
Windows PowerShell 5.1 syntax:
- No && or || (a parser error). To run B only if A succeeds: A; if ($?) { B }. To run both regardless: A; B.
- No ternary (?:), no null-coalescing (??) and no null-conditional (?.): use if/else and explicit $null -eq checks.
- Avoid 2>&1 on native programs: 5.1 wraps each stderr line in an error record and sets $? to false even when the program exited 0. Stderr is captured anyway.
- >, >> and Out-File write UTF-8 here, but Set-Content and Add-Content default to the ANSI code page: pass -Encoding utf8 when other tools will read the file.
- ConvertFrom-Json returns a PSCustomObject; -AsHashtable isn't available.`;
const SYNTAX_7 = `
PowerShell 7 syntax: && and ||, ternary (?:), ?? and ?. all work. >, Out-File and Set-Content write UTF-8 without a BOM.`;

export const powershell = defineTool({
	name: "powershell",
	description: `Runs a PowerShell command and returns its output. Edition: ${EDITION}.

Each call is a new PowerShell process: variables and functions don't carry over, but the folder does. After a cd (Set-Location), later commands and relative paths in the file tools start there, as long as it stays inside the project; outside it, the folder goes back to the project. Don't prefix commands with a cd to the project folder.

Use this for terminal work: git, package managers, builds, tests, system facts. Don't use it for file work that has a tool:
- Find files: glob (not Get-ChildItem -Recurse)
- Search contents: grep (not Select-String)
- Read files: read (not Get-Content)
- Change files: edit, or write to create or replace one (not Set-Content or Out-File)
- Talk to the user: your reply (not Write-Output or Write-Host)

Commands that can change things ask the user first, unless their rules allow them.

Before creating files or folders, check that the parent folder exists (Test-Path). Quote paths with spaces in double quotes. Run a program whose path has spaces with the call operator: & "C:\\Program Files\\App\\app.exe" arg
${IS_51 ? SYNTAX_51 : SYNTAX_7}

Non-interactive: the command runs with -NonInteractive and no input, so anything that prompts fails or reads end-of-file.
- Never use Read-Host, Get-Credential, Out-GridView, $Host.UI.PromptForChoice or pause.
- Destructive cmdlets may ask for confirmation: add -Confirm:$false when you mean it, and -Force for read-only or hidden items.
- Never use commands that open an editor or an interactive mode (git rebase -i, git add -i, git commit without -m).
- -ErrorAction SilentlyContinue hides a cmdlet's error output, but the command still fails. To make a failure truly non-fatal: try { Cmdlet ... -ErrorAction Stop } catch {}

Multi-line text for a program (a commit message, file content): use a single-quoted here-string, so $ and backticks stay literal. The closing '@ must start its own line, with nothing before it:
git commit -m @'
Subject line

Body with a $literal dollar sign.
'@
Use @"..."@ only when you want variables expanded. For arguments PowerShell would read as operators (-, @, --), the stop-parsing token passes the rest as written: git log --% --format=%H

Unix commands that don't exist here, and what to use instead:
- head / tail: Get-Content file -TotalCount N / -Tail N; piped: | Select-Object -First N / -Last N
- which: (Get-Command name).Source
- touch: if (-not (Test-Path f)) { New-Item -ItemType File f } (New-Item -Force on an existing file empties it)
- wc -l: (Get-Content f | Measure-Object -Line).Lines
- mkdir -p: New-Item -ItemType Directory -Force dir
- rm -rf: Remove-Item -Recurse -Force dir
- ln -s: New-Item -ItemType SymbolicLink -Path link -Target target
- 2>/dev/null: 2>$null
- VAR=x cmd: $env:VAR = 'x'; cmd
- if [ -f x ], for x in *, backtick substitution: if (Test-Path x), foreach ($x in ...), $(cmd)
Environment variables: read $env:NAME, set $env:NAME = 'value'. The registry: the HKLM:\\ and HKCU:\\ drives.

Several commands: independent ones as separate calls in parallel; dependent ones chained in one call.

Git: prefer a new commit to amending one. Before a destructive operation (reset --hard, push --force, checkout --), look for a safer way. Never skip hooks (--no-verify) or signing unless the user asks; if a hook fails, fix the cause. Commit or push only when the user asks.

Timeout: ${DEFAULT_TIMEOUT_MS / 60_000} minutes unless set (at most ${MAX_TIMEOUT_MS / 60_000}). A command still running at its timeout moves to the background (a Start-Sleep is stopped instead), and you get its ID and output file. Long output is saved to a file: you get its path and the first 2,000 characters; read or grep the file for the rest. A failed command's long output is cut to its start and end.

Temporary files (intermediate results, helper scripts, outputs that don't belong in the project) go in the scratchpad directory named in the environment, not the system temp folder.

You can use run_in_background to run a command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. Stop a background command with task_stop.

Avoid unnecessary Start-Sleep: don't sleep between commands that can run immediately. If waiting for a background task you started with run_in_background, you will be notified when it completes — do not poll.`,
	schema: shellSchema,
	deferred: false,
	readOnly: false,
	maxResultChars: SHELL_OUTPUT_MAX,
	permission: { command: (i) => i.command },
	title: (i) => i.description ?? i.command,
	async run(input, ctx) {
		return runShell(
			{
				spawn: (command, pwdFile) => ({
					argv: [
						SHELL,
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-Command",
						LAUNCHER,
					],
					env: {
						[SCRIPT_VAR]:
							(mustLead(command) ? "" : PREFIX) + command + suffix(pwdFile),
					},
				}),
				stderr: fromClixml,
				meaning,
				parse: parsePowerShell,
				readOnly,
				path: (arg) => arg,
				cwd: (raw) => raw,
				sleep: /^\s*(start-sleep|sleep)\b/i,
			},
			input,
			ctx,
		);
	},
});
