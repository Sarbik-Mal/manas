import Type from "typebox";
import { notReadOnly } from "../permissions/engine";
import { defineTool } from "./registry";

// The PowerShell tool (tools.md §2), read-only commands only until 3.1.

const SHELL = Bun.which("pwsh") ?? "powershell.exe";
const IS_51 = !/pwsh/i.test(SHELL);
const EDITION = IS_51
	? "Windows PowerShell 5.1 (powershell.exe)"
	: "PowerShell 7 (pwsh)";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
// ponytail: longer output is cut in the middle; 3.4 saves it to a file in
// the scratchpad and returns a preview plus the path.
const MAX_OUTPUT = 30_000;

// Progress bars off and UTF-8 out, on a line of their own so error positions
// point at the model's command (line 2).
const PREFIX =
	"$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n";

// 5.1 run with -EncodedCommand writes errors to stderr as CLIXML.
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

export const powershell = defineTool({
	name: "powershell",
	description:
		`Runs a PowerShell command and returns its output. Edition: ${EDITION}. ` +
		"Only read-only commands run for now: read-only cmdlets (Get-*, Test-*, Select-*, Measure-*, Where-Object and the like), " +
		"git status/log/diff/show/blame/ls-files, and `<tool> --version`. Anything else is refused. " +
		"Prefer read, grep and glob for files. Each command starts in the project folder. " +
		`Timeout: ${DEFAULT_TIMEOUT_MS / 60_000} minutes unless set (at most ${MAX_TIMEOUT_MS / 60_000}).` +
		(IS_51
			? " Windows PowerShell 5.1 has no && or || (use ;), no ?: and no ??."
			: ""),
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
	// Refused before any prompt: nothing may change files before 3.1, when
	// /rewind and shell change detection exist.
	async validate({ command }) {
		const why = await notReadOnly(command);
		return why && `only read-only commands can run for now: ${why}`;
	},
	async run({ command, timeout }, ctx) {
		const ms = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
		const encoded = Buffer.from(PREFIX + command, "utf16le").toString("base64");
		const p = Bun.spawn(
			[
				SHELL,
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				encoded,
			],
			{ cwd: ctx.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
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
		else if (code !== 0) parts.push(`exit code ${code}`);
		return cut(parts.join("\n").replace(/\r\n/g, "\n") || "(no output)");
	},
});
