import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { within } from "../permissions/engine";
import { parsePowerShell } from "../permissions/powershell";
import { defineTool } from "./registry";

// The PowerShell tool (tools.md §2). Spawned as Claude Code spawns its own.

const SHELL = Bun.which("pwsh") ?? "powershell.exe";
const IS_51 = !/pwsh/i.test(SHELL);
export const EDITION = IS_51
	? "Windows PowerShell 5.1 (powershell.exe)"
	: "PowerShell 7 (pwsh)";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
// ponytail: longer output is cut in the middle; 3.4 saves it to a file in
// the scratchpad and returns a preview plus the path.
const MAX_OUTPUT = 30_000;

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

export function cut(text: string, max = MAX_OUTPUT) {
	if (text.length <= max) return text;
	const half = Math.floor(max / 2);
	return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters cut …]\n${text.slice(-half)}`;
}

// What an exit code means, read from the last command that isn't a
// formatter (Claude Code's table): some programs exit 1 for "no match".
type Meaning = { failed: boolean; note?: string };
const oneIs = (note: string) => (code: number) => ({
	failed: code !== 0 && code !== 1,
	note: code === 1 ? note : undefined,
});
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

async function meaning(command: string, code: number): Promise<Meaning> {
	const plain = { failed: code !== 0 };
	if (code === 0) return plain;
	try {
		const parts = (await parsePowerShell(command)).commands;
		const last = parts.findLast(
			(p) => !FORMATTERS.has((p.resolved ?? p.name ?? "").toLowerCase()),
		);
		const exe = (last?.resolved ?? last?.name ?? "")
			.split(/[\\/]/)
			.pop()
			?.toLowerCase()
			.replace(/\.(exe|cmd|bat)$/, "");
		const key = exe === "git" ? `git ${last?.args[0] ?? ""}` : (exe ?? "");
		return MEANINGS[key]?.(code) ?? plain;
	} catch {
		return plain;
	}
}

// The folder a finished command left behind; undefined if it didn't get
// that far (a timeout, `exit`).
function endedIn(pwdFile: string) {
	try {
		return readFileSync(pwdFile, "utf8").replace(/^\uFEFF/, "") || undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(pwdFile, { force: true });
	}
}

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

Timeout: ${DEFAULT_TIMEOUT_MS / 60_000} minutes unless set (at most ${MAX_TIMEOUT_MS / 60_000}). Output over ${MAX_OUTPUT} characters is cut in the middle.`,
	schema: Type.Object(
		{
			command: Type.String({ description: "The command to run." }),
			description: Type.Union([Type.String(), Type.Null()], {
				description: "What it does, in 5-10 words, or null.",
			}),
			timeout: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
				description: `Timeout in milliseconds (at most ${MAX_TIMEOUT_MS}), or null for ${DEFAULT_TIMEOUT_MS}.`,
			}),
		},
		{ additionalProperties: false },
	),
	deferred: false,
	readOnly: false,
	permission: { command: (i) => i.command },
	title: (i) => i.description ?? i.command,
	// ponytail: /rewind can't undo what a command changes until 3.6 records
	// changed, deleted and new files around each command.
	async run({ command, timeout }, ctx) {
		const ms = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
		const pwdFile = join(tmpdir(), `manas-pwd-${randomUUID()}`);
		const script =
			(mustLead(command) ? "" : PREFIX) + command + suffix(pwdFile);
		const env: Record<string, string | undefined> = {
			...process.env,
			[SCRIPT_VAR]: script,
		};
		env.NO_COLOR ??= "1";
		env.PYTHONIOENCODING ??= "utf-8:surrogateescape";
		const p = Bun.spawn(
			[
				SHELL,
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				LAUNCHER,
			],
			{
				cwd: ctx.shell.cwd,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		// The whole tree: a command may have started programs of its own.
		const kill = () =>
			Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(p.pid)]);
		let timedOut = false;
		// ponytail: a timeout stops the command; 3.3 moves it to the background.
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, ms);
		ctx.signal.addEventListener("abort", kill, { once: true });
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]).finally(() => {
			clearTimeout(timer);
			ctx.signal.removeEventListener("abort", kill);
		});
		const parts = [out.trimEnd(), fromClixml(err).trimEnd()].filter(Boolean);
		if (timedOut)
			parts.push(`Command timed out after ${ms / 1000} s and was stopped.`);
		else {
			const m = await meaning(command, code);
			if (m.failed) parts.push(`Command failed with exit code ${code}`);
			else if (m.note) parts.push(m.note);
		}
		// The folder carries over inside the project, as in Claude Code.
		const now = endedIn(pwdFile);
		if (now !== undefined && now !== ctx.shell.cwd) {
			if (within(now, ctx.cwd)) ctx.shell.cwd = now;
			else {
				ctx.shell.cwd = ctx.cwd;
				parts.push(`Shell cwd was reset to ${ctx.cwd}`);
			}
		}
		return cut(parts.join("\n").replace(/\r\n/g, "\n") || "(no output)");
	},
});
