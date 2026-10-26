// Files embedded with `import x from "./file.exe" with { type: "file" }` give their path.
declare module "*.exe" {
	const path: string;
	export default path;
}

// Text files embedded with `with { type: "text" }` give their content.
declare module "*.ps1" {
	const text: string;
	export default text;
}
declare module "*.md" {
	const text: string;
	export default text;
}
