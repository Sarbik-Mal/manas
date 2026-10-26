import { parseArgs } from "node:util";
import { version } from "../package.json";
import { doctor } from "./doctor";
import { createHost } from "./host/host";
import { enableDebugLog } from "./log/debug";
import { runCli, sessionsText } from "./ui/cli/cli";
import { detectStyle } from "./ui/cli/render";

try {
	// `--resume` alone opens the picker; parseArgs has no optional values, so a
	// bare one (last, or before another flag) is taken out first.
	const args = process.argv.slice(2);
	const at = args.indexOf("--resume");
	const pick =
		at >= 0 && (at === args.length - 1 || args[at + 1].startsWith("-"));
	if (pick) args.splice(at, 1);
	const { values, positionals } = parseArgs({
		args,
		options: {
			version: { type: "boolean" },
			model: { type: "string" },
			effort: { type: "string" },
			debug: { type: "boolean" },
			stdio: { type: "boolean" },
			continue: { type: "boolean", short: "c" },
			resume: { type: "string" },
		},
		allowPositionals: true,
		strict: true,
	});

	if (values.debug) enableDebugLog();

	if (values.version) {
		console.log(`manas ${version}`);
	} else if (values.stdio) {
		if (positionals.length > 0) throw new Error("--stdio takes no prompt");
		await stdio(values);
	} else if (positionals.length === 1 && positionals[0] === "doctor") {
		const { lines, ok } = await doctor();
		console.log(lines.join("\n"));
		if (!ok) process.exitCode = 1;
	} else if (positionals.length === 1 && positionals[0] === "sessions") {
		console.log(sessionsText(process.cwd(), detectStyle(process.env)));
	} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			"needs a terminal (use --stdio for programs; -p comes in 8.7)",
		);
	} else {
		const code = await runCli({
			input: process.stdin,
			output: process.stdout,
			cwd: process.cwd(),
			defaults: values,
			firstPrompt: positionals.join(" ") || undefined,
			style: detectStyle(process.env),
			resume: pick
				? "pick"
				: values.resume
					? { id: values.resume }
					: values.continue
						? "latest"
						: undefined,
		});
		process.exit(code);
	}
} catch (err) {
	console.error(`manas: ${(err as Error).message}`);
	process.exit(1);
}

// Protocol server for front ends (protocol.md): NDJSON over stdin/stdout.
// Nothing else may write to stdout here. Closing stdin ends the session.
async function stdio(defaults: { model?: string; effort?: string }) {
	const host = createHost(
		(line) => process.stdout.write(`${line}\n`),
		defaults,
	);
	for await (const line of console) if (line.trim()) host.receive(line);
	host.close();
	process.exit(0);
}
