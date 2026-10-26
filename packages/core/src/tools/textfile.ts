import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// File rules for read, edit and write (tools.md §1): each file keeps its line
// endings and encoding byte for byte; long paths and locked files work or
// fail clearly.

export type Encoding = "utf8" | "utf8bom" | "utf16le" | "utf16be";
export type Eol = "\n" | "\r\n";
export type Text = { text: string; encoding: Encoding; eol: Eol };

// Windows' old limit is 260 characters (248 for a folder); `\\?\` goes past
// it. Bun 1.4 handled a 401-character path without it on a PC with
// LongPathsEnabled (checked in 2.4); the prefix is for PCs where it doesn't.
export const io = (path: string) =>
	path.length >= 248 && /^[a-z]:\\/i.test(path) ? `\\\\?\\${path}` : path;

const RETRIES = 5;
const WAIT_MS = 200;

// Antivirus and OneDrive hold files for a moment, so a few retries first;
// then a message a person can act on instead of a raw EBUSY.
export async function retry<T>(shown: string, fn: () => T): Promise<T> {
	for (let i = 0; ; i++) {
		try {
			return fn();
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw err;
			if (i < RETRIES) {
				await Bun.sleep(WAIT_MS);
				continue;
			}
			throw new Error(
				code === "EBUSY"
					? `${shown} is locked by another program (maybe open in Excel or an editor). Close it and try again.`
					: `Windows refused access to ${shown}: it may be read-only, open in another program, or need admin rights.`,
			);
		}
	}
}

export const readBytes = (path: string, shown: string) =>
	retry(shown, () => readFileSync(io(path)));

export const statOf = (path: string) =>
	statSync(io(path), { throwIfNoEntry: false });

// CRLF if more lines end in it than in LF alone; a tie (or no line breaks)
// is LF, as in Claude Code.
export function eolOf(text: string): Eol {
	const crlf = text.split("\r\n").length - 1;
	const lf = text.split("\n").length - 1 - crlf;
	return crlf > lf ? "\r\n" : "\n";
}

export const withEol = (s: string, eol: Eol) => s.replace(/\r?\n/g, eol);

// The text and how it's stored, or why it can't be changed safely. The BOM
// decides first (UTF-16 has NUL bytes); then a NUL means binary.
// ponytail: legacy code pages (Windows-1252) and UTF-16 without a BOM are
// refused; detect and keep them if such files turn up often.
export function decodeText(b: Uint8Array): Text | string {
	const strict = (label: string, bytes: Uint8Array) =>
		new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
	let encoding: Encoding = "utf8";
	let text: string;
	try {
		if (b[0] === 0xff && b[1] === 0xfe) {
			encoding = "utf16le";
			text = strict("utf-16le", b.subarray(2));
		} else if (b[0] === 0xfe && b[1] === 0xff) {
			encoding = "utf16be";
			text = strict("utf-16be", b.subarray(2));
		} else {
			const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
			if (bom) encoding = "utf8bom";
			const body = bom ? b.subarray(3) : b;
			if (body.includes(0)) return "is binary";
			text = strict("utf-8", body);
		}
	} catch {
		return encoding === "utf8" || encoding === "utf8bom"
			? "isn't valid UTF-8 (it may be in another encoding, such as Windows-1252)"
			: "isn't valid UTF-16";
	}
	return { text, encoding, eol: eolOf(text) };
}

export function encodeText(
	text: string,
	encoding: Encoding,
): Buffer<ArrayBuffer> {
	if (encoding === "utf8") return Buffer.from(text, "utf8");
	if (encoding === "utf8bom")
		return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
	const body = Buffer.from(text, "utf16le");
	if (encoding === "utf16le")
		return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
	return Buffer.concat([Buffer.from([0xfe, 0xff]), body.swap16()]);
}

// Missing folders are made. The size is checked after, as Claude Code does:
// a network drive or cloud sync can cut a write short without an error.
// Returns the new modified time.
export async function writeVerified(
	path: string,
	bytes: Buffer,
	shown: string,
) {
	mkdirSync(io(dirname(path)), { recursive: true });
	await retry(shown, () => writeFileSync(io(path), bytes));
	const info = statSync(io(path));
	if (info.size !== bytes.length) {
		throw new Error(
			`Write verification failed: ${shown} is ${info.size} bytes on disk, expected ${bytes.length}. The filesystem may have cut the write short (network drive or cloud sync).`,
		);
	}
	return info.mtimeMs;
}
