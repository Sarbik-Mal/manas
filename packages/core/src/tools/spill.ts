import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrub, type Vault } from "../safety/scrub";

// A result too big for the conversation goes to a file (3.4), as Claude
// Code's persisted output: the model gets the path and the first 2,000
// characters, and reads or greps the file for the rest.

export const RESULT_MAX = 50_000;
const PREVIEW = 2_000;
const PERSIST_MAX = 64 * 1024 * 1024;

// Claude's sizes: 45.2KB, 2KB, 64MB.
const one = (v: number) => v.toFixed(1).replace(/\.0$/, "");
const size = (n: number) =>
	n < 1024
		? `${n} bytes`
		: n < 1024 ** 2
			? `${one(n / 1024)}KB`
			: `${one(n / 1024 ** 2)}MB`;

// The start, cut at a line end when one is past halfway.
const head = (s: string, n: number) => {
	if (s.length <= n) return { text: s, more: false };
	const nl = s.slice(0, n).lastIndexOf("\n");
	return { text: s.slice(0, nl > n * 0.5 ? nl : n), more: true };
};

export function spill(
	output: string,
	{
		dir,
		id,
		vault,
		max,
		cap = PERSIST_MAX,
	}: { dir: string; id: string; vault: Vault; max: number; cap?: number },
) {
	if (output.length <= max) return output;
	// Manas's own file: scrubbed, so a secret never reaches the disk.
	const text = scrub(output, vault).text;
	const kept = text.slice(0, cap);
	const file = join(dir, `${id.replace(/[^A-Za-z0-9_.-]/g, "-")}.txt`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, kept);
	} catch {
		const shown = head(text, max).text;
		return `<truncated-output>\nOutput too large (${size(text.length)}). It could not be saved, so only the first ${size(shown.length)} are shown; the rest was dropped. If the tool can page or filter its results, call it again for the part you need.\n\n${shown}\n</truncated-output>`;
	}
	const line =
		kept.length === text.length
			? `Output too large (${size(text.length)}). Full output saved to: ${file}`
			: `Output exceeded the ${size(cap)} persist limit; only the first ${size(cap)} were saved to: ${file}`;
	const p = head(kept, PREVIEW);
	return `<persisted-output>\n${line}\n\nPreview (first ${size(PREVIEW)}):\n${p.text}${p.more ? "\n...\n" : "\n"}</persisted-output>`;
}
