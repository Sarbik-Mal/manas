// What each model accepts. The core never sends a parameter a model doesn't support.
// efforts: tested live 2026-10-26; luna rejects "minimal" even though the SDK lists it.
const MODELS: Record<
	string,
	{ efforts: readonly string[]; contextWindow: number }
> = {
	"gpt-5.6-luna": {
		efforts: ["none", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 400_000,
	},
	"gpt-4o-mini": { efforts: [], contextWindow: 128_000 },
};

export const modelNames = Object.keys(MODELS);

export function capability(model: string) {
	if (!Object.hasOwn(MODELS, model))
		throw new Error(`unknown model "${model}"`);
	return MODELS[model];
}

// Throws on an unknown model or an effort it can't take. A model without
// reasoning takes any effort: it's dropped, so one setting works everywhere.
export function checkEffort(model: string, effort: string | undefined) {
	const { efforts } = capability(model);
	if (effort && efforts.length > 0 && !efforts.includes(effort)) {
		throw new Error(
			`effort "${effort}" not supported by ${model}: ${efforts.join(", ")}`,
		);
	}
	return efforts;
}
