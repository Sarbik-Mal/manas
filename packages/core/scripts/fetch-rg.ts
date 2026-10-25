// Downloads the pinned ripgrep into src/assets/rg.exe (gitignored), checking its sha256.
// Runs before build and test; skips if the file is already there.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const VERSION = "15.2.0";
const NAME = `ripgrep-${VERSION}-x86_64-pc-windows-msvc`;
const SHA256 =
	"71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5";
const URL = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${NAME}.zip`;
const OUT = join(import.meta.dir, "..", "src", "assets", "rg.exe");

if (!existsSync(OUT)) {
	const zip = new Uint8Array(await (await fetch(URL)).arrayBuffer());
	const hash = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
	if (hash !== SHA256) {
		console.error(`fetch-rg: sha256 mismatch for ${URL}\n  got ${hash}`);
		process.exit(1);
	}
	const dir = mkdtempSync(join(tmpdir(), "manas-rg-"));
	try {
		await Bun.write(join(dir, "rg.zip"), zip);
		const tar = Bun.spawnSync(["tar", "-xf", "rg.zip", `${NAME}/rg.exe`], {
			cwd: dir,
		});
		if (tar.exitCode !== 0) throw new Error(`tar: ${tar.stderr.toString()}`);
		// Temp is on another drive: copy next to OUT, then rename (no half-written rg.exe).
		mkdirSync(dirname(OUT), { recursive: true });
		copyFileSync(join(dir, NAME, "rg.exe"), `${OUT}.tmp`);
		renameSync(`${OUT}.tmp`, OUT);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(`fetch-rg: ripgrep ${VERSION} → ${OUT}`);
}
