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

// `  ⎿ ok · first line` under the tool row; errors in red.
export function toolFinished(status: string, output: string, st: Style) {
	const s = sym(st);
	const first = cut(output.split("\n")[0].trim(), 80, st);
	if (status === "ok") return dim(`  ${s.result} ok ${s.dot} ${first}`, st);
	if (status === "interrupted") return dim(`  ${s.result} interrupted`, st);
	return red(`  ${s.result} ${first}`, st);
}

export const interrupted = (st: Style) =>
	dim(`  ${sym(st).result} Interrupted`, st);

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
