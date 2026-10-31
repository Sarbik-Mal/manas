import { debugLog } from "../log/debug";

// Cache monitoring (4.1), as in Claude Code: a break is a cache read under 95%
// of the previous request's and at least 2,000 tokens lower. The cause comes
// from what changed since that request. Debug log only, metadata only.
const DROP = 0.95;
const MIN_DROP = 2000;
// ponytail: OpenAI keeps a prompt about 5-10 min idle (up to 1 h); this is one
// guess at 5. Fix when evals show real expiry times.
const IDLE_MS = 5 * 60_000;
// The user chose these (a notice or a rewind), so they are not a warning.
const EXPECTED = new Set([
	"model_changed",
	"effort_changed",
	"history_shortened",
]);

type Hash = number | bigint;
type Request = {
	model: string;
	effort?: string;
	verbosity?: string;
	instructions?: string;
	tools: { name: string }[];
	input: unknown[];
};
type Seen = {
	at: number;
	cached: number;
	model: string;
	effort?: string;
	verbosity?: string;
	instructions: Hash;
	tools: Hash;
	names: string[];
	// ponytail: every item is hashed again on each request (cheap next to the
	// request); hash only the new ones once compaction (4.2) keeps a stable base.
	items: Hash[];
};

export type CacheMonitor = ReturnType<typeof cacheMonitor>;

// One per conversation: each model and conversation has its own cache.
// ponytail: a resumed session starts with no baseline, and a model with a
// small prompt is not skipped (Claude Code skips haiku).
export function cacheMonitor(now = Date.now) {
	let prev: Seen | undefined;
	// A round without usage (aborted, failed) leaves the baseline as it was.
	return (req: Request, usage?: { input: number; cached: number }) => {
		if (!usage) return;
		const cur: Seen = {
			at: now(),
			cached: usage.cached,
			model: req.model,
			effort: req.effort,
			verbosity: req.verbosity,
			instructions: Bun.hash(req.instructions ?? ""),
			tools: Bun.hash(JSON.stringify(req.tools)),
			names: req.tools.map((t) => t.name),
			items: req.input.map((i) => Bun.hash(JSON.stringify(i))),
		};
		const p = prev;
		prev = cur;
		if (!p || cur.cached >= p.cached * DROP || p.cached - cur.cached < MIN_DROP)
			return;

		const causes: string[] = [];
		if (cur.model !== p.model) causes.push("model_changed");
		if (cur.effort !== p.effort) causes.push("effort_changed");
		if (cur.verbosity !== p.verbosity) causes.push("verbosity_changed");
		if (cur.instructions !== p.instructions)
			causes.push("instructions_changed");
		if (cur.tools !== p.tools) causes.push("tools_changed");
		let firstChanged: number | undefined;
		if (cur.items.length < p.items.length) causes.push("history_shortened");
		else {
			const i = p.items.findIndex((h, n) => h !== cur.items[n]);
			if (i >= 0) {
				causes.push("history_rewritten");
				firstChanged = i;
			}
		}
		const idleMs = cur.at - p.at;
		if (causes.length === 0)
			causes.push(idleMs > IDLE_MS ? "idle_over_5min" : "unexplained");
		const tools = causes.includes("tools_changed");
		const expected = causes.every((c) => EXPECTED.has(c));
		debugLog({
			kind: "cache",
			level: expected ? "info" : "warn",
			expected,
			model: cur.model,
			from: p.cached,
			to: cur.cached,
			input: usage.input,
			causes,
			idleMs,
			firstChanged,
			toolsAdded: tools
				? cur.names.filter((n) => !p.names.includes(n)).length
				: undefined,
			toolsRemoved: tools
				? p.names.filter((n) => !cur.names.includes(n)).length
				: undefined,
		});
	};
}
