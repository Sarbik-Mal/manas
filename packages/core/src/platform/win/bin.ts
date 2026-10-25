import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import rgEmbedded from "../../assets/rg.exe" with { type: "file" };

const BIN_DIR = join(
	process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
	"manas",
	"bin",
);

// Embedded files can't be run from inside the exe, so rg is copied out once.
// The name carries a hash of the bytes: a new embedded rg never reuses an old copy.
export async function rgPath(dir = BIN_DIR): Promise<string> {
	const bytes = await Bun.file(rgEmbedded).bytes();
	const target = join(dir, `rg-${Bun.hash(bytes).toString(16)}.exe`);
	if (existsSync(target)) return target;
	mkdirSync(dir, { recursive: true });
	// Write to a temp name, then rename: a crash never leaves a half-written exe.
	const tmp = `${target}.${process.pid}.tmp`;
	await Bun.write(tmp, bytes);
	try {
		renameSync(tmp, target);
	} catch (err) {
		rmSync(tmp, { force: true });
		if (!existsSync(target)) throw err; // another run won the race: fine
	}
	return target;
}
