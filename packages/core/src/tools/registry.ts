import { resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";
import type { ToolSpec } from "../provider/openai";
import type { Vault } from "../safety/scrub";
import type { Answers, Questions } from "./ask";
import type { Backups } from "./backups";
import type { Checker } from "./checker";
import type { Hooks } from "./hooks";
import type { ReadRecord } from "./reads";
import { RESULT_MAX, spill } from "./spill";
import type { Tasks } from "./tasks";

// What every tool gets. Grows as parts are built: session, ask, vault,
// backups, emit (architecture.md 0b, rule 2).
export type ToolCtx = {
	signal: AbortSignal;
	// The project folder.
	cwd: string;
	// Where commands start and relative paths resolve: a `cd` in PowerShell
	// moves it within the project (3.1). One box for the whole session.
	shell: { cwd: string };
	// The deny rule covering an absolute path for reading, if any. Search
	// results drop such files (as Claude Code does for Grep and Glob).
	denied: (path: string) => string | undefined;
	// What the model has read (2.1), for edit and write's read-first rule.
	reads: ReadRecord;
	// The session's secrets: file writes put the real values back (2.2).
	vault: Vault;
	// Copies of files before edit or write changes them (2.5).
	backups: Backups;
	// Asks the user (2.8); null if they declined. Missing when no front end
	// can answer.
	ask?: (questions: Questions, callId: string) => Promise<Answers | null>;
	// This call's id, so a question can be tied to its tool row.
	callId?: string;
	// The session's background commands (3.3); without them a timeout stops
	// the command.
	tasks?: Tasks;
	// The session's scratchpad (3.4): its own files, written without asking.
	scratch?: string;
	// Where results too big for the conversation are saved (3.4).
	results?: string;
	// The user's hooks (3.7); none in tests that don't need them.
	hooks?: Hooks;
	// A shell says its command failed, so PostToolUseFailure fires.
	failed?: (error: string) => void;
	// Type errors an edit caused (3.8); none in tests that don't need them.
	checker?: Checker;
};
// What a session hands every call; `signal` is per turn.
export type SessionCtx = Omit<ToolCtx, "signal">;

export type Tool<S extends TSchema = TSchema> = {
	name: string;
	description: string;
	schema: S;
	// Not in the `tools` list sent to OpenAI; reached through call_tool (4.3).
	deferred: boolean;
	readOnly: boolean;
	// A longer result is saved to a file (3.4); 50,000 unless set.
	maxResultChars?: number;
	// It changes the file named by `permission.path`: the checker runs (3.8).
	checked?: true;
	// What the permission engine checks: a shell's command or a file's path.
	permission?: {
		command?: (input: Static<S>) => string;
		path?: (input: Static<S>) => string;
	};
	// One line for the approval prompt, e.g. "run: Remove-Item build".
	title?: (input: Static<S>) => string;
	// Step 1, after the schema: why this input is refused, before any prompt.
	validate?: (input: Static<S>, ctx: ToolCtx) => Promise<string | undefined>;
	// The change the approval prompt shows, after validate (an edit's diff).
	preview?: (input: Static<S>) => string | undefined;
	run(input: Static<S>, ctx: ToolCtx): Promise<string>;
};

export type Registry = { tools: Map<string, Tool>; specs: ToolSpec[] };
export type ToolResult = {
	status: "ok" | "error" | "denied";
	output: string;
	// The user said a plain No: the turn stops.
	stop?: boolean;
};
// Step 2: undefined to go ahead, or why not (and whether the turn stops).
export type Permit = (call: {
	tool: Tool;
	input: unknown;
	callId: string;
	diff?: string;
	// What a PreToolUse hook said (3.7).
	hook?: { decision?: "allow" | "ask"; reason?: string };
	// `input`: go ahead with this instead (a PermissionRequest hook changed it).
}) => Promise<
	{ output: string; stop?: boolean } | { input: unknown } | undefined
>;

// Thrown by `run` when the user said no (declined a question): the call is
// denied and the turn stops, as a plain No does.
export class Stopped extends Error {}

// Only types `run`'s input from the schema.
export const defineTool = <S extends TSchema>(tool: Tool<S>) => tool;

// Built once per session, so the `tools` list (and the prompt cache) never
// changes. Throws on a schema OpenAI strict mode would reject.
export function buildRegistry(list: Tool[]): Registry {
	const tools = new Map<string, Tool>();
	for (const tool of list) {
		if (tools.has(tool.name))
			throw new Error(`tool "${tool.name}" is defined twice`);
		const problems = strictProblems(tool.schema as Schema, "");
		if (problems.length > 0) {
			throw new Error(`tool "${tool.name}": ${problems.join("; ")}`);
		}
		tools.set(tool.name, tool);
	}
	const specs = list
		.filter((t) => !t.deferred)
		.map(({ name, description, schema }) => ({
			name,
			description,
			// A plain JSON copy: only standard JSON Schema keys reach OpenAI.
			parameters: JSON.parse(JSON.stringify(schema)),
		}));
	return { tools, specs };
}

// The steps every call goes through (tools.md). Permission (1.7), backup (M2)
// and check (M3) join here when they're built.
export async function callTool(
	registry: Registry,
	name: string,
	args: string,
	ctx: ToolCtx,
	permit: Permit = async () => undefined,
	callId = "",
): Promise<ToolResult> {
	// 1. Check input.
	const tool = registry.tools.get(name);
	if (!tool || tool.deferred) return error(`unknown tool "${name}"`);
	let input: unknown;
	try {
		input = JSON.parse(args);
	} catch {
		return error("arguments are not valid JSON");
	}
	const invalid = async (value: unknown) => {
		const errors = Value.Errors(tool.schema, value);
		if (errors.length > 0)
			return `invalid input for ${name}: ${describeErrors(errors).join("; ")}`;
		try {
			return await tool.validate?.(value, ctx);
		} catch (err) {
			return (err as Error).message;
		}
	};
	const bad = await invalid(input);
	if (bad) return error(bad);
	// 2. PreToolUse hooks, then permission. A hook's new input is checked
	// again like the model's.
	const { hooks, signal } = ctx;
	const pre = await hooks?.pre(tool, input, callId, signal);
	const context = pre?.context ? [pre.context] : [];
	if (pre?.deny !== undefined)
		return {
			status: "denied",
			output: `error: ${pre.deny}`,
			stop: pre.stop !== undefined,
		};
	if (pre?.input !== undefined) {
		const worse = await invalid(pre.input);
		if (worse) return error(worse);
		input = pre.input;
	}
	const refused = await permit({
		tool,
		input,
		callId,
		diff: tool.preview?.(input),
		hook: pre && { decision: pre.decision, reason: pre.reason },
	});
	if (refused && "input" in refused) {
		const worse = await invalid(refused.input);
		if (worse) return error(worse);
		input = refused.input;
	} else if (refused) {
		return {
			status: "denied",
			output: `error: ${refused.output}`,
			stop: refused.stop,
		};
	}
	// 4. Run, with the checker around an edit (3.8); it never fails the call.
	const checked =
		tool.checked && ctx.checker
			? resolve(ctx.shell.cwd, tool.permission?.path?.(input) ?? "")
			: undefined;
	if (checked) await ctx.checker?.before(checked, signal).catch(() => {});
	const started = performance.now();
	let failure: string | undefined;
	let output: string;
	let thrown = false;
	try {
		output = await tool.run(input, {
			...ctx,
			callId,
			failed: (e) => {
				failure = e;
			},
		});
	} catch (err) {
		if (err instanceof Stopped)
			return { status: "denied", output: `error: ${err.message}`, stop: true };
		output = `error: ${(err as Error).message}`;
		failure = (err as Error).message;
		thrown = true;
	}
	if (checked && failure === undefined) {
		const found = await ctx.checker
			?.after(checked, signal)
			.catch(() => undefined);
		if (found) output = `${output}\n\n${found}`;
	}
	// 5. PostToolUse or PostToolUseFailure; a cancelled tool fires neither.
	let stop: string | undefined;
	if (hooks && !signal.aborted) {
		const ms = performance.now() - started;
		const after =
			failure === undefined
				? await hooks.post(tool, input, callId, output, ms, signal)
				: await hooks.failure(tool, input, callId, failure, ms, signal);
		if (after.output !== undefined) output = after.output;
		context.push(...after.notes);
		stop = after.stop;
	}
	if (stop !== undefined) context.push(stop);
	if (context.length > 0) output = [output, ...context].join("\n\n");
	if (thrown)
		return {
			status: "error",
			output,
			...(stop !== undefined && { stop: true }),
		};
	// 6. Return; a result too big goes to a file, the model gets a preview.
	// ponytail: each result on its own; Claude Code also budgets a round's
	// results together, add that if many big parallel results fill the context.
	if (ctx.results)
		output = spill(output, {
			dir: ctx.results,
			id: callId || crypto.randomUUID(),
			vault: ctx.vault,
			max: tool.maxResultChars ?? RESULT_MAX,
		});
	return { status: "ok", output, ...(stop !== undefined && { stop: true }) };
}

const error = (message: string): ToolResult => ({
	status: "error",
	output: `error: ${message}`,
});

type Schema = {
	type?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	additionalProperties?: unknown;
	items?: Schema;
	anyOf?: Schema[];
};

// OpenAI strict mode: every object lists all its properties as required and
// allows no others. Optional fields are written as nullable instead.
function strictProblems(s: Schema, path: string): string[] {
	const at = path || "/";
	const out: string[] = [];
	if (path === "" && s.type !== "object") out.push("/: must be an object");
	if (s.type === "object" || s.properties) {
		if (s.additionalProperties !== false) {
			out.push(`${at}: additionalProperties must be false`);
		}
		const keys = Object.keys(s.properties ?? {});
		const missing = keys.filter((k) => !s.required?.includes(k));
		if (missing.length > 0) {
			out.push(
				`${at}: not required: ${missing.join(", ")} (use a nullable type)`,
			);
		}
		for (const k of keys)
			out.push(...strictProblems(s.properties?.[k] ?? {}, `${path}/${k}`));
	}
	if (s.items) out.push(...strictProblems(s.items, `${path}/items`));
	for (const [i, branch] of (s.anyOf ?? []).entries()) {
		out.push(...strictProblems(branch, `${path}/anyOf/${i}`));
	}
	return out;
}

type ValueError = ReturnType<typeof Value.Errors>[number];

// TypeBox reports each anyOf branch separately; fold them into one line per
// field, e.g. "/limit: must be integer or null".
export function describeErrors(errors: ValueError[]): string[] {
	const anyOfs = errors.filter((e) => e.keyword === "anyOf");
	const inBranch = (e: ValueError, a: ValueError) =>
		e.schemaPath.startsWith(`${a.schemaPath}/anyOf/`);
	const out: string[] = [];
	for (const e of errors) {
		// Repeats "must not have additional properties".
		if (e.keyword === "boolean") continue;
		// A branch's own mismatch; its anyOf sums it up.
		if (anyOfs.some((a) => inBranch(e, a) && e.instancePath === a.instancePath))
			continue;
		let message = e.message;
		if (e.keyword === "anyOf") {
			// A branch with deeper errors had the right type; those errors say what's wrong.
			if (
				errors.some((x) => inBranch(x, e) && x.instancePath !== e.instancePath)
			)
				continue;
			const types = errors
				.filter((x) => inBranch(x, e) && x.keyword === "type")
				.map((x) => (x.params as { type: string }).type);
			if (types.length > 0) message = `must be ${types.join(" or ")}`;
		} else if (e.keyword === "additionalProperties") {
			const extra = (e.params as { additionalProperties: string[] })
				.additionalProperties;
			message = `${message}: ${extra.join(", ")}`;
		}
		out.push(`${e.instancePath || "/"}: ${message}`);
	}
	return out;
}
