// Risk test 0.9 (build-order.md): can another Windows user / PC open our DPAPI blob?
// Build: bun build packages/core/scripts/risk/dpapi.ts --compile --outfile dist/dpapi-test.exe
// Use:   dpapi-test encrypt blob.bin   (here)
//        dpapi-test decrypt blob.bin   (here: prints the text; in Windows Sandbox: must fail)
import { protect, unprotect } from "../../src/platform/win/dpapi";

const [mode, file] = process.argv.slice(2);
try {
	if (mode === "encrypt" && file) {
		await Bun.write(file, protect(new TextEncoder().encode("manas secret ok")));
		console.log(`encrypted → ${file}`);
	} else if (mode === "decrypt" && file) {
		const blob = await Bun.file(file).bytes();
		console.log(`decrypted: ${new TextDecoder().decode(unprotect(blob))}`);
	} else {
		console.log("usage: dpapi-test encrypt|decrypt <file>");
	}
} catch (err) {
	console.log((err as Error).message);
	process.exit(1);
}
