// Eval runner (planning_docs/evals.md): each case runs Manas on a copy of its
// fixture, several times, and reports a pass rate. Costs tokens: not part of
// `bun test`. `bun run evals [case or set ...]` runs all cases, or just those.
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKey } from "../packages/core/src/provider/openai";

const EVALS = import.meta.dir;
const MAIN = join(EVALS, "..", "packages", "core", "src", "main.ts");

type Check =
	| { type: "reply"; contains: string }
	| { type: "reply_not"; contains: string }
	| { type: "reply_max_words"; max: number }
	| { type: "tool_used"; tool: string }
	| { type: "no_secret_leak" };
type Case = {
	task: string;
	fixture: string;
	sets?: string[];
	runs?: number;
	limits?: { seconds?: number; rounds?: number; cost_usd?: number };
	answers?: { permissions?: "allow" | "deny" };
	// NAME = kind: `{{NAME}}` in fixture files becomes a fresh fake secret.
	secrets?: Record<string, keyof typeof SECRET>;
	check: Check[];
};
type Usage = { input: number; cached: number; output: number };
type Run = {
	failure?: string;
	seconds: number;
	usage: Usage;
	cost: number;
};

// US$ per million tokens: input, cached input, output (OpenAI price list,
// gpt-5.6-luna after the 2026-07-30 cut).
const PRICES: Record<string, [number, number, number]> = {
	"gpt-5.6-luna": [0.2, 0.02, 1.2],
	"gpt-4o-mini": [0.15, 0.075, 0.6],
};
const cost = (u: Usage, model = "gpt-5.6-luna") => {
	const [inp, cached, out] = PRICES[model] ?? PRICES["gpt-5.6-luna"];
	return (
		((u.input - u.cached) * inp + u.cached * cached + u.output * out) / 1e6
	);
};

// Fresh fake secrets in the shapes the vault knows (and one it can only
// catch through the .env preload), so nothing secret-shaped is committed.
const random = (n: number) => {
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(
		crypto.getRandomValues(new Uint8Array(n)),
		(b) => chars[b % chars.length],
	).join("");
};
const SECRET = {
	openai: () => `sk-proj-${random(40)}`,
	stripe: () => `sk_live_${random(24)}`,
	github: () => `github_pat_${random(22)}_${random(59)}`,
	// Ends in digits, so it's never letters-only (those aren't swept).
	password: () => `${random(10)}${Math.floor(100 + Math.random() * 900)}`,
};

function fillSecrets(dir: string, secrets: Record<string, string>) {
	for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (!e.isFile()) continue;
		const file = join(e.parentPath, e.name);
		const text = readFileSync(file, "utf8");
		const filled = text.replace(
			/\{\{(\w+)\}\}/g,
			(m, name) => secrets[name] ?? m,
		);
		if (filled !== text) writeFileSync(file, filled);
	}
}

// Every text file under `dir` (sessions, the debug log); vaults are encrypted.
function textFiles(dir: string) {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((e) => e.isFile() && !e.name.endsWith(".bin"))
		.map((e) => readFileSync(join(e.parentPath, e.name), "utf8"));
}

// Records every request body on its way to OpenAI (evals.md: "the provider is
// wrapped"), and passes the reply back as it streams.
const recorded: string[] = [];
const proxy = Bun.serve({
	port: 0,
	idleTimeout: 0,
	async fetch(req) {
		const body = await req.text();
		recorded.push(body);
		const headers = new Headers(req.headers);
		headers.delete("host");
		headers.delete("accept-encoding");
		const url = new URL(req.url);
		const upstream = await fetch(`https://api.openai.com${url.pathname}`, {
			method: req.method,
			headers,
			body: body || undefined,
		});
		const out = new Headers(upstream.headers);
		out.delete("content-encoding");
		out.delete("content-length");
		return new Response(upstream.body, {
			status: upstream.status,
			headers: out,
		});
	},
});

type Msg = { kind: string; type?: string; id?: string; [k: string]: unknown };

async function runOnce(c: Case): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "manas-eval-"));
	const home = mkdtempSync(join(tmpdir(), "manas-eval-home-"));
	const start = performance.now();
	const usage: Usage = { input: 0, cached: 0, output: 0 };
	recorded.length = 0;
	const key = apiKey();
	if (!key) throw new Error("no OpenAI key (see manas doctor)");
	const proc = Bun.spawn([process.execPath, MAIN, "--stdio", "--debug"], {
		cwd: dir,
		env: {
			...process.env,
			USERPROFILE: home, // sessions, vault and logs stay in the temp home
			OPENAI_API_KEY: key,
			OPENAI_BASE_URL: `http://localhost:${proxy.port}/v1`,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const secrets = Object.fromEntries(
			Object.entries(c.secrets ?? {}).map(([name, kind]) => [
				name,
				SECRET[kind](),
			]),
		);
		cpSync(join(EVALS, "fixtures", c.fixture), dir, { recursive: true });
		fillSecrets(dir, secrets);

		let n = 0;
		const send = (line: object) => {
			proc.stdin.write(`${JSON.stringify(line)}\n`);
			proc.stdin.flush();
		};
		const request = (type: string, data: object = {}) =>
			send({ kind: "request", id: `e${++n}`, type, ...data });

		const replies: string[] = [];
		const tools = new Set<string>();
		let finished = false;
		let limitHit: string | undefined;
		const reader = (async () => {
			let buf = "";
			const decoder = new TextDecoder();
			for await (const chunk of proc.stdout) {
				buf += decoder.decode(chunk, { stream: true });
				for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
					const m = JSON.parse(buf.slice(0, i)) as Msg;
					buf = buf.slice(i + 1);
					if (m.type === "message/done") replies.push(String(m.text));
					if (m.type === "tool/started") tools.add(String(m.name));
					if (m.type === "permission/request") {
						const decision = c.answers?.permissions ?? "deny";
						send({
							kind: "response",
							id: m.id,
							ok: true,
							result: { decision },
						});
					}
					if (m.type === "turn/finished") {
						const u = m.usage as Usage;
						usage.input += u.input;
						usage.cached += u.cached;
						usage.output += u.output;
						finished = true;
					}
				}
			}
		})();

		// ponytail: no "user_ask" yet, so cases run without ask_user; declare it
		// and answer from the case's `answers` with the M2 evals.
		request("initialize", {
			client: { name: "evals", version: "0" },
			capabilities: [],
		});
		request("session/new", { cwd: dir });
		request("session/prompt", { text: c.task });
		const deadline = Date.now() + (c.limits?.seconds ?? 180) * 1000;
		const rounds = c.limits?.rounds ?? 25;
		while (!finished) {
			if (Date.now() > deadline) {
				limitHit = `over ${c.limits?.seconds ?? 180} s`;
				break;
			}
			if (recorded.length > rounds && !limitHit) {
				limitHit = `over ${rounds} model requests`;
				request("session/interrupt", { cancel_queued: true });
			}
			await Bun.sleep(100);
		}
		proc.stdin.end();
		await Promise.race([reader, Bun.sleep(5000)]);

		const reply = replies.at(-1) ?? "";
		const spent = cost(usage);
		const leaked = (s: string) =>
			[...recorded, ...textFiles(home)].some((t) => t.includes(s));
		const failure =
			limitHit ??
			(c.limits?.cost_usd !== undefined && spent > c.limits.cost_usd
				? `cost $${spent.toFixed(4)} over $${c.limits.cost_usd}`
				: undefined) ??
			c.check
				.map((ch): string | undefined => {
					switch (ch.type) {
						case "reply":
							return reply.toLowerCase().includes(ch.contains.toLowerCase())
								? undefined
								: `reply lacks "${ch.contains}"`;
						case "reply_not":
							return reply.toLowerCase().includes(ch.contains.toLowerCase())
								? `reply has "${ch.contains}"`
								: undefined;
						case "reply_max_words": {
							const words = reply.split(/\s+/).filter(Boolean).length;
							return words <= ch.max
								? undefined
								: `reply is ${words} words (max ${ch.max})`;
						}
						case "tool_used":
							return tools.has(ch.tool)
								? undefined
								: `${ch.tool} not used (${[...tools].join(", ") || "no tools"})`;
						case "no_secret_leak": {
							const names = Object.entries(secrets)
								.filter(([, v]) => leaked(v))
								.map(([k]) => k);
							return names.length
								? `LEAKED to OpenAI or disk: ${names.join(", ")}`
								: undefined;
						}
						default:
							return `unknown check type "${(ch as { type: string }).type}"`;
					}
				})
				.find(Boolean);
		return {
			failure,
			seconds: (performance.now() - start) / 1000,
			usage,
			cost: spent,
		};
	} finally {
		proc.kill();
		await proc.exited;
		rmSync(dir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
}

const only = process.argv.slice(2);
const results = [];
for (const path of new Bun.Glob("cases/*/case.toml").scanSync(EVALS)) {
	const id = path.split(/[\\/]/)[1];
	const c = Bun.TOML.parse(await Bun.file(join(EVALS, path)).text()) as Case;
	if (
		only.length &&
		!only.includes(id) &&
		!c.sets?.some((s) => only.includes(s))
	)
		continue;
	const runs: Run[] = [];
	for (let i = 0; i < (c.runs ?? 3); i++) runs.push(await runOnce(c));
	const avg = (f: (r: Run) => number) =>
		runs.reduce((s, r) => s + f(r), 0) / runs.length;
	results.push({
		id,
		passed: runs.filter((r) => !r.failure).length,
		runs: runs.length,
		avgSeconds: avg((r) => r.seconds),
		avgInput: avg((r) => r.usage.input),
		avgCached: avg((r) => r.usage.cached),
		avgOutput: avg((r) => r.usage.output),
		avgCostUsd: avg((r) => r.cost),
		failures: runs.flatMap((r) => (r.failure ? [r.failure] : [])),
	});
}
proxy.stop(true);

const k = (n: number) => `${(n / 1000).toFixed(1)}K`;
console.log(
	`${"case".padEnd(16)} ${"pass".padStart(5)} ${"time".padStart(6)} ${"input".padStart(7)} ${"cached".padStart(7)} ${"output".padStart(7)} ${"cost".padStart(8)}`,
);
for (const r of results) {
	const cachePct = r.avgInput
		? Math.round((100 * r.avgCached) / r.avgInput)
		: 0;
	console.log(
		`${r.id.padEnd(16)} ${`${r.passed}/${r.runs}`.padStart(5)} ${`${r.avgSeconds.toFixed(0)}s`.padStart(6)} ${k(r.avgInput).padStart(7)} ${`${cachePct}%`.padStart(7)} ${k(r.avgOutput).padStart(7)} ${`$${r.avgCostUsd.toFixed(4)}`.padStart(8)}${r.failures[0] ? `  ${r.failures[0]}` : ""}`,
	);
}
const total = results.reduce((s, r) => s + r.avgCostUsd * r.runs, 0);
console.log(`total cost about $${total.toFixed(3)}`);

// Local time as YYYYMMDDHHMMSS ("sv" locale gives "YYYY-MM-DD HH:MM:SS").
const runId = new Date().toLocaleString("sv").replace(/\D/g, "");
mkdirSync(join(EVALS, "results"), { recursive: true });
writeFileSync(
	join(EVALS, "results", `${runId}.json`),
	JSON.stringify({ runId, results }, null, 2),
);
if (results.some((r) => r.passed < r.runs)) process.exit(1);
