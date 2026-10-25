import OpenAI from "openai";
import { installId } from "../storage/install-id";

// Streams the reply text for one prompt.
export async function* streamText(input: string): AsyncGenerator<string> {
	if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
	const client = new OpenAI();
	const stream = await client.responses.create({
		model: "gpt-5.6-luna",
		input,
		stream: true,
		store: false,
		prompt_cache_key: installId(),
	});
	for await (const event of stream) {
		if (event.type === "response.output_text.delta") yield event.delta;
	}
}
