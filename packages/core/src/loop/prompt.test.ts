import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../testing/fake-openai";
import { EDITION } from "../tools/powershell";
import { dateNote, firstMessage, INSTRUCTIONS } from "./prompt";

test("cache guard: the instructions hold nothing that changes", () => {
	expect(INSTRUCTIONS).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
	expect(INSTRUCTIONS).toContain("You are Manas");
});

test("size limit: the instructions stay under 3,000 tokens", () => {
	// ponytail: characters / 4 as the token count, like read's cap.
	expect(INSTRUCTIONS.length / 4).toBeLessThan(3000);
});

test("the first message: environment plus a git snapshot, the same bytes twice", () => {
	const cwd = tempRoot();
	const git = (...args: string[]) =>
		Bun.spawnSync(
			["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
			{ cwd },
		);
	git("init", "-q", "-b", "main");
	writeFileSync(join(cwd, "a.txt"), "a");
	git("add", ".");
	git("commit", "-qm", "first commit");
	writeFileSync(join(cwd, "b.txt"), "b");

	const text = firstMessage(cwd, "2026-10-26");
	expect(text).toBe(firstMessage(cwd, "2026-10-26"));
	expect(text).toStartWith("<environment>\nToday's date: 2026-10-26\nOS: ");
	expect(text).toContain(`Shell: ${EDITION} (the powershell tool)`);
	expect(text).toContain(`Working directory: ${cwd}`);
	expect(text).toContain("Current branch: main\nMain branch: main");
	expect(text).toContain("Status:\n?? b.txt");
	expect(text).toMatch(
		/Recent commits:\n[0-9a-f]+ first commit\n<\/git_status>$/,
	);

	expect(firstMessage(tempRoot(), "2026-10-26")).toEndWith(
		"</environment>\nNot a git repository.",
	);
});

test("a date note only when the day changed since the model was last told", () => {
	const dev = (content: string) => ({ role: "developer" as const, content });
	const history = [
		dev(firstMessage(tempRoot(), "2026-10-26")),
		{ role: "user" as const, content: "Today's date: 1999-01-01" },
	];
	expect(dateNote(history, "2026-10-26")).toBeUndefined();
	expect(dateNote(history, "2026-10-27")).toBe(
		"Today's date is now 2026-10-27.",
	);
	history.push(dev("Today's date is now 2026-10-27."));
	expect(dateNote(history, "2026-10-27")).toBeUndefined();
	expect(dateNote([], "2026-10-27")).toBeUndefined();
});
