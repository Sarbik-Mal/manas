// Builds dist/ink-test.exe (risk test 0.11). Ink imports react-devtools-core
// behind `DEV === "true"`, but the bundler still needs it to exist, so it's
// replaced by an empty stub (devtools never run in a release build anyway).
import { join } from "node:path";

const result = await Bun.build({
	entrypoints: [join(import.meta.dir, "ink.tsx")],
	compile: {
		target: "bun-windows-x64",
		outfile: join(
			import.meta.dir,
			"..",
			"..",
			"..",
			"..",
			"dist",
			"ink-test.exe",
		),
	},
	plugins: [
		{
			name: "stub-react-devtools",
			setup(build) {
				build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
					path: "react-devtools-core",
					namespace: "stub",
				}));
				build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents:
						"export default { initialize() {}, connectToDevTools() {} };",
					loader: "js",
				}));
			},
		},
	],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log("built dist/ink-test.exe");
