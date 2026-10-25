import { parseArgs } from "node:util";
import { version } from "../package.json";
import { streamText } from "./provider/openai";

try {
	const { values, positionals } = parseArgs({
		options: {
			version: { type: "boolean" },
			model: { type: "string" },
			effort: { type: "string" },
		},
		allowPositionals: true,
		strict: true,
	});

	if (values.version) {
		console.log(`manas ${version}`);
	} else if (positionals.length > 0) {
		for await (const text of streamText(positionals.join(" "), values)) {
			process.stdout.write(text);
		}
		process.stdout.write("\n");
	} else {
		console.log(
			'usage: manas [--model <m>] [--effort <level>] "<prompt>" | manas --version',
		);
	}
} catch (err) {
	console.error(`manas: ${(err as Error).message}`);
	process.exit(1);
}
