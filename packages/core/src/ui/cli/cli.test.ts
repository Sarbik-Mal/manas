import { afterAll, beforeEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { fakeOpenAI, say } from "../../testing/fake-openai";
import { runCli } from "./cli";

const fake = fakeOpenAI();
afterAll(fake.stop);
beforeEach(fake.reset);
const { replies, bodies } = fake;

// The CLI on fake streams: `type` sends raw key presses, as a terminal would.
function startCli(firstPrompt?: string) {
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
	const cli = startCli("start here");
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
