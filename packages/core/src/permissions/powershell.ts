// Parses PowerShell commands with PowerShell's own parser, in one long-running
// process (a new process per command costs ~200–500 ms). Commands are never
// matched as text (tools.md §2).
import type { Subprocess } from "bun";
import script from "../assets/ps-parser.ps1" with { type: "text" };

export type ParseResult = {
	errors: string[]; // any → the caller asks
	// name null = dynamic → ask. `resolved`: aliases followed (dir →
	// Get-ChildItem); `module`: e.g. Microsoft.PowerShell.Management.
	commands: {
		name: string | null;
		resolved: string | null;
		module: string | null;
		type: string;
		args: string[];
	}[];
	redirections: string[]; // file targets
	invocations: string[]; // .NET method calls → ask
};

const TIMEOUT_MS = 5000;
type Proc = Subprocess<"pipe", "pipe", "ignore">;
type Pending = {
	resolve: (r: ParseResult) => void;
	reject: (e: Error) => void;
	timer: Timer;
	proc: Proc;
};
const pending = new Map<number, Pending>();
let proc: Proc | undefined;
let nextId = 0;

// Only the dead process's requests: a replacement may already have its own.
function failAll(dead: Proc, err: Error) {
	for (const [id, p] of pending) {
		if (p.proc !== dead) continue;
		pending.delete(id);
		clearTimeout(p.timer);
		p.reject(err);
	}
}

function start() {
	const shell = Bun.which("pwsh") ?? "powershell.exe";
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const p = Bun.spawn(
		[
			shell,
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			encoded,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "ignore" },
	);
	p.unref(); // never keeps Manas alive
	p.exited.then(() => {
		if (proc === p) proc = undefined;
		failAll(p, new Error("PowerShell parser exited"));
	});
	readResults(p);
	return p;
}

async function readResults(p: Proc) {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of p.stdout) {
		buf += decoder.decode(chunk, { stream: true });
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (!line) continue;
			const { id, fatal, ...result } = JSON.parse(line);
			const req = pending.get(id);
			if (!req) continue;
			pending.delete(id);
			clearTimeout(req.timer);
			if (fatal) req.reject(new Error(`PowerShell parser: ${fatal}`));
			else req.resolve(result as ParseResult);
		}
	}
}

export function parsePowerShell(command: string): Promise<ParseResult> {
	proc ??= start();
	const p = proc;
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error("PowerShell parser timed out"));
			stopPowerShellParser(); // a stuck parser is replaced on the next call
		}, TIMEOUT_MS);
		pending.set(id, { resolve, reject, timer, proc: p });
		p.stdin.write(`${JSON.stringify({ id, command })}\n`);
		p.stdin.flush();
	});
}

export function stopPowerShellParser() {
	proc?.kill();
	proc = undefined;
}
