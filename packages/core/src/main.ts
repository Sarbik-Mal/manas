import { parseArgs } from "node:util";
import { version } from "../package.json";
import { streamText } from "./provider/openai";

try {
	const { values, positionals } = parseArgs({
		options: { version: { type: "boolean" } },
		allowPositionals: true,
		strict: true,
	});

	if (values.version) {
		console.log(`manas ${version}`);
	} else if (positionals.length > 0) {
		for await (const text of streamText(positionals.join(" "))) {
			process.stdout.write(text);
		}
		process.stdout.write("\n");
	} else {
		console.log('usage: manas "<prompt>" | manas --version');
	}
} catch (err) {
	console.error(`manas: ${(err as Error).message}`);
	process.exit(1);
}
