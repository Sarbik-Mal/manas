import { expect, test } from "bun:test";
import { showDiff } from "./diff";

const lines = (n: number, from = 1) =>
	Array.from({ length: n }, (_, i) => `line ${i + from}`).join("\n");

test("hunks with 3 lines of context; separate changes, separate hunks", () => {
	const before = `${lines(20)}\n`;
	const after = before.replace("line 2\n", "two\n").replace("line 18\n", "");
	expect(showDiff(before, after)).toBe(
		[
			"line 1:",
			"  line 1",
			"- line 2",
			"+ two",
			"  line 3",
			"  line 4",
			"  line 5",
			"line 15:",
			"  line 15",
			"  line 16",
			"  line 17",
			"- line 18",
			"  line 19",
			"  line 20",
		].join("\n"),
	);
});

test("a new file is all +, with no 'no newline' marker; long diffs are cut at 40 rows", () => {
	expect(showDiff("", "a\nb")).toBe("line 1:\n+ a\n+ b");
	const big = showDiff("", lines(100));
	expect(big.split("\n")).toHaveLength(41);
	expect(big).toEndWith("… 61 more lines");
});
