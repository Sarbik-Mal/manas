import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../safety/scrub";
import { tempRoot } from "../testing/fake-openai";
import { NO_BACKUPS } from "./backups";
import { edit } from "./edit";
import { read } from "./files";
import { fileKey, readRecord } from "./reads";
import type { ToolCtx } from "./registry";
import {
	decodeText,
	type Encoding,
	encodeText,
	eolOf,
	io,
	writeVerified,
} from "./textfile";
import { write } from "./write";

// 2.4: every file keeps its line endings and encoding through edit and write.

function project(files: Record<string, string | Uint8Array> = {}) {
	const cwd = tempRoot();
	for (const [p, content] of Object.entries(files))
		writeFileSync(join(cwd, p), content);
	const ctx: ToolCtx = {
		signal: new AbortController().signal,
		cwd,
		shell: { cwd },
		denied: () => undefined,
		reads: readRecord(),
		vault: new Vault(),
		backups: NO_BACKUPS,
	};
	const look = (file_path: string) =>
		read.run({ file_path, offset: null, limit: null }, ctx);
	const change = async (
		file_path: string,
		old_string: string,
		new_string: string,
	) => {
		const input = { file_path, old_string, new_string, replace_all: null };
		const refused = await edit.validate?.(input, ctx);
		return refused ? `refused: ${refused}` : edit.run(input, ctx);
	};
	const replace = async (file_path: string, content: string) => {
		const input = { file_path, content };
		const refused = await write.validate?.(input, ctx);
		return refused ? `refused: ${refused}` : write.run(input, ctx);
	};
	const bytes = (p: string) => readFileSync(join(cwd, p));
	return { cwd, ctx, look, change, replace, bytes };
}

test("the 2.4 check: editing a CRLF file keeps CRLF", async () => {
	const p = project({ "a.ts": "one\r\ntwo\r\nthree\r\n" });
	await p.look("a.ts");
	expect(await p.change("a.ts", "one\ntwo", "1\n2\n2.5")).toContain(
		"updated successfully",
	);
	expect(p.bytes("a.ts").toString()).toBe("1\r\n2\r\n2.5\r\nthree\r\n");
});

test("a mixed file stays mixed: only the changed lines change", async () => {
	const p = project({ "m.ts": "a\r\nb\nc\r\nd\r\n" });
	await p.look("m.ts");
	await p.change("m.ts", "d", "D");
	expect(p.bytes("m.ts").toString()).toBe("a\r\nb\nc\r\nD\r\n");
});

test("a loose match in a CRLF file keeps its line breaks", async () => {
	const p = project({ "a.ts": "x();  \r\n\r\n\r\ny();\r\nz();\r\n" });
	await p.look("a.ts");
	expect(await p.change("a.ts", "x();\n\ny();", "w();")).toContain(
		"Matched loosely",
	);
	expect(p.bytes("a.ts").toString()).toBe("w();\r\nz();\r\n");
});

test("BOM, UTF-16 LE and BE are edited and kept", async () => {
	for (const encoding of ["utf8bom", "utf16le", "utf16be"] as Encoding[]) {
		const p = project({ "f.txt": encodeText("héllo\r\nwörld\r\n", encoding) });
		await p.look("f.txt");
		expect(await p.change("f.txt", "wörld", "wörld!")).toContain(
			"updated successfully",
		);
		expect(p.bytes("f.txt")).toEqual(
			encodeText("héllo\r\nwörld!\r\n", encoding),
		);
	}
});

test("write keeps a replaced file's line ending and encoding; a new file is LF UTF-8", async () => {
	const p = project({
		"crlf.ts": "old\r\n",
		"u16.txt": encodeText("old\n", "utf16le"),
	});
	await p.look("crlf.ts");
	await p.look("u16.txt");
	await p.replace("crlf.ts", "new\nlines\n");
	expect(p.bytes("crlf.ts").toString()).toBe("new\r\nlines\r\n");
	await p.replace("u16.txt", "nëw\n");
	expect(p.bytes("u16.txt")).toEqual(encodeText("nëw\n", "utf16le"));
	await p.replace("fresh.ts", "a\nb\n");
	expect(p.bytes("fresh.ts").toString()).toBe("a\nb\n");
});

test("decode and encode round-trip every kept encoding; others are named", () => {
	for (const encoding of [
		"utf8",
		"utf8bom",
		"utf16le",
		"utf16be",
	] as Encoding[]) {
		const bytes = encodeText("a\r\nb\r\nc\n", encoding);
		const t = decodeText(bytes);
		expect(t).toEqual({ text: "a\r\nb\r\nc\n", encoding, eol: "\r\n" });
		if (typeof t !== "string")
			expect(encodeText(t.text, t.encoding)).toEqual(bytes);
	}
	expect(decodeText(new Uint8Array([0x63, 0xe9]))).toContain("Windows-1252");
	expect(decodeText(new Uint8Array([0x61, 0]))).toBe("is binary");
	expect(eolOf("a\r\nb\n")).toBe("\n"); // a tie is LF
	expect(eolOf("no breaks")).toBe("\n");
});

test("long paths: \\\\?\\ past 248 characters; files there are read and edited", async () => {
	expect(io("C:\\short\\a.ts")).toBe("C:\\short\\a.ts");
	const deep = `C:\\${"d".repeat(250)}\\a.ts`;
	expect(io(deep)).toBe(`\\\\?\\${deep}`);
	expect(io(`\\\\server\\${"s".repeat(250)}`)).toStartWith("\\\\server");

	const p = project();
	const rel = join("x".repeat(120), "y".repeat(120), "long.ts");
	expect(join(p.cwd, rel).length).toBeGreaterThan(260);
	expect(await p.replace(rel, "let v = 1;\n")).toContain(
		"created successfully",
	);
	expect(fileKey(join(p.cwd, rel))).toBe(join(p.cwd, rel).toLowerCase());
	expect(await p.change(rel, "1", "2")).toContain("updated successfully");
	expect(p.bytes(rel).toString()).toBe("let v = 2;\n");
});

test("a locked file: retried, then a clear message", async () => {
	const p = project({ "locked.ts": "a\n" });
	const file = join(p.cwd, "locked.ts");
	// PowerShell holds the file open with no sharing for 2 s.
	const ps = Bun.spawn(
		[
			"powershell",
			"-NoProfile",
			"-Command",
			`$f = [IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); Write-Output held; Start-Sleep 2; $f.Close()`,
		],
		{ stdout: "pipe" },
	);
	await ps.stdout.getReader().read(); // "held"
	const started = Date.now();
	await expect(
		writeVerified(file, Buffer.from("b\n"), "locked.ts"),
	).rejects.toThrow(
		"locked.ts is locked by another program (maybe open in Excel or an editor). Close it and try again.",
	);
	expect(Date.now() - started).toBeGreaterThanOrEqual(900); // the retries
	await ps.exited;
	// Once it's released, the same write works.
	await writeVerified(file, Buffer.from("b\n"), "locked.ts");
	expect(readFileSync(file, "utf8")).toBe("b\n");
}, 15_000);
