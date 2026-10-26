import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../testing/fake-openai";
import { envFiles, envValues, preloadEnv } from "./env-preload";
import { scrub, Vault } from "./scrub";
import { openVault } from "./vault-file";

const KEY = `sk-${"k".repeat(30)}`;

test("the vault file: saved on each new secret, encrypted, read back", () => {
	const file = join(tempRoot(), "s", "vault.bin");
	const { vault, expired } = openVault(file);
	expect(expired).toBe(false);
	scrub(`key ${KEY}`, vault);
	const bytes = readFileSync(file);
	expect(bytes.toString("latin1")).not.toContain(KEY);
	const again = openVault(file);
	expect(again.vault.restore("[REDACTED:api_key#1]").text).toBe(KEY);
	// The next new secret is numbered on from the saved count.
	expect(scrub(`sk-${"z".repeat(30)}`, again.vault).text).toBe(
		"[REDACTED:api_key#2]",
	);
});

test("a vault that can't be decrypted starts fresh, marked expired", () => {
	const file = join(tempRoot(), "vault.bin");
	writeFileSync(file, "not a DPAPI blob");
	const { vault, expired } = openVault(file);
	expect(expired).toBe(true);
	expect(vault.size).toBe(0);
});

test(".env files: the whole project, ignored ones too; examples and node_modules skipped", async () => {
	const cwd = tempRoot();
	const put = (rel: string, text: string) => {
		mkdirSync(join(cwd, rel, ".."), { recursive: true });
		writeFileSync(join(cwd, rel), text);
	};
	put(".gitignore", ".env*\n");
	put(".env", 'DB_PASSWORD="hunter2hunter2"\nPORT=3000\n');
	put(
		"packages/api/.env.local",
		"export API_URL=https://db.internal:5432 # prod\n",
	);
	put(".env.example", "DB_PASSWORD=changeme-example\n");
	put("node_modules/x/.env", "LEAK=from-node-modules\n");
	const found = (await envFiles(cwd)).map((f) =>
		f.slice(cwd.length + 1).replaceAll("\\", "/"),
	);
	expect(found.sort()).toEqual([".env", "packages/api/.env.local"]);

	const vault = new Vault();
	await preloadEnv(cwd, vault);
	// rg lists files in no fixed order, so the numbers may swap.
	expect(
		scrub("connect https://db.internal:5432 with hunter2hunter2 on 3000", vault)
			.text,
	).toMatch(/^connect \[REDACTED:env#\d\] with \[REDACTED:env#\d\] on 3000$/);
	expect(vault.size).toBe(2);
});

test("envValues: quotes, export, comments", () => {
	expect(
		envValues(
			"A=1\nexport B='two words'\nC=\"x # not a comment\"\nD=y # comment\n# E=z\n\nF=",
		),
	).toEqual(["1", "two words", "x # not a comment", "y"]);
});
