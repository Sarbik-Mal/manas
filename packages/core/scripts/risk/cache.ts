// Risk test 0.7 (build-order.md): does prompt caching hit with our request shape?
// Live, run by hand from the repo root: bun packages/core/scripts/risk/cache.ts
// Shape: fixed tools → fixed instructions → append-only input, store: false,
// streaming, prompt_cache_key (as in src/provider/openai.ts).
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";
import { installId } from "../../src/storage/install-id";

const client = new OpenAI();
const MODEL = "gpt-5.6-luna";

// A unique nonce at the very start of the prefix keeps scenarios from warming each other.
function tools(nonce: string, firstDescription = "Reads a file.") {
	return Array.from({ length: 12 }, (_, i) => ({
		type: "function" as const,
		name: `tool_${i}`,
		description: i === 0 ? `[${nonce}] ${firstDescription}` : `Tool ${i}.`,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path." },
				limit: { type: ["integer", "null"], description: "Max lines." },
			},
			required: ["path", "limit"],
			additionalProperties: false,
		},
	}));
}

const instructions = Array.from(
	{ length: 200 },
	(_, i) =>
		`Rule ${i}: for task kind ${i}, read before editing, prefer small edits, and reply briefly.`,
).join("\n");

async function send(
	label: string,
	toolList: ReturnType<typeof tools>,
	input: ResponseInputItem[],
	effort: ReasoningEffort = "none",
) {
	const stream = await client.responses.create({
		model: MODEL,
		tools: toolList,
		tool_choice: "none",
		instructions,
		input,
		stream: true,
		store: false,
		prompt_cache_key: installId(),
		reasoning: { effort },
		max_output_tokens: 300,
	});
	let text = "";
	for await (const e of stream) {
		if (e.type === "response.output_text.delta") text += e.delta;
		if (e.type === "response.completed") {
			const u = e.response.usage;
			const cached = u?.input_tokens_details.cached_tokens ?? 0;
			const total = u?.input_tokens ?? 0;
			const pct = total ? Math.round((cached / total) * 100) : 0;
			console.log(
				`${label.padEnd(34)} input ${String(total).padStart(5)}  cached ${String(cached).padStart(5)}  ${pct}%`,
			);
		}
	}
	return text;
}

const user = (text: string): ResponseInputItem => ({
	role: "user",
	content: text,
});
const assistant = (text: string): ResponseInputItem => ({
	role: "assistant",
	content: text,
});
const nonce = () => crypto.randomUUID();

console.log("1+2. append-only conversation (expect: 2nd and 3rd hit)");
{
	const t = tools(nonce());
	const h: ResponseInputItem[] = [user("Name one prime number.")];
	h.push(assistant(await send("  A first request", t, h)));
	h.push(user("Name another one."));
	h.push(assistant(await send("  B same prefix + new turn", t, h)));
	h.push(user("And one more."));
	await send("  C same prefix + another turn", t, h);
}

console.log("3. effort change on the same prefix, with a same-effort control");
for (const [first, second] of [
	["low", "high"],
	["low", "low"],
] as const) {
	const t = tools(nonce());
	const h: ResponseInputItem[] = [user("Name one prime number.")];
	h.push(assistant(await send(`  effort ${first}`, t, h, first)));
	h.push(user("Name another one."));
	await send(`  then effort ${second}`, t, h, second);
}

console.log("4. first tool's description changed (expect: miss)");
{
	const n = nonce();
	const h: ResponseInputItem[] = [user("Name one prime number.")];
	await send("  F original tools", tools(n), h);
	await send("  G changed tool", tools(n, "Reads a text file."), h);
}
