import { parseArgs } from "node:util";
import { version } from "../package.json";

let values: { version?: boolean };
try {
	({ values } = parseArgs({
		options: { version: { type: "boolean" } },
		strict: true,
	}));
} catch (err) {
	console.error(`manas: ${(err as Error).message}`);
	process.exit(1);
}

if (values.version) {
	console.log(`manas ${version}`);
} else {
	console.log("manas: nothing here yet (chat arrives in milestone 0.2)");
}
