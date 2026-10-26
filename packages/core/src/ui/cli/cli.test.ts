import { afterAll, beforeEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import Type from "typebox";
import { call, fakeOpenAI, say, tempRoot } from "../../testing/fake-openai";
import { defineTool } from "../../tools/registry";
import { runCli, sessionsText } from "./cli";

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
}: {
	firstPrompt?: string;
	root?: string;
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
		cwd: "E:\\x",
		firstPrompt,
		style: { unicode: true, color: false },
		root,
		resume,
		tools,
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
	await cli.type("/rewind\r");
	await cli.shows("Unknown command /rewind. Type /help.");
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
		"  2. Yes, and don't ask again this session for PowerShell(Remove-Item *)\n  3. No",
	);
	await cli.shows("Choose 1-3: ");
	cli.input.write("1\r");
	await cli.shows("done");
	expect(cli.out()).toContain("⎿ ok · ran: Remove-Item x");
	await cli.type("/exit\r");
	await cli.exited;
});

test("approval prompt: 2 remembers for the session; 3 asks for a reason", async () => {
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
