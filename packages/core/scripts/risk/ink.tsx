// Risk test 0.11 (build-order.md): does Ink work in Windows terminals?
// Build: bun packages/core/scripts/risk/build-ink.ts → dist/ink-test.exe
// Shows everything the full screen (milestone 10) needs; the user checks it in each terminal.
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";

// Old conhost (not Windows Terminal, not VS Code): its fonts lack braille and ❯.
const LEGACY = !process.env.WT_SESSION && process.env.TERM_PROGRAM !== "vscode";

const WORDS =
	"Manas is reading the project. It found twelve TypeScript files and one failing test in src/cart.ts, where the discount is applied after tax instead of before. This line is long on purpose, so it has to wrap neatly at the edge of the window, and it should reflow when you resize the window.".split(
		" ",
	);
const SPIN = LEGACY
	? ["|", "/", "-", "\\"]
	: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MARKER = LEGACY ? "> " : "❯ ";
const DONE = LEGACY ? "*" : "✓";
const OPTIONS = ["Allow once", "Allow and remember", "Deny"];

function App() {
	const { exit } = useApp();
	const { columns } = useWindowSize();
	const [phase, setPhase] = useState<"streaming" | "menu" | "done">(
		"streaming",
	);
	const [shown, setShown] = useState(0);
	const [interrupted, setInterrupted] = useState(false);
	const [tick, setTick] = useState(0);
	const [choice, setChoice] = useState(0);
	const [lastKey, setLastKey] = useState("none yet");

	// Status line: ~10 updates a second until done.
	useEffect(() => {
		if (phase === "done") return;
		const t = setInterval(() => setTick((x) => x + 1), 100);
		return () => clearInterval(t);
	}, [phase]);

	// Streaming: one word every 80 ms.
	useEffect(() => {
		if (phase !== "streaming") return;
		if (shown >= WORDS.length) return setPhase("menu");
		const t = setTimeout(() => setShown((s) => s + 1), 80);
		return () => clearTimeout(t);
	}, [phase, shown]);

	useEffect(() => {
		if (phase === "done") setTimeout(exit, 500);
	}, [phase, exit]);

	useInput((input, key) => {
		const name =
			(key.escape && "Esc") ||
			(key.upArrow && "↑") ||
			(key.downArrow && "↓") ||
			(key.return && "Enter") ||
			JSON.stringify(input);
		setLastKey(name);
		if (phase === "streaming" && key.escape) {
			setInterrupted(true);
			setPhase("menu");
		} else if (phase === "menu") {
			if (key.upArrow)
				setChoice((c) => (c + OPTIONS.length - 1) % OPTIONS.length);
			if (key.downArrow) setChoice((c) => (c + 1) % OPTIONS.length);
			if (key.return) setPhase("done");
		}
	});

	return (
		// Never draw in the last column: Windows terminals wrap there, which makes
		// Ink erase too few lines on redraw (left-behind copies).
		<Box flexDirection="column" width={Math.max(columns - 1, 20)}>
			<Box
				borderStyle="round"
				borderColor="cyan"
				paddingX={1}
				justifyContent="space-between"
			>
				<Text bold>1. manas ink test</Text>
				<Text color="magenta">vibe-check</Text>
			</Box>
			<Text>
				2. {WORDS.slice(0, shown).join(" ")}
				{interrupted && <Text color="yellow"> [7. interrupted by Esc]</Text>}
			</Text>
			<Text dimColor>
				3. {phase === "streaming" ? SPIN[tick % SPIN.length] : DONE} {shown * 7}{" "}
				tokens · {(tick / 10).toFixed(1)}s · Esc interrupts
			</Text>
			<Box borderStyle="single" paddingX={1} alignSelf="flex-start">
				<Text>4. ✓ ✗ → ─│ 🚀 日本語 মানস</Text>
			</Box>
			<Text color="red">5. - const total = price * qty;</Text>
			<Text color="green">5. + const total = price * qty - discount;</Text>
			{phase !== "streaming" && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>6. Edit src/cart.ts? (↑/↓, Enter)</Text>
					{OPTIONS.map((o, i) => (
						<Text key={o} color={i === choice ? "cyan" : undefined}>
							{i === choice ? MARKER : "  "}
							{o}
						</Text>
					))}
				</Box>
			)}
			{phase === "done" && (
				<Text color="green">Picked: {OPTIONS[choice]}. 9. Exiting…</Text>
			)}
			<Text dimColor>
				last key: {lastKey} · {columns} cols{LEGACY ? " · legacy console" : ""}{" "}
				· 8. resize the window any time
			</Text>
		</Box>
	);
}

if (!process.stdin.isTTY) {
	console.log("ink-test: not an interactive terminal, nothing to show");
} else {
	const app = render(<App />);
	// On resize the terminal re-wraps lines already printed (some pushed into
	// scrollback), so Ink erases too few and old frames stay behind. Once
	// resizing stops: clear screen + scrollback, then make Ink redraw from scratch.
	let settle: Timer | undefined;
	process.stdout.on("resize", () => {
		clearTimeout(settle);
		settle = setTimeout(() => {
			process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
			app.clear();
			app.rerender(<App />);
		}, 100);
	});
	await app.waitUntilExit();
}
process.exit(0);
