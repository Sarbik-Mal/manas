import { afterAll, expect, test } from "bun:test";
import { parsePowerShell, stopPowerShellParser } from "./powershell";

afterAll(stopPowerShellParser);
const names = async (cmd: string) =>
	(await parsePowerShell(cmd)).commands.map((c) => c.name);

test("finds every command: pipelines, chains, $(...)", async () => {
	expect(await names("Get-ChildItem | Select-Object Name")).toEqual([
		"Get-ChildItem",
		"Select-Object",
	]);
	expect(await names("Get-Item a; Remove-Item b")).toEqual([
		"Get-Item",
		"Remove-Item",
	]);
	expect(await names("Write-Output $(Remove-Item x)")).toContain("Remove-Item");
	expect(
		await names("Get-ChildItem | ForEach-Object { Remove-Item $_ }"),
	).toContain("Remove-Item");
});

test("arguments, redirections, dynamic names, .NET calls, errors", async () => {
	const r = await parsePowerShell("Get-Content a.txt -Raw > b.txt");
	expect(r.commands[0].args).toEqual(["a.txt", "-Raw"]);
	expect(r.redirections).toEqual(["b.txt"]);
	expect((await parsePowerShell('"x" > out.txt')).redirections).toEqual([
		"out.txt",
	]);
	expect(await names("& $tool -x")).toEqual([null]);
	expect((await parsePowerShell("[IO.File]::Delete('x')")).invocations).toEqual(
		["[IO.File]::Delete('x')"],
	);
	expect((await parsePowerShell("Get-Item (")).errors.length).toBeGreaterThan(
		0,
	);
});

test("what Claude Code's checks look at: plain arguments, $(), strings, splats, types, scoped assignments", async () => {
	const plain = async (cmd: string) =>
		(await parsePowerShell(cmd)).commands.map((c) => c.plain);
	expect(await plain("Select-Object -First 5")).toEqual([true]);
	expect(await plain("Remove-Item a,b -Confirm:$false")).toEqual([true]);
	expect(
		await plain("Get-ChildItem | Where-Object { $_.Length -gt 1 }"),
	).toEqual([true, true]);
	expect(await plain("Get-Content $p")).toEqual([false]);
	expect(await plain("Get-Content (Get-Item x)")).toEqual([false, true]);
	expect((await parsePowerShell("gci | ? { $_ }")).commands[1].kinds).toEqual([
		"ScriptBlock",
	]);
	const r = async (cmd: string) => await parsePowerShell(cmd);
	expect((await r('"$(Get-Date)"')).subexpressions).toBe(true);
	expect((await r('Write-Output "a $x"')).expandable).toBe(true);
	expect((await r('Write-Output "plain"')).expandable).toBe(false);
	expect((await r("Get-Item @a")).splatting).toBe(true);
	expect((await r("git log --% --x")).stopParsing).toBe(true);
	expect((await r("[Environment]::UserName")).types).toEqual(["Environment"]);
	const drive = "$" + "{C:\\x.txt}"; // PowerShell's ${drive:path} variable
	expect(
		(await r(`${drive} = 1; $env:X = 1; $x = 1`)).scopedAssignments,
	).toEqual([drive, "$env:X"]);
	expect((await r("using namespace System")).usings).toBe(true);
	expect((await r("#Requires -Version 5\nGet-Date")).requires).toBe(true);
});

test("non-ASCII and multi-line commands survive", async () => {
	const r = await parsePowerShell(
		"Get-Item 'C:\\Users\\মানস\\ファイル.txt'\nGet-Date",
	);
	expect(r.commands[0].args).toEqual(["'C:\\Users\\মানস\\ファイル.txt'"]);
	expect(r.commands[1].name).toBe("Get-Date");
});

test("restarts after the process dies", async () => {
	await parsePowerShell("Get-Date");
	stopPowerShellParser();
	expect(await names("Get-Date")).toEqual(["Get-Date"]);
});

test("100 parses average well under 50 ms", async () => {
	await parsePowerShell("Get-Date"); // startup is paid once, not per command
	const start = performance.now();
	for (let i = 0; i < 100; i++)
		await parsePowerShell(`Get-Item file${i}.txt | Remove-Item`);
	expect((performance.now() - start) / 100).toBeLessThan(50);
});

test("aliases resolve to their cmdlet and module; programs keep their name", async () => {
	const r = await parsePowerShell("dir; rm x; npm test; git status; nope-nope");
	expect(r.commands.map((c) => [c.name, c.resolved, c.module, c.type])).toEqual(
		[
			["dir", "Get-ChildItem", "Microsoft.PowerShell.Management", "Alias"],
			["rm", "Remove-Item", "Microsoft.PowerShell.Management", "Alias"],
			["npm", "npm", expect.any(String), expect.any(String)],
			["git", "git", expect.any(String), "Application"],
			["nope-nope", "nope-nope", null, "NotFound"],
		],
	);
});
