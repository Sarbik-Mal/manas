import { afterAll, expect, test } from "bun:test";
import { fakeOpenAI, type Msg, say, tempRoot } from "../testing/fake-openai";

const fake = fakeOpenAI();
afterAll(fake.stop);

// A test client for `manas --stdio`. `home` stands in for the user folder, so
// saved sessions land in a temp folder.
function client(home = tempRoot()) {
	const proc = Bun.spawn(
		[process.execPath, `${import.meta.dir}/../main.ts`, "--stdio"],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OPENAI_BASE_URL: fake.url, USERPROFILE: home },
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
	const waitFor = async (pred: () => boolean) => {
		for (let i = 0; i < 1000 && !pred(); i++) await Bun.sleep(5);
		expect(pred()).toBe(true);
	};
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
	const count = (type: string, extra: (l: Msg) => boolean = () => true) =>
		lines.filter((l) => l.type === type && extra(l)).length;
	const idles = () => count("state/changed", (l) => l.state === "idle");
	const init = () =>
		send("initialize", {
			client: { name: "test", version: "0" },
			capabilities: [],
		});
	return { proc, lines, send, waitFor, count, idles, init, home };
}

// The 1.3 check: a test client drives a whole session through `manas --stdio`.
test("a test client drives a whole session through stdio", async () => {
	const c = client();
	expect(await c.init()).toMatchObject({
		ok: true,
		result: { protocol_version: 1 },
	});
	expect((await c.send("session/new", { cwd: process.cwd() })).ok).toBe(true);
	await c.waitFor(() => c.idles() === 1);

	fake.replies.push(say("hello"), say("again"));
	await c.send("session/prompt", { text: "hi" });
	await c.waitFor(() => c.idles() === 2);
	await c.send("session/prompt", { text: "and again" });
	await c.waitFor(() => c.idles() === 3);
	expect(
		c.lines.filter((l) => l.type === "message/done").map((l) => l.text),
	).toEqual(["hello", "again"]);

	fake.replies.push({ text: "long…", hold: true });
	await c.send("session/prompt", { text: "write a lot" });
	await c.waitFor(() => c.count("message/delta") === 3);
	expect((await c.send("session/interrupt")).result).toEqual({
		still_queued: [],
	});
	await c.waitFor(() => c.idles() === 4);
	expect(
		c.lines.filter((l) => l.type === "turn/finished").map((l) => l.stop_reason),
	).toEqual(["done", "done", "interrupted"]);

	c.proc.stdin.end();
	expect(await c.proc.exited).toBe(0);
	expect(await new Response(c.proc.stderr).text()).toBe("");
});

// The 1.5 check: a session resumes after killing the process.
test("a session resumes after the process is killed mid-reply", async () => {
	fake.reset();
	const a = client();
	await a.init();
	await a.send("session/new", { cwd: "E:\\proj" });
	fake.replies.push(say("noted, Sarbik"), { text: "1 2 3", hold: true });
	await a.send("session/prompt", { text: "my name is Sarbik" });
	await a.waitFor(() => a.idles() === 2);
	await a.send("session/prompt", { text: "count a lot" });
	await a.waitFor(() => a.count("message/delta") === 2);
	a.proc.kill();
	await a.proc.exited;

	const b = client(a.home);
	await b.init();
	const list = await b.send("sessions/list", { cwd: "E:\\proj" });
	expect(list.result.sessions).toMatchObject([
		{ title: "my name is Sarbik", messages: 3 },
	]);
	const id = list.result.sessions[0].session_id;
	expect(
		(await b.send("session/resume", { session_id: id, cwd: "E:\\proj" })).ok,
	).toBe(true);
	await b.waitFor(() => b.idles() === 1);
	expect(b.lines.filter((l) => l.replay).map((l) => l.text)).toEqual([
		"my name is Sarbik",
		"noted, Sarbik",
		"count a lot",
	]);

	fake.replies.push(say("Sarbik"));
	await b.send("session/prompt", { text: "what is my name?" });
	await b.waitFor(() => b.idles() === 2);
	const userTexts = fake.bodies
		.at(-1)
		?.input.flatMap((m) =>
			"role" in m && m.role === "user" ? [m.content] : [],
		);
	expect(userTexts).toEqual([
		"my name is Sarbik",
		"count a lot",
		"what is my name?",
	]);
	b.proc.stdin.end();
	await b.proc.exited;
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
