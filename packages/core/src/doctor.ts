import { rgPath } from "./platform/win/bin";
import { protect, unprotect } from "./platform/win/dpapi";

// Checks the setup (cli.md): `manas doctor` and `/doctor`. More checks join
// as their parts are built.
export async function doctor(): Promise<{ lines: string[]; ok: boolean }> {
	const lines: string[] = [];
	let ok = true;
	try {
		const rg = Bun.spawnSync([await rgPath(), "--version"]);
		if (rg.exitCode !== 0) throw new Error(`exit ${rg.exitCode}`);
		lines.push(`rg: ${rg.stdout.toString().split("\n")[0].trim()}`);
	} catch (err) {
		lines.push(`rg: FAILED ${(err as Error).message}`);
		ok = false;
	}
	try {
		const data = new TextEncoder().encode("doctor");
		if (!unprotect(protect(data)).every((b, i) => b === data[i])) {
			throw new Error("round-trip mismatch");
		}
		lines.push("dpapi: ok");
	} catch (err) {
		lines.push(`dpapi: FAILED ${(err as Error).message}`);
		ok = false;
	}
	return { lines, ok };
}
