// How protocol events look on the plain text screen. Pure functions, so the
// screen's look is tested without a terminal.

export type Style = { unicode: boolean; color: boolean };

// The old console's fonts lack these symbols (0.11 rule 2): ASCII there.
export function detectStyle(env: Record<string, string | undefined>): Style {
	return {
		unicode: Boolean(env.WT_SESSION) || env.TERM_PROGRAM === "vscode",
		color: !env.NO_COLOR,
	};
}

const paint = (code: number) => (s: string, st: Style) =>
	st.color ? `\x1b[${code}m${s}\x1b[0m` : s;
export const dim = paint(2);
export const red = paint(31);
export const yellow = paint(33);
const green = paint(32);

const sym = (st: Style) =>
	st.unicode
		? { tool: "⏺", result: "⎿", dot: "·", more: "…" }
		: { tool: "*", result: ">", dot: "-", more: "..." };

export const cut = (s: string, n: number, st: Style) =>
	s.length > n ? `${s.slice(0, n)}${sym(st).more}` : s;

// `⏺ read(src/app.ts)`: the first string field of the input, else short JSON.
export function toolStarted(name: string, input: unknown, st: Style) {
	const first =
		input && typeof input === "object"
			? Object.values(input).find((v) => typeof v === "string")
			: undefined;
	const summary = first ?? (input === undefined ? "" : JSON.stringify(input));
	return dim(`${sym(st).tool} ${name}(${cut(summary, 60, st)})`, st);
}

// What a search or read found, as Claude Code shows it ("Found 8 files",
// "Read 3 lines"); undefined when there's nothing to count (an empty result,
// the "unchanged" stub, another tool).
function summary(name: string, input: unknown, output: string) {
	const rows = output.split("\n");
	const results = rows.filter((l) => l && !l.startsWith("(") && l !== "--");
	const n = (count: number, what: string) =>
		`${count} ${what}${count === 1 ? "" : "s"}`;
	if (name === "read") {
		const lines = rows.filter((l) => /^\s*\d+\t/.test(l)).length;
		return lines > 0 ? `Read ${n(lines, "line")}` : undefined;
	}
	if (/^No (files|matches) found/.test(output)) return undefined;
	if (name === "glob") return `Found ${n(results.length, "file")}`;
	if (name === "grep") {
		const mode = (input as { output_mode?: string } | undefined)?.output_mode;
		return mode === "content"
			? `Found ${n(results.length, "line")}`
			: `Found ${n(results.length, "file")}`;
	}
	return undefined;
}

// `  ⎿ ok · first line` under the tool row (a count for searches and reads);
// errors in red.
export function toolFinished(
	status: string,
	output: string,
	st: Style,
	tool?: { name: string; input: unknown },
) {
	const s = sym(st);
	const found =
		status === "ok" && tool
			? summary(tool.name, tool.input, output)
			: undefined;
	const first = found ?? cut(output.split("\n")[0].trim(), 80, st);
	if (status === "ok") return dim(`  ${s.result} ok ${s.dot} ${first}`, st);
	if (status === "interrupted") return dim(`  ${s.result} interrupted`, st);
	return red(`  ${s.result} ${first}`, st);
}

export const interrupted = (st: Style) =>
	dim(`  ${sym(st).result} Interrupted`, st);

// An approval's diff: `-` rows red, `+` rows green, the rest dim.
export const diff = (text: string, st: Style) =>
	text
		.split("\n")
		.map((l) =>
			l.startsWith("- ")
				? red(`  ${l}`, st)
				: l.startsWith("+ ")
					? green(`  ${l}`, st)
					: dim(`  ${l}`, st),
		)
		.join("\n");

export function notice(level: string, text: string, st: Style) {
	if (level === "error") return red(text, st);
	if (level === "warn") return yellow(text, st);
	return dim(text, st);
}

export function header(
	h: { version: string; model: string; effort: string | null; cwd: string },
	st: Style,
) {
	const d = ` ${sym(st).dot} `;
	const model = h.effort ? `${h.model} (${h.effort})` : h.model;
	return dim(
		`manas ${h.version}${d}${model}${d}${h.cwd}${d}Esc interrupts, /help`,
		st,
	);
}

export type Listed = {
	session_id: string;
	title: string;
	updated: string;
	messages: number;
};

export function ago(iso: string, now: number) {
	const min = Math.floor((now - Date.parse(iso)) / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min} min ago`;
	if (min < 60 * 24) return `${Math.floor(min / 60)} h ago`;
	return `${Math.floor(min / (60 * 24))} d ago`;
}

const plural = (n: number) => `${n} message${n === 1 ? "" : "s"}`;

// `3. Fix the login bug · 2 h ago · 14 messages`
export function pickerRow(n: number, s: Listed, now: number, st: Style) {
	const d = ` ${sym(st).dot} `;
	return `${n}. ${s.title}${dim(`${d}${ago(s.updated, now)}${d}${plural(s.messages)}`, st)}`;
}

// `manas sessions`: the id first, for `--resume <id>`.
export function sessionLine(s: Listed, now: number, st: Style) {
	const d = ` ${sym(st).dot} `;
	return `${s.session_id}${d}${ago(s.updated, now)}${d}${plural(s.messages)}${d}${s.title}`;
}
