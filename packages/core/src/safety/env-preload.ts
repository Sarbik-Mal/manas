import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rgPath } from "../platform/win/bin";
import type { Vault } from "./scrub";

// architecture.md §10: every value in the project's .env files goes into the
// vault at startup, so any copy anywhere (a log line, command output) is
// caught, even with no recognizable pattern. The cost: harmless config values
// (a URL, a host name) are hidden from the model too.

const SKIP = ["**/node_modules/**", "**/.git/**", "**/.venv/**"];
const EXAMPLE = /\.(example|sample|template)$/i;

// .env files anywhere in the project. They're usually git-ignored, so ignore
// files can't be used to find them.
export async function envFiles(cwd: string) {
	if (!existsSync(cwd)) return [];
	const r = Bun.spawnSync(
		[
			await rgPath(),
			"--files",
			"--hidden",
			"--no-ignore",
			"-g",
			".env*",
			...SKIP.flatMap((g) => ["-g", `!${g}`]),
		],
		{ cwd },
	);
	return r.stdout
		.toString()
		.split(/\r?\n/)
		.filter((f) => f && !EXAMPLE.test(f))
		.map((f) => join(cwd, f));
}

// `KEY=value`, `export KEY="value"`, `KEY='v' # note`: the values.
export function envValues(text: string) {
	const values: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?[\w.-]+\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[1].trim();
		const q = v[0];
		if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0)
			v = v.slice(1, v.indexOf(q, 1));
		else v = v.replace(/\s+#.*$/, "");
		if (v) values.push(v);
	}
	return values;
}

export async function preloadEnv(cwd: string, vault: Vault) {
	for (const file of await envFiles(cwd)) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const v of envValues(text)) vault.add("env", v);
	}
}
