// Risk test 0.10 (build-order.md): parse time per command with the long-running parser,
// next to starting a new PowerShell per command. Run: bun packages/core/scripts/risk/ps-parse.ts
import { parsePowerShell } from "../../src/permissions/powershell";

const commands = [
	"Get-ChildItem -Recurse -Filter *.ts | Select-Object -First 10",
	"git status; git diff --stat",
	"npm test -- --watch=false",
	"Get-Content .\\log.txt -Tail 50 | Where-Object { $_ -match 'error' }",
	"Remove-Item -Recurse -Force .\\dist; New-Item -ItemType Directory dist",
	"Write-Output $(Get-Date) > out.txt",
	"[IO.File]::ReadAllText('a.json') | ConvertFrom-Json",
];

const ms = (t: number) => `${(performance.now() - t).toFixed(1)} ms`;

let t = performance.now();
const spawn = Bun.spawnSync([
	"powershell.exe",
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	"[System.Management.Automation.Language.Parser]::ParseInput('Get-Item x', [ref]$null, [ref]$null) | Out-Null",
]);
console.log(`one-shot spawn + parse:   ${ms(t)} (exit ${spawn.exitCode})`);

t = performance.now();
await parsePowerShell("Get-Date");
console.log(`long-running startup:     ${ms(t)} (paid once)`);

const times: number[] = [];
for (let i = 0; i < 500; i++) {
	const s = performance.now();
	await parsePowerShell(commands[i % commands.length]);
	times.push(performance.now() - s);
}
times.sort((a, b) => a - b);
const at = (q: number) => times[Math.floor(q * (times.length - 1))].toFixed(2);
console.log(
	`per command (500 runs):   p50 ${at(0.5)} ms   p95 ${at(0.95)} ms   max ${at(1)} ms`,
);
