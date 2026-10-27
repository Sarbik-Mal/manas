import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import Type from "typebox";
import { call, fakeOpenAI, say, tempRoot } from "../../testing/fake-openai";
import { coreTools } from "../../tools";
import { defineTool } from "../../tools/registry";
import { runCli, sessionsText } from "./cli";
import { historyFile } from "./prompt-history";

const style = { unicode: true, color: false };

const fake = fakeOpenAI();
afterAll(fake.stop);
beforeEach(fake.reset);
const { replies, bodies } = fake;

// The CLI on fake streams: `type` sends raw key presses, as a terminal would.
function startCli({
	firstPrompt,
	root = tempRoot(),
	resume,
	tools,
	cwd = "E:\\x",
	mode,
}: {
	mode?: string;
	firstPrompt?: string;
	root?: string;
	cwd?: string;
	resume?: Parameters<typeof runCli>[0]["resume"];
	tools?: Parameters<typeof runCli>[0]["tools"];
} = {}) {
	const input = new PassThrough();
	const output = new PassThrough();
	let out = "";
	output.on("data", (c) => {
		out += c.toString();
	});
	const exited = runCli({
		input,
		output,
		cwd,
		firstPrompt,
		style: { unicode: true, color: false },
		root,
		resume,
		tools,
		mode,
	});
	const waitFor = async (pred: () => boolean) => {
		for (let i = 0; i < 400 && !pred(); i++) await Bun.sleep(5);
		expect(pred()).toBe(true);
	};
	const shows = (text: string) => waitFor(() => out.includes(text));
	// Waits for the prompt to come back before typing, like a person would.
	let prompts = 0;
	const type = async (keys: string) => {
		await waitFor(() => out.split("> ").length - 1 > prompts);
		prompts = out.split("> ").length - 1;
		input.write(keys);
	};
	const userTexts = (i: number) =>
		bodies[i].input.flatMap((m) =>
			"role" in m && m.role === "user" ? [m.content] : [],
		);
	return { input, out: () => out, type, shows, waitFor, exited, userTexts };
}

test("a chat: two prompts share one history, then /exit", async () => {
	const cli = startCli();
	replies.push(say("one"), say("two"));
	await cli.shows("manas ");
	await cli.type("hi\r");
	await cli.shows("one");
	await cli.type("again\r");
	await cli.shows("two");
	expect(cli.userTexts(1)).toEqual(["hi", "again"]);
	await cli.type("/exit\r");
	expect(await cli.exited).toBe(0);
});

test("a first prompt from the command line runs right away", async () => {
	replies.push(say("hello"));
	const cli = startCli({ firstPrompt: "start here" });
	await cli.shows("hello");
	expect(cli.userTexts(0)).toEqual(["start here"]);
	await cli.type("/exit\r");
	await cli.exited;
});

test("`\\` + Enter continues the prompt on a new line", async () => {
	const cli = startCli();
	replies.push(say("ok"));
	await cli.type("line one\\\r");
	cli.input.write("line two\r");
	await cli.shows("ok");
	expect(cli.userTexts(0)).toEqual(["line one\nline two"]);
	await cli.type("/exit\r");
	await cli.exited;
});

test("an unknown command is never sent to the model", async () => {
	const cli = startCli();
	await cli.type("/plan\r");
	await cli.shows("Unknown command /plan. Type /help.");
	expect(bodies).toHaveLength(0);
	await cli.type("/exit\r");
	await cli.exited;
});

test("/effort before a reply is silent; /model after one warns and applies", async () => {
	const cli = startCli();
	replies.push(say("one"), say("two"));
	await cli.type("/effort high\r");
	await cli.type("hi\r");
	await cli.shows("one");
	expect(cli.out()).not.toContain("Heads up");
	expect(bodies[0].reasoning).toEqual({ effort: "high" });
	await cli.type("/model gpt-4o-mini\r");
	await cli.shows("Changing the model makes it start fresh");
	await cli.type("again\r");
	await cli.shows("two");
	expect(bodies[1].model).toBe("gpt-4o-mini");
	await cli.type("/model nope\r");
	await cli.shows('unknown model "nope"');
	await cli.type("/exit\r");
	await cli.exited;
});

test("/clear starts a new conversation", async () => {
	const cli = startCli();
	replies.push(say("noted"), say("no idea"));
	await cli.type("remember 42\r");
	await cli.shows("noted");
	await cli.type("/clear\r");
	await cli.shows("New conversation.");
	// The screen is emptied by scrolling, so the old chat stays in the scrollback.
	expect(cli.out()).toContain(`${"\n".repeat(24)}\x1b[H`);
	await cli.type("what number?\r");
	await cli.shows("no idea");
	expect(cli.userTexts(1)).toEqual(["what number?"]);
	await cli.type("/exit\r");
	await cli.exited;
});

test("Esc stops a reply, keeps it, and the prompt comes back", async () => {
	const cli = startCli();
	replies.push({ text: "44\n45\n", hold: true }, say("next"));
	await cli.type("write a lot\r");
	await cli.shows("45");
	cli.input.write("\x1b");
	await cli.shows("⎿ Interrupted");
	expect(cli.out()).toContain("45\n  ⎿ Interrupted");
	await cli.type("go on\r");
	await cli.shows("next");
	await cli.type("/exit\r");
	await cli.exited;
});

test("Ctrl+C twice quits; Ctrl+D quits", async () => {
	const a = startCli();
	await a.type("\x03");
	await a.shows("Press Ctrl+C again to exit");
	a.input.write("\x03");
	expect(await a.exited).toBe(0);

	const b = startCli();
	await b.type("\x04");
	expect(await b.exited).toBe(0);
});

// One saved session per prompt in `root`, oldest first.
async function saved(root: string, ...prompts: string[]) {
	for (const p of prompts) {
		const cli = startCli({ root });
		replies.push(say(`ok: ${p}`));
		await cli.type(`${p}\r`);
		await cli.shows(`ok: ${p}`);
		await cli.type("/exit\r");
		await cli.exited;
		await Bun.sleep(20); // distinct modified times
	}
}

test("-c resumes the latest session: replay, then the old history goes out", async () => {
	const root = tempRoot();
	await saved(root, "remember 42");
	const cli = startCli({ root, resume: "latest" });
	await cli.shows("> remember 42\nok: remember 42");
	replies.push(say("it was 42!"));
	await cli.type("what number?\r");
	await cli.shows("it was 42!");
	expect(cli.userTexts(bodies.length - 1)).toEqual([
		"remember 42",
		"what number?",
	]);
	await cli.type("/exit\r");
	await cli.exited;
});

test("-c with no sessions, or an unknown id, exits 1 with a message", async () => {
	const a = startCli({ resume: "latest" });
	expect(await a.exited).toBe(1);
	expect(a.out()).toContain("No session to continue in this folder.");
	const b = startCli({ resume: { id: "nope" } });
	expect(await b.exited).toBe(1);
	expect(b.out()).toContain("No session found with id nope");
});

test("the picker: newest first; a number resumes, Enter starts fresh", async () => {
	const root = tempRoot();
	await saved(root, "first", "second");
	const a = startCli({ root, resume: "pick" });
	await a.shows("1. second");
	expect(a.out()).toContain("2. first");
	await a.shows("Pick a number");
	a.input.write("2\r");
	await a.shows("> first\nok: first");
	await a.type("/exit\r");
	await a.exited;

	const b = startCli({ root, resume: "pick" });
	await b.shows("Pick a number");
	b.input.write("\r");
	await b.shows("manas ");
	expect(b.out()).not.toContain("ok: ");
	await b.type("/exit\r");
	await b.exited;
});

test("/resume switches to a saved session", async () => {
	const root = tempRoot();
	await saved(root, "old chat");
	const cli = startCli({ root });
	await cli.type("/resume\r");
	await cli.shows("Pick a number");
	cli.input.write("1\r");
	await cli.shows("> old chat\nok: old chat");
	await cli.type("/exit\r");
	await cli.exited;
});

test("manas sessions lists this folder's sessions with their ids", async () => {
	const root = tempRoot();
	expect(sessionsText("E:\\x", style, root)).toBe(
		"No sessions in this folder yet.",
	);
	await saved(root, "hello there");
	expect(sessionsText("E:\\x", style, root)).toMatch(
		/^[\w-]+ · just now · 2 messages · hello there$/,
	);
});

// A shell that only echoes, so approvals are tested without running anything.
const powershell = defineTool({
	name: "powershell",
	description: "ps",
	schema: Type.Object(
		{ command: Type.String() },
		{ additionalProperties: false },
	),
	deferred: false,
	readOnly: false,
	permission: { command: (i) => i.command },
	run: async ({ command }) => `ran: ${command}`,
});
const ps = (command: string) => ({
	items: [call("powershell", { command })],
});
const outputs = () =>
	bodies.flatMap((b) =>
		b.input.flatMap((i) =>
			i.type === "function_call_output" ? [i.output as string] : [],
		),
	);

test("approval prompt: Yes runs it; read-only commands never ask", async () => {
	const cli = startCli({ tools: [powershell] });
	replies.push(
		ps("Get-ChildItem"),
		say("listed"),
		ps("Remove-Item x"),
		say("done"),
	);
	await cli.type("list\r");
	await cli.shows("listed");
	expect(cli.out()).not.toContain("Manas wants to");
	await cli.type("delete x\r");
	await cli.shows("Manas wants to run: Remove-Item x");
	expect(cli.out()).toContain("  1. Yes\n");
	expect(cli.out()).toContain(
		"  2. Yes, and don't ask again for PowerShell(Remove-Item *) in this project\n  3. No",
	);
	await cli.shows("Choose 1-3: ");
	cli.input.write("1\r");
	await cli.shows("done");
	expect(cli.out()).toContain("⎿ ok · ran: Remove-Item x");
	await cli.type("/exit\r");
	await cli.exited;
});

test("approval prompt: 2 remembers (for the session when it can't be saved); 3 asks for a reason", async () => {
	const cli = startCli({ tools: [powershell] });
	replies.push(
		ps("Remove-Item a"),
		say("one"),
		ps("Remove-Item b"),
		say("two"),
		ps("git push"),
		say("three"),
	);
	await cli.type("a\r");
	await cli.shows("Choose 1-3: ");
	cli.input.write("2\r");
	await cli.shows("one");
	await cli.type("b\r");
	await cli.shows("two");
	expect(cli.out().split("Manas wants to")).toHaveLength(2);

	await cli.type("push\r");
	await cli.shows("Manas wants to run: git push");
	await cli.waitFor(() => cli.out().split("Choose 1-3: ").length === 3);
	cli.input.write("3\r");
	await cli.shows("Tell Manas what to do instead");
	cli.input.write("open a PR instead\r");
	await cli.shows("three");
	expect(outputs()).toContain("error: denied by the user: open a PR instead");
	await cli.type("/exit\r");
	await cli.exited;
});

test("approval prompt: Esc is a plain No, which stops the turn", async () => {
	const cli = startCli({ tools: [powershell] });
	replies.push(ps("Remove-Item x"));
	await cli.type("delete x\r");
	await cli.shows("Choose 1-3: ");
	cli.input.write("\x1b");
	await cli.shows("⎿ Interrupted");
	expect(outputs()).toEqual([]);
	expect(bodies).toHaveLength(1);
	await cli.type("/exit\r");
	await cli.exited;
});

test("prompt history survives a restart, encrypted on disk", async () => {
	const root = tempRoot();
	const a = startCli({ root });
	replies.push(say("first"), say("again"));
	await a.type("remember token-xyz-123\r");
	await a.shows("first");
	await a.type("/exit\r");
	await a.exited;
	const file = historyFile("E:\\x", root);
	expect(readFileSync(file).toString("latin1")).not.toContain("token-xyz-123");

	const b = startCli({ root });
	await b.type("\x1b[A\x1b[A\r"); // ↑ ↑: past /exit to the prompt
	await b.shows("again");
	expect(b.userTexts(bodies.length - 1)).toEqual(["remember token-xyz-123"]);
	await b.type("/exit\r");
	await b.exited;
});

test("/rewind: pick a prompt, see the change, restore code and conversation", async () => {
	const project = tempRoot();
	const file = join(project, "a.ts");
	writeFileSync(file, "let x = 1;\n");
	const cli = startCli({ cwd: project, tools: coreTools() });
	replies.push(
		{ items: [call("read", { file_path: "a.ts", offset: null, limit: null })] },
		{
			items: [
				call("edit", {
					file_path: "a.ts",
					old_string: "x = 1",
					new_string: "x = 2",
					replace_all: null,
				}),
			],
		},
		say("changed"),
	);
	await cli.type("bump x\r");
	await cli.shows("Choose 1-3: ");
	cli.input.write("1\r"); // approve the edit
	await cli.shows("changed");
	expect(readFileSync(file, "utf8")).toBe("let x = 2;\n");

	await cli.type("/rewind\r");
	await cli.shows("1. bump x");
	cli.input.write("1\r");
	await cli.shows("a.ts +1 -1");
	await cli.shows("4. Never mind");
	cli.input.write("1\r"); // code and conversation
	await cli.shows("Conversation rewound. Restored 1 file.");
	expect(readFileSync(file, "utf8")).toBe("let x = 1;\n");
	// The prompt is back in the input, ready to edit or send again.
	await cli.waitFor(() => cli.out().endsWith("bump x"));
	cli.input.write("\x15/exit\r");
	await cli.exited;
});

// --- 2.7: modes ---

test("modes: Shift+Tab and /mode switch, the prompt shows lowkey, option 2 on an edit turns it on", async () => {
	const project = tempRoot();
	const cli = startCli({ cwd: project, tools: coreTools() });
	await cli.shows("· vibe-check ·");
	await cli.type("\x1b[Z");
	await cli.shows("lowkey on: edits in this project run without asking");
	await cli.shows("lowkey > ");
	await cli.type("/mode\r");
	await cli.shows("Mode: lowkey (choices: vibe-check, lowkey)");
	await cli.type("/mode plan\r");
	await cli.shows("scheming (plan) comes in 6.4");
	await cli.type("/mode vibe-check\r");
	await cli.shows("vibe-check on: asks before edits");

	replies.push(
		{ items: [call("write", { file_path: "a.ts", content: "x\n" })] },
		say("made a"),
		{ items: [call("write", { file_path: "b.ts", content: "y\n" })] },
		say("made b"),
	);
	await cli.type("make a\r");
	await cli.shows("  2. Yes, and switch to lowkey for this session\n  3. No");
	await cli.shows("Choose 1-3: ");
	cli.input.write("2\r");
	await cli.shows("made a");
	await cli.type("make b\r");
	await cli.shows("made b");
	expect(cli.out().split("Manas wants to")).toHaveLength(2);
	expect(readFileSync(join(project, "b.ts"), "utf8")).toBe("y\n");
	expect(cli.out().split("lowkey on:")).toHaveLength(3);
	await cli.type("/exit\r");
	await cli.exited;
});

test("--mode sets the starting mode; a bad one stops the CLI", async () => {
	const a = startCli({ mode: "lowkey" });
	await a.shows("· lowkey ·");
	await a.shows("lowkey > ");
	await a.type("/exit\r");
	await a.exited;
	const b = startCli({ mode: "ghost" });
	expect(await b.exited).toBe(1);
	expect(b.out()).toContain("ghost (dontAsk) comes in 8.7");
});

// --- 2.8: ask_user ---

test("the 2.8 check: questions show as a menu and wait; numbers, several, typed text", async () => {
	const cli = startCli({ tools: coreTools() });
	const option = (
		label: string,
		description = "",
		preview: string | null = null,
	) => ({
		label,
		description,
		preview,
	});
	replies.push(
		{
			items: [
				call("ask_user", {
					questions: [
						{
							question: "Which layout?",
							header: "Layout",
							options: [
								option(
									"Sidebar (Recommended)",
									"nav on the left",
									"[nav] | main",
								),
								option("Top bar", "nav on top"),
							],
							multiSelect: false,
						},
						{
							question: "Which pages?",
							header: "Pages",
							options: [option("Home"), option("About"), option("Blog")],
							multiSelect: true,
						},
						{
							question: "Name?",
							header: "Name",
							options: [option("Acme"), option("Zen")],
							multiSelect: false,
						},
					],
				}),
			],
		},
		say("built it"),
	);
	await cli.type("make a site\r");
	await cli.shows("⏺ ask_user(Which layout?)");
	await cli.shows(
		"Manas asks (Layout): Which layout?\n  1. Sidebar (Recommended): nav on the left\n       [nav] | main\n  2. Top bar: nav on top\n  3. Type something else",
	);
	await cli.shows("Choose 1-3: ");
	await Bun.sleep(50);
	expect(cli.out()).not.toContain("built it"); // it waits
	cli.input.write("2\r");
	await cli.shows("Choose 1-4 (several: 1,3): ");
	cli.input.write("9\r"); // out of range: asked again
	await cli.waitFor(
		() => cli.out().split("Choose 1-4 (several: 1,3): ").length === 3,
	);
	cli.input.write("1, 3\r");
	await cli.shows("Manas asks (Name): Name?");
	await cli.shows("Choose 1-3: ");
	await Bun.sleep(20);
	cli.input.write("3\r");
	await cli.shows("Your answer: ");
	cli.input.write("Bolt\r");
	await cli.shows("built it");
	expect(outputs()[0]).toBe(
		'The user answered: "Which layout?"="Top bar", "Which pages?"="Home, Blog", "Name?"="Bolt". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
	);
	await cli.type("/exit\r");
	await cli.exited;
});

test("Esc on a question declines it, which stops the turn", async () => {
	const cli = startCli({ tools: coreTools() });
	replies.push({
		items: [
			call("ask_user", {
				questions: [
					{
						question: "Which color?",
						header: "Color",
						options: [
							{ label: "Blue", description: "", preview: null },
							{ label: "Red", description: "", preview: null },
						],
						multiSelect: false,
					},
				],
			}),
		],
	});
	await cli.type("pick\r");
	await cli.shows("Choose 1-3: ");
	cli.input.write("\x1b");
	await cli.shows("⎿ Interrupted");
	expect(cli.out()).toContain("the user declined to answer");
	expect(bodies).toHaveLength(1);
	await cli.type("/exit\r");
	await cli.exited;
});

test("Ctrl+B moves a running command to the background; /tasks lists and stops it (3.3)", async () => {
	const cli = startCli({ tools: coreTools(), cwd: tempRoot() });
	replies.push(
		{
			items: [
				call("powershell", {
					command: "ping -n 30 127.0.0.1",
					description: "Ping a lot",
					timeout: null,
					run_in_background: null,
				}),
			],
		},
		say("it runs on"),
		say("noted the stop"),
	);
	await cli.type("ping\r");
	await cli.shows("Choose 1-3: ");
	cli.input.write("1\r");
	await Bun.sleep(1500);
	cli.input.write("\x02");
	await cli.shows("it runs on");
	expect(outputs().at(-1)).toStartWith(
		"Command was manually backgrounded by user with ID: b",
	);
	await cli.type("/tasks\r");
	await cli.shows("1. Ping a lot");
	await cli.shows("Stop which?");
	cli.input.write("1\r");
	await cli.shows("Successfully stopped task: b");
	await cli.shows('⎿ Background command "Ping a lot" was stopped');
	await cli.shows("noted the stop");
	await cli.type("/exit\r");
	await cli.exited;
}, 30_000);
