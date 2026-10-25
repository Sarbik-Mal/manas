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

export function capability(model: string) {
	if (!Object.hasOwn(MODELS, model))
		throw new Error(`unknown model "${model}"`);
	return MODELS[model];
}
