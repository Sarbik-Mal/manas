import { expect, test } from "bun:test";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { restoreStream, scrub, scrubForLog, scrubItem, Vault } from "./scrub";

// Fake secrets, shaped like the real thing (v1's test values).
const OPENAI = `sk-proj-${"a1B2c3D4e5F6g7H8i9J0k1L2"}`;
const GITHUB = `ghp_${"A".repeat(36)}`;
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
const PEM = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${"x".repeat(40)}\npassword=abc123\n-----END RSA PRIVATE KEY-----`;
const same = (text: string, expected: string, kinds: string[]) =>
	expect(scrub(text)).toEqual({ text: expected, kinds });

test("token patterns", () => {
	same(`key = ${OPENAI}\n`, "key = [REDACTED:api_key#1]\n", ["api_key"]);
	same("aws AKIAABCDEFGHIJKLMNOP here", "aws [REDACTED:api_key#1] here", [
		"api_key",
	]);
	same(
		`git push https://${GITHUB}@github.com`,
		"git push https://[REDACTED:token#1]@github.com",
		["token"],
	);
	same(`cookie ${JWT};`, "cookie [REDACTED:token#1];", ["token"]);
	same(
		"Authorization: Bearer abcdef0123456789xyz",
		"Authorization: Bearer [REDACTED:token#1]",
		["token"],
	);
	same(`before\n${PEM}\nafter`, "before\n[REDACTED:private_key#1]\nafter", [
		"private_key",
	]);
});

test("patterns added in Manas", () => {
	same(`x github_pat_${"B".repeat(30)} y`, "x [REDACTED:token#1] y", ["token"]);
	same(`stripe sk_live_${"c".repeat(24)}`, "stripe [REDACTED:api_key#1]", [
		"api_key",
	]);
	same(`stripe rk_live_${"c".repeat(24)}`, "stripe [REDACTED:api_key#1]", [
		"api_key",
	]);
	same(
		`//registry.npmjs.org/:_authToken npm_${"D".repeat(36)}`,
		"//registry.npmjs.org/:_authToken [REDACTED:token#1]",
		["token"],
	);
	same(`hf_${"E".repeat(34)}`, "[REDACTED:token#1]", ["token"]);
	same(
		"DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc+/def==;EndpointSuffix=core",
		"DefaultEndpointsProtocol=https;AccountName=x;AccountKey=[REDACTED:api_key#1];EndpointSuffix=core",
		["api_key"],
	);
});

test("assignments redact only the value", () => {
	same('password = "hunter2"', 'password = "[REDACTED:password#1]"', [
		"password",
	]);
	same("DB_PASSWD='p@ss w0rd'", "DB_PASSWD='[REDACTED:password#1]'", [
		"password",
	]);
	same(
		'{"client_secret": "abc-123"}',
		'{"client_secret": "[REDACTED:secret#1]"}',
		["secret"],
	);
	same("auth_token: 9f8e7d6c", "auth_token: [REDACTED:token#1]", ["token"]);
	same('API_KEY: str = "k-123"', 'API_KEY: str = "[REDACTED:api_key#1]"', [
		"api_key",
	]);
	same("aws_access_key=zz99", "aws_access_key=[REDACTED:api_key#1]", [
		"api_key",
	]);
	// A .env line: even a word-only value is a secret.
	same(
		"export DB_PASSWORD=supersecret  # prod",
		"export DB_PASSWORD=[REDACTED:password#1]  # prod",
		["password"],
	);
});

test("the email-send shape", () => {
	const code =
		'import smtplib\nSMTP_PASSWORD = "hunter2"\nwith smtplib.SMTP_SSL(host) as server:\n    server.login(user, password=SMTP_PASSWORD)\n';
	const { text, kinds } = scrub(code);
	expect(text).toContain('SMTP_PASSWORD = "[REDACTED:password#1]"');
	expect(text).not.toContain("hunter2");
	expect(text).toContain("server.login(user, password=SMTP_PASSWORD)");
	expect(kinds).toEqual(["password"]);
});

test("code and placeholders are left alone", () => {
	for (const text of [
		"def add(a, b):\n    return a + b\n",
		'api_key = os.getenv("OPENAI_API_KEY")',
		'password = os.environ["PW"]',
		"password = user_input",
		"self.token = self.api_key",
		'secret = ""',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell variable, not a template
		"TOKEN=${GITHUB_TOKEN}",
		'api_key = "<your-key-here>"',
		"max_tokens = 4096",
		'tokenizer_name = "gpt2"',
		"if password == other:",
		"password: str",
		'print(f"{password}")',
	]) {
		expect(scrub(text)).toEqual({ text, kinds: [] });
	}
});

test("several secrets are all counted, once each", () => {
	const { text, kinds } = scrub(
		`OPENAI_API_KEY="${OPENAI}"\npassword = "x1"\nGH=${GITHUB}\n`,
	);
	expect(text).toBe(
		'OPENAI_API_KEY="[REDACTED:api_key#1]"\npassword = "[REDACTED:password#1]"\nGH=[REDACTED:token#1]\n',
	);
	expect([...kinds].sort()).toEqual(["api_key", "password", "token"]);
});

test("placeholders are stable across calls; distinct secrets get distinct numbers", () => {
	const vault = new Vault();
	expect(scrub(`my key is ${OPENAI}`, vault).text).toBe(
		"my key is [REDACTED:api_key#1]",
	);
	expect(scrub(`OPENAI_API_KEY="${OPENAI}"`, vault).text).toBe(
		'OPENAI_API_KEY="[REDACTED:api_key#1]"',
	);
	const other = `sk-${"Z".repeat(30)}`;
	same(
		`a=${OPENAI}\nb=${other}\nc=${OPENAI}\n`,
		"a=[REDACTED:api_key#1]\nb=[REDACTED:api_key#2]\nc=[REDACTED:api_key#1]\n",
		["api_key", "api_key", "api_key"],
	);
});

test("restore puts every copy back and reports unknown placeholders", () => {
	const vault = new Vault();
	scrub(`${OPENAI} and password = "hunter2"`, vault);
	expect(
		vault.restore(
			'k1 = "[REDACTED:api_key#1]"\nk2 = "[REDACTED:api_key#1]"\npw = "[REDACTED:password#1]"\nx = "[REDACTED:token#9]"',
		),
	).toEqual({
		text: `k1 = "${OPENAI}"\nk2 = "${OPENAI}"\npw = "hunter2"\nx = "[REDACTED:token#9]"`,
		unknown: ["[REDACTED:token#9]"],
	});
	const original = `SMTP_PASSWORD = "hunter2"\nKEY=${OPENAI}\n${PEM}\n`;
	const v2 = new Vault();
	const scrubbed = scrub(original, v2).text;
	expect(scrubbed).not.toContain("hunter2");
	expect(v2.restore(scrubbed)).toEqual({ text: original, unknown: [] });
	expect(String(v2)).toBe("Vault(3 secrets)");
});

test("known secrets are swept; short or word-only ones aren't", () => {
	const vault = new Vault();
	scrub('password = "hunter2"', vault);
	expect(scrub('PW=hunter2\nlogin(user, "hunter2")\n', vault)).toEqual({
		text: 'PW=[REDACTED:password#1]\nlogin(user, "[REDACTED:password#1]")\n',
		kinds: ["password", "password"],
	});
	const v2 = new Vault();
	scrub('password = "abc12"\nsecret = "password"', v2);
	expect(scrub("x = abc12\npassword = get()\n", v2)).toEqual({
		text: "x = abc12\npassword = get()\n",
		kinds: [],
	});
	const v3 = new Vault();
	v3.add("env", "https://db.internal:5432");
	v3.add("env", "short");
	expect(scrub("connect to https://db.internal:5432 or short", v3).text).toBe(
		"connect to [REDACTED:env#1] or short",
	);
});

test("a .env line inside read output; passwords inside URLs", () => {
	same(
		"62\tLOG_LEVEL=info\n63\tADMIN_PASSWORD=supersecret\n",
		"62\tLOG_LEVEL=info\n63\tADMIN_PASSWORD=[REDACTED:password#1]\n",
		["password"],
	);
	same(
		'URL = "postgresql://app:Pg_s3cret!2024@db.internal:5432/orders"',
		'URL = "postgresql://app:[REDACTED:password#1]@db.internal:5432/orders"',
		["password"],
	);
	same(
		"redis://default:r3dis-Pass77@cache:6379/0",
		"redis://default:[REDACTED:password#1]@cache:6379/0",
		["password"],
	);
	for (const text of [
		'f"postgresql://app:{DB_PASSWORD}@db.internal/orders"',
		'"mysql://%s:%s@%s/db" % (user, pw, host)',
		"https://example.com:8443/path",
		"git@github.com:shop/payments.git",
	]) {
		expect(scrub(text)).toEqual({ text, kinds: [] });
	}
});

test("scrubItem: message text, tool arguments and results; reasoning untouched", () => {
	const vault = new Vault();
	const items = [
		{ role: "user", content: `key ${OPENAI}` },
		{
			type: "message",
			id: "m",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: `ok ${OPENAI}`, annotations: [] }],
		},
		{
			type: "function_call",
			call_id: "c",
			name: "x",
			arguments: JSON.stringify({ q: OPENAI }),
		},
		{ type: "function_call_output", call_id: "c", output: `got ${OPENAI}` },
		{ type: "reasoning", id: "r", summary: [], encrypted_content: OPENAI },
	] as ResponseInputItem[];
	const out = JSON.stringify(items.map((i) => scrubItem(i, vault)));
	expect(out.split(OPENAI)).toHaveLength(2); // only the reasoning item keeps it
	expect(out.split("[REDACTED:api_key#1]")).toHaveLength(5);
	expect(items[0]).toEqual({ role: "user", content: `key ${OPENAI}` }); // not mutated
});

test("restoreStream holds a placeholder split across chunks", () => {
	const vault = new Vault();
	scrub(`k=${OPENAI}`, vault);
	for (const split of [
		["Use [REDAC", "TED:api_key#1] now"],
		["Use [", "REDACTED:api_", "key#1] now"],
		["Use [REDACTED:api_key#1", "] now"],
	]) {
		const s = restoreStream(vault);
		const out = split.map((c) => s.push(c)).join("") + s.flush();
		expect(out).toBe(`Use ${OPENAI} now`);
	}
	const s = restoreStream(vault);
	expect(s.push("a [ b")).toBe("a [ b");
	expect(s.push("ends with [RED")).toBe("ends with ");
	expect(s.flush()).toBe("[RED");
});

test("JSON round-trip; the log sweep sees every open vault", () => {
	const vault = new Vault();
	scrub(`k=${OPENAI}`, vault);
	vault.add("env", "hunter2hunter2");
	const back = Vault.fromJSON(JSON.parse(JSON.stringify(vault)));
	expect(back.restore("[REDACTED:env#1] [REDACTED:api_key#1]").text).toBe(
		`hunter2hunter2 ${OPENAI}`,
	);
	expect(scrub(`another key sk-${"Q".repeat(25)}`, back).text).toBe(
		"another key [REDACTED:api_key#2]",
	);
	expect(scrubForLog('{"msg":"failed with hunter2hunter2"}')).toBe(
		'{"msg":"failed with [REDACTED:env#1]"}',
	);
});
