import { parseArgs } from "node:util";
import { version } from "../package.json";
import { enableDebugLog } from "./log/debug";
import { runTurn } from "./loop/turn";
import { rgPath } from "./platform/win/bin";
import { protect, unprotect } from "./platform/win/dpapi";

try {
	const { values, positionals } = parseArgs({
		options: {
			version: { type: "boolean" },
			model: { type: "string" },
			effort: { type: "string" },
			debug: { type: "boolean" },
		},
		allowPositionals: true,
		strict: true,
	});

	if (values.debug) enableDebugLog();

	if (values.version) {
		console.log(`manas ${version}`);
	} else if (positionals.length === 1 && positionals[0] === "doctor") {
		await doctor();
	} else if (positionals.length > 0) {
		for await (const e of runTurn([], positionals.join(" "), values)) {
			if (e.type === "text") process.stdout.write(e.delta);
		}
		process.stdout.write("\n");
	} else {
		console.log(
			'usage: manas [--model <m>] [--effort <level>] "<prompt>" | manas doctor | manas --version',
		);
	}
} catch (err) {
	console.error(`manas: ${(err as Error).message}`);
	process.exit(1);
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
