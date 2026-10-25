// Eval runner (planning_docs/evals.md): each case runs Manas on a copy of its
// fixture, several times, and reports a pass rate. Costs tokens: not part of `bun test`.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EVALS = import.meta.dir;
const MAIN = join(EVALS, "..", "packages", "core", "src", "main.ts");

type Check = { type: "reply"; contains: string };
type Case = {
	task: string;
	fixture: string;
	runs?: number;
	limits?: { seconds?: number };
	check: Check[];
};

// Returns why the check failed, or undefined if it passed.
function runCheck(check: Check, reply: string): string | undefined {
	switch (check.type) {
		case "reply":
			return reply.toLowerCase().includes(check.contains.toLowerCase())
				? undefined
				: `reply lacks "${check.contains}"`;
		default:
			return `unknown check type "${(check as { type: string }).type}"`;
	}
}

async function runOnce(c: Case) {
	const dir = mkdtempSync(join(tmpdir(), "manas-eval-"));
	const start = performance.now();
	try {
		cpSync(join(EVALS, "fixtures", c.fixture), dir, { recursive: true });
		const proc = Bun.spawn([process.execPath, MAIN, c.task], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
			timeout: (c.limits?.seconds ?? 120) * 1000,
		});
		const [reply, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const failure =
			code !== 0
				? `exit ${code}: ${stderr.trim() || "timed out"}`
				: c.check.map((ch) => runCheck(ch, reply)).find(Boolean);
		return { failure, seconds: (performance.now() - start) / 1000 };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const results = [];
for (const path of new Bun.Glob("cases/*/case.toml").scanSync(EVALS)) {
	const id = path.split(/[\\/]/)[1];
	const c = Bun.TOML.parse(await Bun.file(join(EVALS, path)).text()) as Case;
	const runs = [];
	for (let i = 0; i < (c.runs ?? 3); i++) runs.push(await runOnce(c));
	results.push({
		id,
		passed: runs.filter((r) => !r.failure).length,
		runs: runs.length,
		avgSeconds: runs.reduce((s, r) => s + r.seconds, 0) / runs.length,
		failures: runs.flatMap((r) => (r.failure ? [r.failure] : [])),
	});
}

for (const r of results) {
	const rate = `${r.passed}/${r.runs}`;
	const why = r.failures[0] ? `  ${r.failures[0]}` : "";
	console.log(
		`${r.id.padEnd(24)} ${rate.padStart(5)}  ${r.avgSeconds.toFixed(1)}s${why}`,
	);
}

// Local time as YYYYMMDDHHMMSS ("sv" locale gives "YYYY-MM-DD HH:MM:SS").
const runId = new Date().toLocaleString("sv").replace(/\D/g, "");
mkdirSync(join(EVALS, "results"), { recursive: true });
writeFileSync(
	join(EVALS, "results", `${runId}.json`),
	JSON.stringify({ runId, results }, null, 2),
);
if (results.some((r) => r.passed < r.runs)) process.exit(1);
