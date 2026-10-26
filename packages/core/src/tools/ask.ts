import Type, { type Static } from "typebox";
import { defineTool, Stopped } from "./registry";

// ask_user (tools.md §5): Claude Code's AskUserQuestion, with its inputs,
// description and result text. The front end shows the questions (user/ask)
// and waits as long as it takes; with no front end that can answer, the
// host leaves the tool out.
// ponytail: no per-question notes or "ask me more questions" (Claude Code
// has both); add with the Ink screen (M10) if they're missed.

const Option = Type.Object(
	{
		label: Type.String({
			description:
				"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
		}),
		description: Type.String({
			description:
				"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
		}),
		preview: Type.Union([Type.String(), Type.Null()], {
			description:
				"Optional preview content shown under this option, for concrete artifacts the user needs to compare (see the tool description). null for none.",
		}),
	},
	{ additionalProperties: false },
);
const Question = Type.Object(
	{
		question: Type.String({
			description:
				'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
		}),
		header: Type.String({
			description:
				'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
		}),
		options: Type.Array(Option, {
			minItems: 2,
			maxItems: 4,
			description:
				"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
		}),
		multiSelect: Type.Boolean({
			description:
				"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
		}),
	},
	{ additionalProperties: false },
);
export type Questions = Static<typeof Question>[];
// Question text → the chosen labels, or what the user typed.
export type Answers = Record<string, string[]>;

const MAX_HEADER = 12;

export const askUser = defineTool({
	name: "ask_user",
	description: `Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.

Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is shown as plain monospace text under its option. Multi-line text with newlines is supported. Do not use previews for simple preference questions where labels and descriptions suffice.

Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.`,
	schema: Type.Object(
		{
			questions: Type.Array(Question, {
				minItems: 1,
				maxItems: 4,
				description: "Questions to ask the user (1-4 questions)",
			}),
		},
		{ additionalProperties: false },
	),
	deferred: false,
	// Asking is the user's own say: the engine never prompts for it.
	readOnly: true,
	title: ({ questions }) => `ask: ${questions[0].question}`,
	validate: async ({ questions }) => {
		const texts = questions.map((q) => q.question);
		if (new Set(texts).size !== texts.length)
			return "Question texts must be unique, option labels must be unique within each question";
		for (const q of questions) {
			const labels = q.options.map((o) => o.label);
			if (new Set(labels).size !== labels.length)
				return "Question texts must be unique, option labels must be unique within each question";
			if (q.header.length > MAX_HEADER)
				return `header "${q.header}" is longer than ${MAX_HEADER} characters`;
		}
		return undefined;
	},
	run: async ({ questions }, ctx) => {
		if (!ctx.ask) throw new Error("no one can answer questions here");
		const answers = await ctx.ask(questions, ctx.callId ?? "");
		if (!answers) throw new Stopped("the user declined to answer");
		return answered(questions, answers);
	},
});

// Claude Code's result text: one `"question"="answer"` per question.
export function answered(questions: Questions, answers: Answers) {
	const esc = (s: string) =>
		s
			.replace(/[\s\u0085]+/g, " ")
			.trim()
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"');
	const given = (q: Questions[number]) =>
		(answers[q.question] ?? []).filter((a) => a.trim());
	if (questions.every((q) => given(q).length === 0))
		return "The user did not answer the questions.";
	const list = questions
		.map((q) => {
			const a = given(q);
			return a.length > 0
				? `"${esc(q.question)}"="${esc(a.join(", "))}"`
				: `"${esc(q.question)}"=(no option selected)`;
		})
		.join(", ");
	// Every answer is one of the options: plain. Anything typed: read it.
	const picked = questions.every((q) => {
		const labels = new Set(q.options.map((o) => o.label));
		const a = given(q);
		return a.every((x) => labels.has(x)) && (q.multiSelect || a.length <= 1);
	});
	return picked
		? `Your questions have been answered: ${list}. You can now continue with these answers in mind.`
		: `The user answered: ${list}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
}
