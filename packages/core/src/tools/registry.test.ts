import { expect, test } from "bun:test";
import Type, { type TSchema } from "typebox";
import { Vault } from "../safety/scrub";
import { readRecord } from "./reads";
import { buildRegistry, callTool, defineTool, type Tool } from "./registry";

const strict = { additionalProperties: false } as const;
let ran = 0;
const tool = <S extends TSchema>(
	name: string,
	schema: S,
	extra?: Partial<Tool<S>>,
) =>
	defineTool({
		name,
		description: name,
		schema,
		deferred: false,
		readOnly: true,
		run: async (input) => {
			ran++;
			return JSON.stringify(input);
		},
		...extra,
	});

const read = tool(
	"read",
	Type.Object(
		{
			path: Type.String(),
			limit: Type.Union([Type.Integer(), Type.Null()]),
			opts: Type.Union([
				Type.Object({ raw: Type.Boolean() }, strict),
				Type.Null(),
			]),
		},
		strict,
	),
);
const later = tool("later", Type.Object({}, strict), { deferred: true });
const boom = tool("boom", Type.Object({}, strict), {
	run: async () => {
		throw new Error("disk on fire");
	},
});
const registry = buildRegistry([read, later, boom]);
const signal = new AbortController().signal;
const ctx = {
	signal,
	cwd: process.cwd(),
	denied: () => undefined,
	reads: readRecord(),
	vault: new Vault(),
};
const call = (name: string, args: unknown) =>
	callTool(
		registry,
		name,
		typeof args === "string" ? args : JSON.stringify(args),
		ctx,
	);

test("bad arguments come back as a clear error, and the tool never runs", async () => {
	ran = 0;
	const bad: [string, unknown, string][] = [
		[
			"read",
			{ path: "a", limit: "ten", opts: null },
			"/limit: must be integer or null",
		],
		[
			"read",
			{ limit: null, opts: null },
			"/: must have required properties path",
		],
		[
			"read",
			{ path: "a", limit: null, opts: null, x: 1 },
			"/: must not have additional properties: x",
		],
		[
			"read",
			{ path: "a", limit: null, opts: { raw: "yes" } },
			"/opts/raw: must be boolean",
		],
	];
	for (const [name, args, problem] of bad) {
		expect(await call(name, args)).toEqual({
			status: "error",
			output: `error: invalid input for ${name}: ${problem}`,
		});
	}
	expect(await call("read", "{oops")).toEqual({
		status: "error",
		output: "error: arguments are not valid JSON",
	});
	expect((await call("nope", {})).output).toBe('error: unknown tool "nope"');
	expect((await call("later", {})).output).toBe('error: unknown tool "later"');
	expect(ran).toBe(0);
});

test("several problems are all listed", async () => {
	expect((await call("read", { path: 1, limit: null })).output).toBe(
		"error: invalid input for read: /: must have required properties opts; /path: must be string",
	);
});

test("good arguments reach the tool; a throw comes back as an error", async () => {
	const args = { path: "a", limit: 5, opts: { raw: true } };
	expect(await call("read", args)).toEqual({
		status: "ok",
		output: JSON.stringify(args),
	});
	expect(await call("boom", {})).toEqual({
		status: "error",
		output: "error: disk on fire",
	});
});

test("specs hold the non-deferred tools as plain JSON Schema", () => {
	expect(registry.specs.map((s) => s.name)).toEqual(["read", "boom"]);
	expect(JSON.parse(JSON.stringify(registry.specs))).toEqual(registry.specs);
	expect(registry.specs[0].parameters).toEqual(
		JSON.parse(JSON.stringify(read.schema)),
	);
	expect(registry.tools.get("read")?.readOnly).toBe(true);
});

test("schemas that break strict mode are refused at startup", () => {
	const refused: [TSchema, string][] = [
		[
			Type.Object({ a: Type.Optional(Type.String()) }, strict),
			"/: not required: a",
		],
		[
			Type.Object({ a: Type.String() }),
			"/: additionalProperties must be false",
		],
		[
			Type.Object({ o: Type.Object({ b: Type.String() }) }, strict),
			"/o: additionalProperties must be false",
		],
		[
			Type.Object(
				{
					o: Type.Union([
						Type.Object({ b: Type.Optional(Type.String()) }, strict),
						Type.Null(),
					]),
				},
				strict,
			),
			"/o/anyOf/0: not required: b",
		],
		[
			Type.Object({ l: Type.Array(Type.Object({ b: Type.String() })) }, strict),
			"/l/items: additionalProperties must be false",
		],
		[Type.String(), "/: must be an object"],
	];
	for (const [schema, problem] of refused) {
		expect(() => buildRegistry([tool("x", schema)])).toThrow(
			`tool "x": ${problem}`,
		);
	}
	expect(() => buildRegistry([read, read])).toThrow(
		'tool "read" is defined twice',
	);
});

test("step 2: a refused call never runs", async () => {
	ran = 0;
	const r = await callTool(
		registry,
		"read",
		JSON.stringify({ path: "a", limit: null, opts: null }),
		ctx,
		async ({ tool, callId }) =>
			tool.name === "read" && callId === "c9"
				? { output: "denied by the user", stop: true }
				: undefined,
		"c9",
	);
	expect(r).toEqual({
		status: "denied",
		output: "error: denied by the user",
		stop: true,
	});
	expect(ran).toBe(0);
});

test("step 1 ends with the tool's own check: refused before any permission", async () => {
	ran = 0;
	let asked = 0;
	const picky = tool("picky", Type.Object({ cmd: Type.String() }, strict), {
		validate: async ({ cmd }) =>
			cmd === "rm" ? "rm can change things" : undefined,
	});
	const r = await callTool(
		buildRegistry([picky]),
		"picky",
		JSON.stringify({ cmd: "rm" }),
		ctx,
		async () => {
			asked++;
			return undefined;
		},
	);
	expect(r).toEqual({ status: "error", output: "error: rm can change things" });
	expect(asked).toBe(0);
	expect(ran).toBe(0);
});

test("step 2 gets the tool's preview, made after validate", async () => {
	let shown: string | undefined;
	const seen = new WeakSet<object>();
	const editor = tool("editor", Type.Object({ to: Type.String() }, strict), {
		validate: async (i) => {
			seen.add(i);
			return undefined;
		},
		preview: (i) => (seen.has(i) ? `+ ${i.to}` : undefined),
	});
	await callTool(
		buildRegistry([editor]),
		"editor",
		JSON.stringify({ to: "x" }),
		ctx,
		async ({ diff }) => {
			shown = diff;
			return undefined;
		},
	);
	expect(shown).toBe("+ x");
});
