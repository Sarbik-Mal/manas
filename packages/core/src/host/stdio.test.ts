import { afterAll, expect, test } from "bun:test";
import { fakeOpenAI, type Msg, say } from "../testing/fake-openai";

const fake = fakeOpenAI();
afterAll(fake.stop);

// The 1.3 check: a test client drives a whole session through `manas --stdio`.
test("a test client drives a whole session through stdio", async () => {
	const proc = Bun.spawn(
		[process.execPath, `${import.meta.dir}/../main.ts`, "--stdio"],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OPENAI_BASE_URL: fake.url },
		},
	);
	const lines: Msg[] = [];
	void (async () => {
		let buffer = "";
		for await (const chunk of proc.stdout.pipeThrough(
			new TextDecoderStream(),
		)) {
			buffer += chunk;
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const p of parts) lines.push(JSON.parse(p));
		}
	})();
	let n = 0;
	const send = async (type: string, data: object = {}) => {
		const id = `r${++n}`;
		proc.stdin.write(
			`${JSON.stringify({ kind: "request", id, type, ...data })}\n`,
		);
		proc.stdin.flush();
		await waitFor(() =>
			lines.some((l) => l.kind === "response" && l.id === id),
		);
		return lines.find((l) => l.kind === "response" && l.id === id) as Msg;
	};
	const waitFor = async (pred: () => boolean) => {
		for (let i = 0; i < 1000 && !pred(); i++) await Bun.sleep(5);
		expect(pred()).toBe(true);
	};
	const count = (type: string, extra: (l: Msg) => boolean = () => true) =>
		lines.filter((l) => l.type === type && extra(l)).length;
	const idle = (l: Msg) => l.state === "idle";

	expect(
		await send("initialize", {
			client: { name: "test", version: "0" },
			capabilities: [],
		}),
	).toMatchObject({
		ok: true,
		result: { protocol_version: 1 },
	});
	expect((await send("session/new", { cwd: process.cwd() })).ok).toBe(true);
	await waitFor(() => count("state/changed", idle) === 1);

	fake.replies.push(say("hello"), say("again"));
	await send("session/prompt", { text: "hi" });
	await waitFor(() => count("state/changed", idle) === 2);
	await send("session/prompt", { text: "and again" });
	await waitFor(() => count("state/changed", idle) === 3);
	expect(
		lines.filter((l) => l.type === "message/done").map((l) => l.text),
	).toEqual(["hello", "again"]);
	expect(fake.bodies[1].input).toContainEqual(
		expect.objectContaining({ role: "user", content: "hi" }),
	);

	fake.replies.push({ text: "long…", hold: true });
	await send("session/prompt", { text: "write a lot" });
	await waitFor(() => count("message/delta") === 3);
	expect((await send("session/interrupt")).result).toEqual({
		still_queued: [],
	});
	await waitFor(() => count("state/changed", idle) === 4);
	expect(
		lines.filter((l) => l.type === "turn/finished").map((l) => l.stop_reason),
	).toEqual(["done", "done", "interrupted"]);

	proc.stdin.end();
	expect(await proc.exited).toBe(0);
	expect(await new Response(proc.stderr).text()).toBe("");
});

test("--stdio with a prompt is an error", () => {
	const r = Bun.spawnSync([
		process.execPath,
		`${import.meta.dir}/../main.ts`,
		"--stdio",
		"hi",
	]);
	expect(r.exitCode).toBe(1);
});
