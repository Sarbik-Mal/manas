import { expect, test } from "bun:test";
import { coreTools } from ".";
import { findGitBash } from "./gitbash";

const PF = "C:\\Program Files\\Git\\bin\\bash.exe";
const has =
	(...paths: string[]) =>
	(p: string) =>
		paths.includes(p);

test("3.5: Claude Code's order: override, the install folders, git on PATH", () => {
	const none = () => null;
	expect(
		findGitBash(
			{ MANAS_GIT_BASH_PATH: "D:\\g\\bash.exe" },
			has("D:\\g\\bash.exe", PF),
			none,
		),
	).toEqual({ path: "D:\\g\\bash.exe" });
	expect(findGitBash({}, has(PF), none)).toEqual({
		path: PF,
		warning: undefined,
	});
	expect(
		findGitBash(
			{},
			has("D:\\Git\\bin\\bash.exe"),
			() => "D:\\Git\\cmd\\git.exe",
		),
	).toEqual({ path: "D:\\Git\\bin\\bash.exe", warning: undefined });
	// The build-order check: no Git, no bash (WSL's bash on PATH never counts).
	expect(
		findGitBash(
			{},
			() => false,
			() => null,
		),
	).toEqual({ path: null, warning: undefined });
	expect(coreTools(null).map((t) => t.name)).not.toContain("bash");
	expect(coreTools(PF).map((t) => t.name)).toContain("bash");
});

test("a bad override falls back with a warning", () => {
	expect(
		findGitBash({ MANAS_GIT_BASH_PATH: "D:\\g\\git.exe" }, has(PF), () => null),
	).toEqual({
		path: PF,
		warning:
			'MANAS_GIT_BASH_PATH "D:\\g\\git.exe" is not a bash/sh binary; falling back to auto-detection',
	});
	expect(
		findGitBash(
			{ MANAS_GIT_BASH_PATH: "D:\\nope\\bash.exe" },
			() => false,
			() => null,
		),
	).toEqual({
		path: null,
		warning:
			'MANAS_GIT_BASH_PATH "D:\\nope\\bash.exe" not found; falling back to auto-detection',
	});
});
