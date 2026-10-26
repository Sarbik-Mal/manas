import { parseArgs } from "node:util";
import { version } from "../package.json";
import { createHost } from "./host/host";
import { enableDebugLog } from "./log/debug";
import { runTurn } from "./loop/turn";
import { rgPath } from "./platform/win/bin";
import { protect, unprotect } from "./platform/win/dpapi";
import { buildRegistry } from "./tools/registry";

try {
	const { values, positionals } = parseArgs({
		options: {
			version: { type: "boolean" },
			model: { type: "string" },
			effort: { type: "string" },
			debug: { type: "boolean" },
			stdio: { type: "boolean" },
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
		await doctor();
	} else if (positionals.length > 0) {
		const registry = buildRegistry([]);
		for await (const e of runTurn([], positionals.join(" "), {
			...values,
			registry,
		})) {
			if (e.type === "text") process.stdout.write(e.delta);
			if (e.type === "turn_finished" && e.error) throw new Error(e.error);
		}
		process.stdout.write("\n");
	} else {
		console.log(
			'usage: manas [--model <m>] [--effort <level>] "<prompt>" | manas --stdio | manas doctor | manas --version',
		);
	}
} catch (err) {
	console.error(`manas: ${(err as Error).message}`);
	process.exit(1);
}

// Protocol server for front ends (protocol.md): NDJSON over stdin/stdout.
// Nothing else may write to stdout here. Closing stdin ends the session.
async function stdio(defaults: { model?: string; effort?: string }) {
	const host = createHost(
		(line) =>
			process.stdout.write(`${line}
`),
		defaults,
	);
	for await (const line of console) if (line.trim()) host.receive(line);
	host.close();
	process.exit(0);
}

// Checks the setup (cli.md). More checks join as their parts are built.
async function doctor() {
	try {
		const rg = Bun.spawnSync([await rgPath(), "--version"]);
		if (rg.exitCode !== 0) throw new Error(`exit ${rg.exitCode}`);
		console.log(`rg: ${rg.stdout.toString().split("\n")[0].trim()}`);
	} catch (err) {
		console.log(`rg: FAILED ${(err as Error).message}`);
		process.exitCode = 1;
	}
	try {
		const data = new TextEncoder().encode("doctor");
		if (!unprotect(protect(data)).every((b, i) => b === data[i])) {
			throw new Error("round-trip mismatch");
		}
		console.log("dpapi: ok");
	} catch (err) {
		console.log(`dpapi: FAILED ${(err as Error).message}`);
		process.exitCode = 1;
	}
}
