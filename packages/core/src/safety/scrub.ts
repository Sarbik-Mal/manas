// Secret scrubbing (architecture.md §10), ported from v1's guardrails/scrub.py:
// secrets become `[REDACTED:<kind>#<n>]` before anything reaches the model.
import type { ResponseInputItem } from "openai/resources/responses/responses";

// ponytail: regex-only detection; add entropy scoring if evals show misses.

// Whole-token secrets, applied in order. Private keys go first so later
// patterns never see their bodies.
const TOKENS: [kind: string, pattern: RegExp][] = [
	[
		"private_key",
		/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/gs,
	],
	["api_key", /\bsk-[A-Za-z0-9_-]{20,}/g], // OpenAI, Anthropic
	["api_key", /\b[sr]k_live_[0-9A-Za-z]{20,}/g], // Stripe
	["api_key", /\bAKIA[0-9A-Z]{16}\b/g], // AWS access key id
	["api_key", /\bAIza[0-9A-Za-z_-]{35}/g], // Google
	["token", /\bgithub_pat_[A-Za-z0-9_]{22,}/g], // GitHub fine-grained
	["token", /\bgh[pousr]_[A-Za-z0-9]{36,}/g], // GitHub
	["token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g], // Slack
	["token", /\bnpm_[A-Za-z0-9]{36}\b/g], // npm
	["token", /\bhf_[A-Za-z0-9]{30,}/g], // Hugging Face
	["token", /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g], // JWT
	["token", /(?<=\bBearer )[A-Za-z0-9._~+/-]{16,}=*/gi],
];

// A password inside a URL (`postgresql://app:<secret>@host`): only the secret
// is replaced. No brackets in either part, so an already-redacted
// `://[REDACTED:token#1]@` isn't matched again.
const URL_PASSWORD =
	/(?<pre>\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"[\]]+:)(?<secret>[^\s@/'"[\]]+)@/gi;

// `name = value`, `name: value`, `"name": "value"`, `NAME=value`, where the name
// ends a segment with a secret word. A type annotation (`password: str = "x"`)
// is skipped; `==` is a comparison, not an assignment.
const ASSIGN =
	/(?<key>[\w.-]*?(?<kw>password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|account[_-]?key)(?:[_.-][\w.-]*)?["']?\s*(?::\s*[\w.[\]| ]+?\s*)?[:=](?!=)\s*)(?:(?<q>["'])(?<qval>[^"'\n]*)\k<q>|(?<bare>[^\s"',;#)\]}]+))/gi;

export const PLACEHOLDER = /\[REDACTED:[a-z_]+(?:#\d+)?\]/g;
const SWEEP_MIN_LENGTH = 6;
const KINDS: Record<string, string> = {
	password: "password",
	passwd: "password",
	pwd: "password",
	secret: "secret",
	token: "token",
};
const CODE_REF = /^[A-Za-z_][A-Za-z_.]*$/; // `user_input`, `self.api_key`
const NUMBER = /^\d+(?:\.\d+)?$/;

// Short or letters-only secrets ("abc", "password") aren't swept: replacing
// them everywhere would mangle code. Patterns still catch them.
export const sweepable = (secret: string) =>
	secret.length >= SWEEP_MIN_LENGTH && !/^[A-Za-z]+$/.test(secret);

// Every vault in this process, so the debug log can sweep them all.
const open = new Set<Vault>();

// Placeholder ↔ secret for one session. The same secret always gets the same
// placeholder, numbered per kind.
export class Vault {
	private bySecret = new Map<string, string>();
	private byPlaceholder = new Map<string, string>();
	private counts = new Map<string, number>();
	// Called when a new secret is added, so the vault can be saved.
	onNew?: () => void;

	constructor() {
		open.add(this);
	}

	placeholder(kind: string, secret: string) {
		let p = this.bySecret.get(secret);
		if (!p) {
			const n = (this.counts.get(kind) ?? 0) + 1;
			this.counts.set(kind, n);
			p = `[REDACTED:${kind}#${n}]`;
			this.bySecret.set(secret, p);
			this.byPlaceholder.set(p, secret);
			this.onNew?.();
		}
		return p;
	}

	// A value known in advance (from .env files): swept wherever it shows up.
	add(kind: string, secret: string) {
		if (sweepable(secret)) this.placeholder(kind, secret);
	}

	// Puts the real secrets back; also lists placeholders this vault doesn't know.
	restore(text: string) {
		const unknown: string[] = [];
		const out = text.replace(PLACEHOLDER, (p) => {
			const secret = this.byPlaceholder.get(p);
			if (secret === undefined) unknown.push(p);
			return secret ?? p;
		});
		return { text: out, unknown };
	}

	// Every copy of an already-known secret, even where no pattern would spot it.
	sweep(text: string) {
		const kinds: string[] = [];
		// Longest first: one secret can contain another.
		const secrets = [...this.bySecret.keys()].sort(
			(a, b) => b.length - a.length,
		);
		for (const secret of secrets) {
			if (!sweepable(secret) || !text.includes(secret)) continue;
			const p = this.bySecret.get(secret) as string;
			const parts = text.split(secret);
			text = parts.join(p);
			const kind = p.slice("[REDACTED:".length, p.indexOf("#"));
			for (let i = 1; i < parts.length; i++) kinds.push(kind);
		}
		return { text, kinds };
	}

	get size() {
		return this.bySecret.size;
	}

	toJSON() {
		return { secrets: [...this.bySecret], counts: [...this.counts] };
	}

	static fromJSON(json: {
		secrets: [string, string][];
		counts: [string, number][];
	}) {
		const v = new Vault();
		for (const [secret, p] of json.secrets) {
			v.bySecret.set(secret, p);
			v.byPlaceholder.set(p, secret);
		}
		v.counts = new Map(json.counts);
		return v;
	}

	// Never the values.
	toString() {
		return `Vault(${this.size} secrets)`;
	}
}

const isPlaceholderValue = (value: string) =>
	!value ||
	/^[$<{%]/.test(value) ||
	value.startsWith("[REDACTED:") ||
	value.includes("(") ||
	value.includes("[");

// `KEY=value` alone on its line (optionally `export`): a .env entry, so even a
// word-only value is a secret. `read` prefixes lines with "<n>\t".
function isEnvLine(key: string, start: number, end: number, text: string) {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const lineEnd = text.indexOf("\n", end);
	const before = text
		.slice(lineStart, start)
		.replace(/^\d+\t/, "")
		.trim();
	const after = text.slice(end, lineEnd === -1 ? text.length : lineEnd).trim();
	return (
		(before === "" || before === "export") &&
		(!after || after.startsWith("#")) &&
		key.endsWith("=") &&
		!/\s/.test(key)
	);
}

// `text` with secrets replaced, and the kind of each replacement.
export function scrub(text: string, vault = new Vault()) {
	const kinds: string[] = [];
	for (const [kind, pattern] of TOKENS) {
		text = text.replace(pattern, (m) => {
			kinds.push(kind);
			return vault.placeholder(kind, m);
		});
	}
	text = text.replace(URL_PASSWORD, (m, pre: string, secret: string) => {
		// f"://app:{pw}@", "://%s:%s@", "://u:${PW}@" are code, not secrets.
		if (isPlaceholderValue(secret)) return m;
		kinds.push("password");
		return `${pre}${vault.placeholder("password", secret)}@`;
	});
	text = text.replace(ASSIGN, (...args) => {
		const m = args[0] as string;
		const offset = args.at(-3) as number;
		const whole = args.at(-2) as string;
		const g = args.at(-1) as Record<string, string | undefined>;
		const quote = g.q ?? "";
		const value = (g.q ? g.qval : g.bare) ?? "";
		if (isPlaceholderValue(value)) return m;
		const env = isEnvLine(g.key ?? "", offset, offset + m.length, whole);
		if (!quote && (NUMBER.test(value) || (CODE_REF.test(value) && !env)))
			return m;
		const kind = KINDS[(g.kw ?? "").toLowerCase()] ?? "api_key";
		kinds.push(kind);
		return `${g.key}${quote}${vault.placeholder(kind, value)}${quote}`;
	});
	const swept = vault.sweep(text);
	return { text: swept.text, kinds: [...kinds, ...swept.kinds] };
}

// A history item with its text fields scrubbed: message content, tool call
// arguments and tool results. Reasoning items, ids and names stay as they are.
export function scrubItem(
	item: ResponseInputItem,
	vault: Vault,
): ResponseInputItem {
	const s = (t: string) => scrub(t, vault).text;
	if (item.type === "function_call") {
		return { ...item, arguments: s(item.arguments) };
	}
	if (item.type === "function_call_output") {
		return typeof item.output === "string"
			? { ...item, output: s(item.output) }
			: item;
	}
	if ("role" in item && "content" in item) {
		const content = item.content;
		if (typeof content === "string")
			return { ...item, content: s(content) } as ResponseInputItem;
		if (Array.isArray(content)) {
			return {
				...item,
				content: content.map((part) =>
					"text" in part && typeof part.text === "string"
						? { ...part, text: s(part.text) }
						: part,
				),
			} as ResponseInputItem;
		}
	}
	return item;
}

// Real values back into streamed text for the user's screen. A chunk ending in
// a half-finished placeholder is held until the rest arrives.
const PARTIAL =
	/\[(?:R(?:E(?:D(?:A(?:C(?:T(?:E(?:D(?::[a-z_]*(?:#\d*)?)?)?)?)?)?)?)?)?)?$/;
export function restoreStream(vault: Vault) {
	let held = "";
	return {
		push(chunk: string) {
			const text = held + chunk;
			const cut = text.search(PARTIAL);
			held = cut === -1 ? "" : text.slice(cut);
			return vault.restore(cut === -1 ? text : text.slice(0, cut)).text;
		},
		flush() {
			const rest = vault.restore(held).text;
			held = "";
			return rest;
		},
	};
}

// For the debug log: the patterns, plus every secret any open vault knows.
// Real values back into every string inside `value` (tool inputs on screen).
export function restoreDeep(value: unknown, vault: Vault): unknown {
	if (typeof value === "string") return vault.restore(value).text;
	if (Array.isArray(value)) return value.map((v) => restoreDeep(v, vault));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, restoreDeep(v, vault)]),
		);
	}
	return value;
}

// Longest first across all vaults, so one vault's short secret can't cut into
// another's longer one.
export function scrubForLog(text: string) {
	let out = scrub(text).text;
	const known = [...open].flatMap((v) => v.toJSON().secrets);
	known.sort(([a], [b]) => b.length - a.length);
	for (const [secret, p] of known) {
		if (sweepable(secret)) out = out.split(secret).join(p);
	}
	return out;
}
