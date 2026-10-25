import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// One random id per install, used as OpenAI's prompt_cache_key.
export function installId(dir = join(homedir(), ".manas")): string {
	const file = join(dir, "install-id");
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		const id = crypto.randomUUID();
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, id);
		return id;
	}
}
