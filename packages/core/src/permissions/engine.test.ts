import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rules } from "../config/settings";
import { type Checked, decide, type Mode, parseMode } from "./engine";

const cwd = "E:\\proj";
const home = "C:\\Users\\me";
const powershell: Checked = {
	name: "powershell",
	readOnly: false,
	permission: { command: (i) => (i as { command: string }).command },
};
const fileTool = (name: string, readOnly: boolean): Checked => ({
	name,
	readOnly,
	permission: { path: (i) => (i as { path: string }).path },
});
const rules = (
	r: Partial<Record<keyof Rules, string[]>> = {},
	base = cwd,
): Rules => ({
	allow: (r.allow ?? []).map((text) => ({ text, base })),
	ask: (r.ask ?? []).map((text) => ({ text, base })),
	deny: (r.deny ?? []).map((text) => ({ text, base })),
});
const run = (command: string, r?: Rules, session: string[] = []) =>
	decide(
		powershell,
		{ command },
		{
			rules: r ?? rules(),
			session: session.map((text) => ({ text, base: cwd })),
			cwd,
			home,
		},
	);
const behavior = async (command: string, r?: Rules) =>
	(await run(command, r)).behavior;

test("read-only commands run; anything that can change things asks (the 1.7 check)", async () => {
	for (const c of [
		"Get-ChildItem",
		"dir",
		"ls -Force",
		"git status",
		"git log --oneline -5",
		"git branch -a",
		"Get-Content a.txt | Select-String x",
		"node --version",
		"whoami",
		"Get-Content C:\\Windows\\win.ini",
	]) {
		expect([c, await behavior(c)]).toEqual([c, "allow"]);
	}
	for (const c of [
		"Remove-Item x",
		"rm -r build",
		"Get-ChildItem; Remove-Item y",
		"Get-Item x > out.txt",
		'iex "Get-Date"',
		"Get-ChildItem env:",
		"Get-Content $env:USERPROFILE\\x",
		"Get-Content .env",
		"Get-Content keys\\id_rsa",
		"Get-ChildItem \\\\server\\share",
		"& $tool",
		"[IO.File]::Delete('x')",
		"Get-ChildItem (",
		"git push",
		"git branch new-feature",
		"git diff --output=x.txt",
		"Invoke-WebRequest https://x.test",
		"npm test",
	]) {
		expect([c, await behavior(c)]).toEqual([c, "ask"]);
	}
});

test("deny > ask > allow; allow rules cover a part, read-only covers the rest", async () => {
	expect(
		await run("Remove-Item x", rules({ deny: ["PowerShell(Remove-Item *)"] })),
	).toMatchObject({
		behavior: "deny",
		reason: "denied by your settings (PowerShell(Remove-Item *))",
	});
	// The alias as typed matches too.
	expect(
		await behavior("rm x", rules({ deny: ["PowerShell(Remove-Item *)"] })),
	).toBe("deny");
	expect(
		await behavior(
			"Get-ChildItem; rm x",
			rules({ deny: ["PowerShell(rm *)"] }),
		),
	).toBe("deny");
	expect(
		await behavior("git status", rules({ ask: ["PowerShell(git *)"] })),
	).toBe("ask");
	const npm = rules({ allow: ["PowerShell(npm test *)"] });
	expect(await behavior("npm test", npm)).toBe("allow");
	expect(await behavior("npm test --watch", npm)).toBe("allow");
	expect(await behavior("npm testx", npm)).toBe("ask");
	expect(await behavior("git status; npm test", npm)).toBe("allow");
	expect(await behavior("npm test; Remove-Item x", npm)).toBe("ask");
	expect(await behavior("NPM TEST", npm)).toBe("allow");
	expect(
		await behavior("Remove-Item x", rules({ allow: ["PowerShell"] })),
	).toBe("allow");
	expect(
		await behavior(
			"Remove-Item x",
			rules({ allow: ["PowerShell"], deny: ["PowerShell(Remove-Item *)"] }),
		),
	).toBe("deny");
	// A redirect asks even when every command is allowed.
	expect(await behavior("npm test > log.txt", npm)).toBe("ask");
});

test("this session's rules count like allow rules", async () => {
	expect(
		(await run("git push origin", undefined, ["PowerShell(git push *)"]))
			.behavior,
	).toBe("allow");
});

test("suggestions: one prefix per part that asked, at most 5", async () => {
	expect(
		await run("git push origin main; Remove-Item x; Get-ChildItem"),
	).toMatchObject({
		behavior: "ask",
		suggestions: [
			{
				rules: ["PowerShell(git push *)", "PowerShell(Remove-Item *)"],
				destination: "project",
			},
		],
	});
	const many = "npm a; npm b; npm c; npm d; npm e; npm f";
	expect(
		((await run(many)) as { suggestions: { rules: string[] }[] }).suggestions[0]
			.rules,
	).toHaveLength(5);
});

test("paths: gitignore-style with Claude's anchors, case-insensitive", async () => {
	const read = fileTool("read", true);
	const edit = fileTool("edit", false);
	const write = fileTool("write", false);
	const grep = fileTool("grep", true);
	const at = (tool: Checked, path: string, r: Rules) =>
		decide(tool, { path }, { rules: r, session: [], cwd, home }).then(
			(d) => d.behavior,
		);

	expect(await at(read, "src\\a.ts", rules({ deny: ["Read(src/**)"] }))).toBe(
		"deny",
	);
	expect(await at(read, "lib\\a.ts", rules({ deny: ["Read(src/**)"] }))).toBe(
		"allow",
	);
	expect(
		await at(read, "deep\\in\\here\\.env", rules({ deny: ["Read(.env)"] })),
	).toBe("deny");
	expect(await at(read, "SRC\\A.TS", rules({ deny: ["Read(src/**)"] }))).toBe(
		"deny",
	);
	expect(
		await at(read, "C:\\tools\\x.txt", rules({ deny: ["Read(//c/tools/**)"] })),
	).toBe("deny");
	expect(
		await at(
			read,
			"C:\\Users\\me\\notes\\a.md",
			rules({ deny: ["Read(~/notes/**)"] }),
		),
	).toBe("deny");
	// `/` is the rule's own settings root: ~/.manas for a user rule.
	expect(
		await at(
			read,
			"C:\\Users\\me\\.manas\\x",
			rules({ deny: ["Read(/x)"] }, `${home}\\.manas`),
		),
	).toBe("deny");
	expect(
		await at(
			read,
			"E:\\proj\\x",
			rules({ deny: ["Read(/x)"] }, `${home}\\.manas`),
		),
	).toBe("allow");
	expect(await at(read, "E:\\proj\\x", rules({ deny: ["Read(/x)"] }))).toBe(
		"deny",
	);
	// Reads outside the project are allowed, as in Claude Code.
	expect(await at(read, "D:\\elsewhere\\a.txt", rules())).toBe("allow");
	// Edit covers write; Read covers grep.
	expect(await at(write, "src\\a.ts", rules({ deny: ["Edit(src/**)"] }))).toBe(
		"deny",
	);
	expect(await at(grep, "src\\a.ts", rules({ deny: ["Read(src/**)"] }))).toBe(
		"deny",
	);
	// Editing in the project offers lowkey; outside it, a session rule for
	// the folder; an allow rule opens it.
	expect(
		await decide(
			edit,
			{ path: "src\\ui\\a.ts" },
			{ rules: rules(), session: [], cwd, home },
		),
	).toMatchObject({ behavior: "ask", suggestions: [{ mode: "acceptEdits" }] });
	expect(
		await decide(
			write,
			{ path: "D:\\other\\a.ts" },
			{ rules: rules(), session: [], cwd, home },
		),
	).toMatchObject({
		behavior: "ask",
		suggestions: [{ rules: ["Edit(//d/other/**)"], destination: "session" }],
	});
	expect(
		await at(edit, "src\\ui\\a.ts", rules({ allow: ["Edit(src/**)"] })),
	).toBe("allow");
});

test("lowkey: edits in the project run; outside, protected names and junctions out ask", async () => {
	const project = mkdtempSync(join(tmpdir(), "manas-test-"));
	const outside = mkdtempSync(join(tmpdir(), "manas-test-"));
	symlinkSync(outside, join(project, "link"), "junction");
	const edit = fileTool("edit", false);
	const ctx = (mode: Mode, r = rules()) => ({
		rules: r,
		session: [],
		cwd: project,
		home,
		mode,
	});
	const at = (path: string, mode: Mode = "acceptEdits", r = rules()) =>
		decide(edit, { path }, ctx(mode, r)).then((d) => d.behavior);
	expect(await at("src/a.ts")).toBe("allow");
	expect(await at(join(project, "new", "deep.ts"))).toBe("allow");
	expect(await at(join(outside, "a.ts"))).toBe("ask");
	expect(await at("link/a.ts")).toBe("ask");
	for (const p of [
		".git/config",
		"sub/.vscode/settings.json",
		".manas/settings.json",
		".NPMRC",
		"pkg/.mcp.json",
		".husky/pre-commit",
		".idea/x",
	]) {
		expect([p, await at(p)]).toEqual([p, "ask"]);
	}
	expect(await at("src/a.ts", "manual")).toBe("ask");
	// Deny and ask rules still win.
	expect(
		await at("src/a.ts", "acceptEdits", rules({ deny: ["Edit(src/**)"] })),
	).toBe("deny");
	expect(
		await at("src/a.ts", "acceptEdits", rules({ ask: ["Edit(src/**)"] })),
	).toBe("ask");
	// A relative path resolves from the shell's folder, not the project's.
	expect(
		(
			await decide(
				edit,
				{ path: "..\\a.ts" },
				{ ...ctx("acceptEdits"), here: join(project, "src") },
			)
		).behavior,
	).toBe("allow");
});

test("lowkey: Claude Code's four file cmdlets on plain project paths run; anything else asks", async () => {
	const project = mkdtempSync(join(tmpdir(), "manas-test-"));
	const at = (command: string, mode: Mode = "acceptEdits") =>
		decide(
			powershell,
			{ command },
			{ rules: rules(), session: [], cwd: project, home, mode },
		).then((d) => d.behavior);
	for (const c of [
		"Remove-Item a.txt",
		"rm a.txt",
		"del -Recurse -Force build",
		'Remove-Item -LiteralPath ".\\x.txt" -Force -Confirm:$false',
		"Set-Content -Path a.txt -Value x",
		"Set-Content a.txt hi",
		"Add-Content 'b c.txt' -Value x -Encoding utf8",
		"Clear-Content src\\a.txt",
		"Remove-Item a.txt,b.txt",
		`Remove-Item ${join(project, "x.txt")}`,
		"Get-ChildItem; Remove-Item a.txt",
	]) {
		expect([c, await at(c)]).toEqual([c, "allow"]);
	}
	for (const c of [
		"Remove-Item ..\\x",
		"Remove-Item .git\\x",
		"Remove-Item .",
		"Remove-Item *.txt",
		"Remove-Item $p",
		"Remove-Item ~\\x",
		"Remove-Item env:FOO",
		"Remove-Item a.txt -Bogus",
		"Remove-Item a.txt -Force:$x",
		`Set-Content a.txt "it's"`,
		"Set-Content a.txt x y",
		"Remove-Item a.txt; npm test",
		"New-Item a.txt",
		"Set-Content a.txt x > b.txt",
	]) {
		expect([c, await at(c)]).toEqual([c, "ask"]);
	}
	expect(await at("Remove-Item a.txt", "manual")).toBe("ask");
});

test("a command over 10,000 characters asks whatever the rules allow", async () => {
	const long = `Get-Date # ${"x".repeat(10_000)}`;
	expect(await behavior(long, rules({ allow: ["PowerShell"] }))).toBe("ask");
	expect(await behavior("Get-Date", rules({ allow: ["PowerShell"] }))).toBe(
		"allow",
	);
	expect(await behavior(long, rules({ deny: ["PowerShell"] }))).toBe("deny");
});

test("parseMode: plain and display names, any case; later modes refused", () => {
	expect(parseMode("lowkey")).toBe("acceptEdits");
	expect(parseMode("Vibe-Check")).toBe("manual");
	expect(parseMode("acceptedits")).toBe("acceptEdits");
	expect(() => parseMode("let-it-cook")).toThrow(
		"let-it-cook (auto) comes in 8.5",
	);
	expect(() => parseMode("x")).toThrow('unknown mode "x"');
});
