// Layers only point down (architecture.md 0b, rule 1). Top to bottom;
// folders on the same line are one layer and may import each other.
const layers = [
	["ui"],
	["host"],
	["loop", "session"],
	["tools"],
	["permissions"],
	["safety", "provider", "areas"],
	["config", "storage"],
	["platform"],
];

const dir = (names) => `^packages/core/src/(${names.join("|")})/`;

module.exports = {
	forbidden: [
		...layers.slice(1).map((layer, i) => ({
			name: `no-upward-from-${layer.join("-")}`,
			severity: "error",
			from: { path: dir(layer) },
			to: { path: dir(layers.slice(0, i + 1).flat()) },
		})),
		{
			name: "no-circular",
			severity: "error",
			from: {},
			to: { circular: true },
		},
	],
	options: {
		tsConfig: { fileName: "tsconfig.json" },
		exclude: { path: "node_modules" },
	},
};
