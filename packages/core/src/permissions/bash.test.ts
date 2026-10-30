import { expect, test } from "bun:test";
import type { Rules } from "../config/settings";
import { parseBash, toPosix, toWindows } from "./bash";
import { type Checked, decide, type Mode } from "./engine";
import { bashReadOnly } from "./readonly";

const cwd = "E:\\proj";
const home = "C:\\Users\\me";
const bash: Checked = {
	name: "bash",
	readOnly: false,
	permission: { command: (i) => (i as { command: string }).command },
};
const rules = (r: Partial<Record<keyof Rules, string[]>> = {}): Rules => ({
	allow: (r.allow ?? []).map((text) => ({ text, base: cwd })),
	ask: (r.ask ?? []).map((text) => ({ text, base: cwd })),
	deny: (r.deny ?? []).map((text) => ({ text, base: cwd })),
});
const run = (command: string, r = rules(), mode: Mode = "manual") =>
	decide(bash, { command }, { rules: r, session: [], cwd, home, mode });
const behavior = async (command: string, r?: Rules, mode?: Mode) =>
	(await run(command, r, mode)).behavior;

test("3.5 parser: every separator splits; quotes come off; wrappers are stripped", async () => {
	const p = await parseBash(
		`git log --oneline | head -5 && echo 'a b' "c" ; ls\nwc -l x || true & pwd`,
	);
	expect(p.errors).toEqual([]);
	expect(p.commands.map((c) => [c.name, ...c.args])).toEqual([
		["git", "log", "--oneline"],
		["head", "-5"],
		["echo", "a b", "c"],
		["ls"],
		["wc", "-l", "x"],
		["true"],
		["pwd"],
	]);
	const w = await parseBash(
		"NODE_ENV=test timeout -s KILL 30 nice npm test > /dev/null",
	);
	expect(w.commands.map((c) => [c.name, ...c.args, c.plain])).toEqual([
		["npm", "test", true],
	]);
	expect(w.redirections).toEqual(["/dev/null"]);
	expect((await parseBash("FOO=1 npm test")).commands[0].plain).toBe(false);
	for (const [c, why] of [
		["echo $(rm x)", "Contains command substitution"],
		["echo `rm x`", "Contains command substitution"],
		["cat <(ls)", "Contains process substitution"],
		["(cd x && rm y)", "Contains subshell"],
		["echo $HOME", "Contains simple expansion"],
		["f() { rm x; }", "Contains function definition"],
	])
		expect([c, (await parseBash(c)).tooComplex]).toEqual([c, why]);
	expect((await parseBash("npm test &&")).errors.length).toBeGreaterThan(0);
});

test("paths: C:\\x ↔ /c/x, as Claude Code converts them", () => {
	expect(toPosix("E:\\Experiments\\manas")).toBe("/e/Experiments/manas");
	expect(toWindows("/e/Experiments/manas")).toBe("E:\\Experiments\\manas");
	expect(toWindows("/cygdrive/c/x")).toBe("C:\\x");
	expect(toWindows("/c")).toBe("C:\\");
	expect(toWindows("src/a.ts")).toBe("src\\a.ts");
});

test("read-only: Claude's lists and flag tables; an unknown flag asks", async () => {
	for (const c of [
		"ls -la",
		"cat a.txt | wc -l",
		"git log --oneline -5",
		"git status --short",
		"git diff --stat HEAD~1",
		"grep -rn foo src",
		"rg -C3 foo",
		"find . -name '*.ts'",
		"sed -n 1,20p a.txt",
		"git branch -a",
		"cd src",
		"pwd",
		"node --version",
	])
		expect([c, await behavior(c)]).toEqual([c, "allow"]);
	for (const c of [
		"git log --output=x",
		"git branch new-one",
		"sed -i s/a/b/ a.txt",
		"find . -delete",
		"rm x",
		"npm test",
		"pwd -P x",
		"curl https://x",
	])
		expect([c, await behavior(c)]).toEqual([c, "ask"]);
	expect(bashReadOnly("git", ["log", "--frobnicate"])).toBe(false);
	expect(bashReadOnly("tree", ["-L", "2"])).toBe(true);
});

test("always asks: too complex, special variables, UNC, cd + git, exec wrappers, redirects", async () => {
	const allowAll = rules({
		allow: [
			"Bash(echo *)",
			"Bash(git *)",
			"Bash(ls *)",
			"Bash(find *)",
			"Bash(watch *)",
		],
	});
	for (const [c, reason] of [
		[
			"echo $(whoami)",
			"Contains command substitution, which can't be checked before it runs",
		],
		["PATH=/x ls", "Command sets the special shell variable PATH"],
		["ls //server/share", "contains a UNC path"],
		["cd sub && git status", "Compound commands with cd and git"],
		["watch ls", "watch runs code"],
		["find . -exec rm {} ;", "find with -exec"],
		["echo hi > out.txt", "file redirections"],
		["ls .env", "secret file"],
		["npm test &&", "Could not parse"],
	]) {
		const d = await run(c, allowAll);
		expect([c, d.behavior]).toEqual([c, "ask"]);
		expect([c, d.reason]).toEqual([c, expect.stringContaining(reason)]);
		if (d.behavior === "ask") expect(d.suggestions).toEqual([]);
	}
	expect(await behavior("echo hi > /dev/null")).toBe("allow");
	expect(await behavior("ls", rules({ deny: ["Bash(ls *)"] }))).toBe("deny");
});

test("rules: wrappers stripped, each part on its own; suggestions are Bash(...)", async () => {
	const npm = rules({ allow: ["Bash(npm test *)"] });
	expect(await behavior("timeout 30 npm test", npm)).toBe("allow");
	expect(await behavior("NODE_ENV=ci npm test -- --watch", npm)).toBe("allow");
	expect(await behavior("FOO=1 npm test", npm)).toBe("ask");
	expect(await behavior("npm test && rm x", npm)).toBe("ask");
	expect(await run("npm run build")).toMatchObject({
		behavior: "ask",
		suggestions: [{ rules: ["Bash(npm run *)"], destination: "project" }],
	});
});

test("lowkey: Claude's seven file commands, plain paths in the project only", async () => {
	for (const c of [
		"mkdir -p src/x",
		"touch a.txt",
		"rm -rf build",
		"mv a b",
		"cp a.txt /e/proj/b.txt",
		"sed -i s/a/b/ a.txt",
	])
		expect([c, await behavior(c, undefined, "acceptEdits")]).toEqual([
			c,
			"allow",
		]);
	for (const c of [
		"rm ~/x",
		"rm /c/Windows/x",
		"rm *.js",
		"rm .git/config",
		"cd sub; rm x",
		"chmod +x a",
	])
		expect([c, await behavior(c, undefined, "acceptEdits")]).toEqual([
			c,
			"ask",
		]);
	expect(await behavior("mkdir x")).toBe("ask");
});
