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

test("every part of a chain, pipeline and $(...) is checked (the 3.2 check)", async () => {
	expect(await behavior("Get-Item x; Remove-Item y")).toBe("ask");
	expect(await behavior("Get-Item x | Remove-Item")).toBe("ask");
	expect(await behavior("Get-Item x; Get-ChildItem")).toBe("allow");
});

test("Claude Code's checks ask, with no rule to save, whatever specific rules allow", async () => {
	const anyRule = rules({ allow: ["PowerShell(* *)", "PowerShell(*)"] });
	for (const c of [
		"Get-Item (",
		"iex 'Get-Date'",
		"& $tool",
		"pwsh -enc AAAA",
		"powershell -Command Get-Date",
		"Start-BitsTransfer x",
		"certutil -urlcache -f http://x a",
		"Add-Type -TypeDefinition x",
		"New-Object -ComObject WScript.Shell",
		"New-Object System.Net.WebClient",
		"Invoke-Command -FilePath a.ps1",
		"Start-Job a.ps1",
		"ii a.exe",
		"schtasks /create /tn x",
		"Register-ScheduledTask x",
		"ForEach-Object Delete",
		"Start-Process x -Verb RunAs",
		"Start-Process pwsh",
		"Get-ChildItem | ForEach-Object { $_.Name }",
		"Get-ChildItem | Where-Object { $_.Length -gt 1 }",
		"Invoke-Command { Get-Date }",
		'Write-Output "$(Get-Date)"',
		'Write-Output "a $x"',
		"Get-Item @a",
		"git log --% x",
		"$x.Trim()",
		"[Environment]::UserName",
		"$env:X = 1",
		"$" + "{C:\\x.txt} = 'x'", // PowerShell's ${drive:path} variable
		"$global:y = 1",
		"Import-Module x",
		"Set-Alias ls Remove-Item",
		"Invoke-CimMethod x",
		"wmic process call create x",
		"Get-ChildItem env:",
		"Remove-Item env:X",
		"Get-Item HKLM:\\Software",
		"Get-ChildItem \\\\server\\share",
		"using namespace System",
		"cd sub; git status",
		"Get-Item x > out.txt",
		"cmdkey /list",
		"Get-Content .env",
		"Get-Content keys\\id_rsa",
	]) {
		const d = await run(c, anyRule);
		expect([c, d.behavior, "suggestions" in d && d.suggestions]).toEqual([
			c,
			"ask",
			[],
		]);
	}
	// Only a bare PowerShell rule lets them through; deny still wins.
	expect(await behavior("iex 'x'", rules({ allow: ["PowerShell"] }))).toBe(
		"allow",
	);
	expect(
		await behavior(
			"iex 'x'",
			rules({ allow: ["PowerShell"], deny: ["PowerShell(iex *)"] }),
		),
	).toBe("deny");
	// Filters and formatters may take script blocks.
	expect(await behavior("$a | Where-Object { $_.x } | Sort-Object")).toBe(
		"allow",
	);
	expect(await behavior("git status")).toBe("allow");
	expect(await behavior("cd sub")).toBe("allow");
	expect(await behavior("$x = 'a'; $x")).toBe("allow");
	expect(await behavior("Select-Object -First 5")).toBe("allow");
});

test("variables and expressions in arguments: no read-only, no allow rule", async () => {
	expect(await behavior("$p = '.env'; Get-Content $p")).toBe("ask");
	expect(await behavior("Get-Content (Get-Item x)")).toBe("ask");
	const gc = rules({ allow: ["PowerShell(Get-Content *)"] });
	expect(await behavior("Get-Content a.txt", gc)).toBe("allow");
	expect(await run("Get-Content $p", gc)).toMatchObject({
		behavior: "ask",
		suggestions: [],
	});
	expect(await run("npm test $p")).toMatchObject({
		behavior: "ask",
		reason:
			"an argument is a variable or an expression, which can't be checked ahead",
		suggestions: [],
	});
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
	// After a cd, the paths can't be checked against the starting folder.
	expect(await at("cd ..; Remove-Item a.txt")).toBe("ask");
	expect(await at("Set-Location sub; Remove-Item a.txt")).toBe("ask");
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

test("3.4: write and edit in the scratchpad run without asking, in every mode", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "manas-pad-"));
	const write = fileTool("write", false);
	const at = (path: string, r = rules(), mode: Mode = "manual") =>
		decide(
			write,
			{ path },
			{ rules: r, session: [], cwd, home, mode, scratch },
		);
	expect(await at(join(scratch, "helper.ps1"))).toMatchObject({
		behavior: "allow",
		reason: "scratchpad: a file for this session",
	});
	expect(
		(
			await decide(
				fileTool("edit", false),
				{ path: join(scratch, "a", "b.md") },
				{ rules: rules(), session: [], cwd, home, scratch },
			)
		).behavior,
	).toBe("allow");
	// Protected names still ask; deny and ask rules still win; outside, as before.
	expect((await at(join(scratch, ".git", "config"))).behavior).toBe("ask");
	expect(
		(await at(join(scratch, "x.txt"), rules({ deny: ["Write"] }))).behavior,
	).toBe("deny");
	expect(
		(await at(join(scratch, "x.txt"), rules({ ask: ["Edit"] }))).behavior,
	).toBe("ask");
	expect((await at(join(tmpdir(), "elsewhere.txt"))).behavior).toBe("ask");
	// A command writing there is checked as usual.
	expect(
		(
			await decide(
				powershell,
				{ command: `Set-Content ${join(scratch, "x.txt")} hi` },
				{ rules: rules(), session: [], cwd, home, scratch },
			)
		).behavior,
	).toBe("ask");
});
