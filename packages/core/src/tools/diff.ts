import { structuredPatch } from "diff";

// The approval prompt's diff for edit and write: jsdiff hunks with 3 lines of
// context, as `line N:` then `  same`, `- old` and `+ new` rows.
// ponytail: 40 rows at most, so a big change is approved partly unseen; a
// full, scrollable diff comes with the Ink screen or an editor's open_diff.

const MAX_ROWS = 40;

export function showDiff(before: string, after: string) {
	const rows: string[] = [];
	for (const h of structuredPatch("", "", before, after, "", "", {
		context: 3,
	}).hunks) {
		rows.push(`line ${h.newStart}:`);
		for (const l of h.lines) {
			if (l.startsWith("\\")) continue; // "\ No newline at end of file"
			rows.push(`${l[0] === " " ? " " : l[0]} ${l.slice(1)}`);
		}
	}
	if (rows.length <= MAX_ROWS) return rows.join("\n");
	return [
		...rows.slice(0, MAX_ROWS),
		`… ${rows.length - MAX_ROWS} more lines`,
	].join("\n");
}
