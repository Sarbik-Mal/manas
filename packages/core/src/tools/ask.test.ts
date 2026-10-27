import { expect, test } from "bun:test";
import { Vault } from "../safety/scrub";
import { answered, askUser, type Questions } from "./ask";
import { NO_BACKUPS } from "./backups";
import { readRecord } from "./reads";
import { buildRegistry, callTool, type ToolCtx } from "./registry";

const q = (
	question: string,
	labels: string[],
	multiSelect = false,
): Questions[number] => ({
	question,
	header: "Pick",
	options: labels.map((label) => ({ label, description: "", preview: null })),
	multiSelect,
});
const lib = q("Which library?", ["date-fns (Recommended)", "dayjs"]);
const feats = q("Which features?", ["Dark mode", "Export", "Search"], true);

test("Claude Code's result text: picked labels, typed text, unanswered", () => {
	expect(
		answered([lib, feats], {
			"Which library?": ["dayjs"],
			"Which features?": ["Dark mode", "Search"],
		}),
	).toBe(
		'Your questions have been answered: "Which library?"="dayjs", "Which features?"="Dark mode, Search". You can now continue with these answers in mind.',
	);
	expect(
		answered([lib, feats], {
			"Which library?": ['none, use "Intl"\n please'],
		}),
	).toBe(
		'The user answered: "Which library?"="none, use \\"Intl\\" please", "Which features?"=(no option selected). Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
	);
	expect(answered([lib], {})).toBe("The user did not answer the questions.");
	// Two picks on a single-select question isn't a plain pick either.
	expect(
		answered([lib], { "Which library?": ["dayjs", "date-fns (Recommended)"] }),
	).toStartWith("The user answered:");
});

const ctx = (ask?: ToolCtx["ask"]): ToolCtx => ({
	signal: new AbortController().signal,
	cwd: ".",
	shell: { cwd: "." },
	denied: () => undefined,
	reads: readRecord(),
	vault: new Vault(),
	backups: NO_BACKUPS,
	ask,
});
const call = (input: object, c: ToolCtx) =>
	callTool(
		buildRegistry([askUser] as never),
		"ask_user",
		JSON.stringify(input),
		c,
		undefined,
		"call_1",
	);

test("validate: unique questions and labels, short headers", async () => {
	const twice = await call({ questions: [lib, lib] }, ctx());
	expect(twice.output).toBe(
		"error: Question texts must be unique, option labels must be unique within each question",
	);
	const same = await call({ questions: [q("A?", ["x", "x"])] }, ctx());
	expect(same.status).toBe("error");
	const long = await call(
		{ questions: [{ ...lib, header: "Much too long here" }] },
		ctx(),
	);
	expect(long.output).toBe(
		'error: header "Much too long here" is longer than 12 characters',
	);
	const one = await call({ questions: [q("A?", ["only"])] }, ctx());
	expect(one.output).toContain("invalid input for ask_user");
});

test("the answers come back as the result; declining stops the turn", async () => {
	let seen: [Questions, string] | undefined;
	const ok = await call(
		{ questions: [lib] },
		ctx(async (questions, callId) => {
			seen = [questions, callId];
			return { "Which library?": ["dayjs"] };
		}),
	);
	expect(seen).toEqual([[lib], "call_1"]);
	expect(ok).toEqual({
		status: "ok",
		output:
			'Your questions have been answered: "Which library?"="dayjs". You can now continue with these answers in mind.',
	});
	expect(
		await call(
			{ questions: [lib] },
			ctx(async () => null),
		),
	).toEqual({
		status: "denied",
		output: "error: the user declined to answer",
		stop: true,
	});
});
