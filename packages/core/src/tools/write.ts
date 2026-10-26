import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Type from "typebox";
import { showDiff } from "./diff";
import { openForChange, restoreAll, STALE } from "./edit";
import { sha256 } from "./reads";
import { defineTool, type ToolCtx } from "./registry";

// write (tools.md §1), shaped like Claude Code's Write: creates a file or
// replaces it whole. An existing file must be read first and unchanged since;
// missing folders are made. Checked before the approval prompt, like edit.

type Input = { file_path: string; content: string };
type Plan = {
	path: string;
	// The bytes the plan saw; undefined for a new file.
	hash?: string;
	content: string;
	diff: string;
};

async function plan(i: Input, ctx: ToolCtx): Promise<string | Plan> {
	const restored = restoreAll(ctx, i.content);
	if (typeof restored === "string") return restored;
	const [content] = restored;
	const file = openForChange(ctx, i.file_path, "written");
	if (typeof file === "string") return file;
	if (file.missing)
		return { path: file.path, content, diff: showDiff("", content) };
	// write replaces everything, so a change since the read would be lost.
	if (file.stale) return STALE;
	return {
		path: file.path,
		hash: file.hash,
		content,
		diff: showDiff(file.text, content),
	};
}

const plans = new WeakMap<object, Plan>();

export const write = defineTool({
	name: "write",
	description:
		"Creates a file, or replaces one completely. To change part of a file, use edit. " +
		"An existing file must be read first in this conversation, or the write fails. Missing folders are created.",
	schema: Type.Object(
		{
			file_path: Type.String({ description: "The file to write." }),
			content: Type.String({ description: "The whole content of the file." }),
		},
		{ additionalProperties: false },
	),
	deferred: false,
	readOnly: false,
	permission: { path: (i) => i.file_path },
	title: (i) => `write ${i.file_path}`,
	async validate(i, ctx) {
		const p = await plan(i, ctx);
		if (typeof p === "string") return p;
		plans.set(i, p);
	},
	preview: (i) => plans.get(i)?.diff,
	async run(i, ctx) {
		let p: string | Plan | undefined = plans.get(i);
		plans.delete(i);
		p ??= await plan(i, ctx);
		if (typeof p === "string") throw new Error(p);
		const now = statSync(p.path, { throwIfNoEntry: false });
		if (p.hash === undefined ? now : sha256(readFileSync(p.path)) !== p.hash) {
			throw new Error(
				`${i.file_path} changed while waiting for approval. Read it again.`,
			);
		}
		mkdirSync(dirname(p.path), { recursive: true });
		writeFileSync(p.path, p.content);
		// The model wrote all of it, so it has the whole file in view.
		ctx.reads.set(p.path, {
			hash: sha256(Buffer.from(p.content)),
			mtime: statSync(p.path).mtimeMs,
			offset: null,
			limit: null,
			partial: false,
		});
		const done =
			p.hash === undefined
				? `File created successfully at: ${i.file_path}`
				: `The file ${i.file_path} has been updated successfully.`;
		return `${done} (file state is current in your context; no need to read it back)`;
	},
});
