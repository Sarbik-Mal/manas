// Windows DPAPI: encrypts data with a key tied to the current Windows user.
// A copied blob can't be opened by another user or on another PC.
import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi";

const BLOB_ARGS = [
	FFIType.ptr, // DATA_BLOB* in
	FFIType.ptr, // description (unused)
	FFIType.ptr, // DATA_BLOB* entropy
	FFIType.ptr, // reserved
	FFIType.ptr, // prompt struct
	FFIType.u32, // flags
	FFIType.ptr, // DATA_BLOB* out
] as const;
const crypt32 = dlopen("crypt32.dll", {
	CryptProtectData: { args: [...BLOB_ARGS], returns: FFIType.i32 },
	CryptUnprotectData: { args: [...BLOB_ARGS], returns: FFIType.i32 },
});
const kernel32 = dlopen("kernel32.dll", {
	LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
	GetLastError: { args: [], returns: FFIType.u32 },
});

const UI_FORBIDDEN = 0x1; // never show a dialog
// App entropy: generic "decrypt all of this user's DPAPI blobs" tools can't open ours.
const ENTROPY = new TextEncoder().encode("manas-vault-v1");

// DPAPI rejects a null data pointer (error 87), even with length 0.
const EMPTY = new Uint8Array(1);

// DATA_BLOB on x64: u32 cbData at 0, padding, pointer pbData at 8 (16 bytes).
function dataBlob(data: Uint8Array) {
	const b = new BigUint64Array(2);
	new DataView(b.buffer).setUint32(0, data.length, true);
	b[1] = BigInt(ptr(data.length ? data : EMPTY));
	return b;
}

function call(fn: "CryptProtectData" | "CryptUnprotectData", data: Uint8Array) {
	const input = dataBlob(data);
	const entropy = dataBlob(ENTROPY);
	const out = new BigUint64Array(2);
	const ok = crypt32.symbols[fn](
		ptr(input),
		null,
		ptr(entropy),
		null,
		null,
		UI_FORBIDDEN,
		ptr(out),
	);
	if (!ok) {
		const verb = fn === "CryptProtectData" ? "encrypt" : "decrypt";
		throw new Error(
			`DPAPI ${verb} failed (code ${kernel32.symbols.GetLastError()})`,
		);
	}
	const len = new DataView(out.buffer).getUint32(0, true);
	const p = Number(out[1]) as Pointer;
	try {
		// Copy out: the buffer belongs to Windows and is freed below.
		return len
			? new Uint8Array(toArrayBuffer(p, 0, len)).slice()
			: new Uint8Array();
	} finally {
		kernel32.symbols.LocalFree(p);
	}
}

export const protect = (data: Uint8Array) => call("CryptProtectData", data);
export const unprotect = (blob: Uint8Array) => call("CryptUnprotectData", blob);
