// Files embedded with `import x from "./file.exe" with { type: "file" }` give their path.
declare module "*.exe" {
	const path: string;
	export default path;
}
