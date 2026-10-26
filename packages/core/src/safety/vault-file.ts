import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { protect, unprotect } from "../platform/win/dpapi";
import { Vault } from "./scrub";

// A session's vault on disk (architecture.md §10): DPAPI-encrypted, tied to
// this Windows user. A copied file can't be read on another PC or account.

// `expired`: the file existed but couldn't be read (Windows reinstalled, the
// password reset by an admin). The old placeholders are gone; a fresh vault
// takes over.
export function openVault(file: string): { vault: Vault; expired: boolean } {
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch {
		return { vault: watch(new Vault(), file), expired: false };
	}
	try {
		const json = new TextDecoder().decode(unprotect(bytes));
		return {
			vault: watch(Vault.fromJSON(JSON.parse(json)), file),
			expired: false,
		};
	} catch {
		return { vault: watch(new Vault(), file), expired: true };
	}
}

// Saved on every new secret: written to a temp file, then renamed, so a crash
// never leaves half a vault.
function watch(vault: Vault, file: string) {
	vault.onNew = () => saveVault(vault, file);
	return vault;
}

export function saveVault(vault: Vault, file: string) {
	mkdirSync(dirname(file), { recursive: true });
	const data = protect(new TextEncoder().encode(JSON.stringify(vault)));
	writeFileSync(`${file}.tmp`, data);
	renameSync(`${file}.tmp`, file);
}
