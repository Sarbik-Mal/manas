import { resolve } from "node:path";
import type { HookEvent, HookHandler, Settings } from "../config/settings";
import { debugLog } from "../log/debug";
import { matchesIf, ruleName } from "../permissions/engine";
import { scrub, type Vault } from "../safety/scrub";
import { gitBash } from "./gitbash";
import { SHELL } from "./powershell";
import type { Tool } from "./registry";
import { spill } from "./spill";

// Hooks (3.7), Claude Code's format and rules: command hooks on the events
// Manas can fire. Hooks see placeholders, never real secret values; what they
// send back is scrubbed on its way to the model.

// ponytail: command hooks only, without async, asyncRewake and statusMessage;
// the other types need MCP, a cheap model call or subagents.
// ponytail: updatedPermissions, sessionTitle, initialUserMessage, watchPaths,
// reloadSkills and terminalSequence are ignored: nothing here uses them yet.
// ponytail: hooks get Manas's whole environment, as Claude Code's do, so
// OPENAI_API_KEY too when it's set there.
// ponytail: files a hook changes aren't tracked for /rewind.
// ponytail: additionalContext is saved like any developer item, so a resume
// replays it (as Claude Code) and timestamps in it go stale.

const CAP = 10_000;
const DEFAULT_TIMEOUT = 600_000;
const PROMPT_TIMEOUT = 30_000;
const SESSION_END_TIMEOUT = 1_500;
const SESSION_END_MAX = 60_000;
export const STOP_CAP = 8;
const PROJECT_DIR = /\$\{MANAS_PROJECT_DIR\}/g;

type Json = Record<string, unknown>;
const object = (v: unknown): Json | undefined =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const text = (v: unknown) => (typeof v === "string" ? v : undefined);
const NO_MATCHER = new Set<HookEvent>([
	"PostToolBatch",
	"UserPromptSubmit",
	"Stop",
]);

// `*`, empty or none: all. Plain words and `|` or `,`: an exact list. Anything
// else: an unanchored regular expression. Case-sensitive.
export function matcherHits(matcher: string | undefined, name: string) {
	if (!matcher || matcher === "*") return true;
	if (/^[\w\s,|-]+$/.test(matcher))
		return matcher
			.split(/[|,]/)
			.map((m) => m.trim())
			.includes(name);
	try {
		return new RegExp(matcher).test(name);
	} catch {
		return false;
	}
}

type Ran = {
	command: string;
	onFailure?: string;
	code: number | null;
	stdout: string;
	stderr: string;
	status: "ok" | "failed" | "timed out" | "cancelled";
};

// What one hook said.
type Verdict = {
	json?: Json;
	// Plain stdout of an exit 0.
	plain?: string;
	block?: { reason: string; text: string; exit2: boolean };
};

// The JSON if stdout is one object and nothing else.
function single(stdout: string) {
	const t = stdout.trim();
	if (!t.startsWith("{")) return undefined;
	try {
		return object(JSON.parse(t));
	} catch {
		return undefined;
	}
}

export type HooksEnv = {
	settings: () => Settings;
	// The project, and where commands are now.
	cwd: string;
	here: () => string;
	vault: Vault;
	sessionId: string;
	transcript: string;
	scratch?: string;
	// Where over-long output goes.
	results: string;
	mode: () => string;
	effort: () => string | undefined;
	notice: (level: "info" | "warn" | "error", text: string) => void;
	// Git Bash's path, or null without it.
	bash?: string | null;
};

export function openHooks(env: HooksEnv) {
	const bash = env.bash === undefined ? gitBash().path : env.bash;
	const clean = (v: unknown): unknown => {
		if (typeof v === "string") return scrub(v, env.vault).text;
		if (Array.isArray(v)) return v.map(clean);
		if (object(v))
			return Object.fromEntries(
				Object.entries(v as Json).map(([k, x]) => [k, clean(x)]),
			);
		return v;
	};
	// A long string goes to a file; the rest of the caps are spill's.
	const capped = (s: string) =>
		spill(s, {
			dir: env.results,
			id: `hook-${crypto.randomUUID()}`,
			vault: env.vault,
			max: CAP,
		});

	const argvOf = (h: HookHandler) => {
		if (h.args)
			return [h.command, ...h.args].map((a) =>
				a.replace(PROJECT_DIR, () => env.cwd),
			);
		const shell = h.shell ?? (bash ? "bash" : "powershell");
		if (shell === "bash") {
			if (!bash) throw new Error("Git Bash wasn't found");
			return [bash, "-c", h.command];
		}
		return [
			SHELL,
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			h.command.replace(PROJECT_DIR, () => `\${env:MANAS_PROJECT_DIR}`),
		];
	};

	async function run(
		h: HookHandler,
		event: HookEvent,
		stdin: string,
		signal?: AbortSignal,
	): Promise<Ran> {
		const started = performance.now();
		const base = { command: h.command, onFailure: h.onFailure };
		const done = (r: Omit<Ran, "command" | "onFailure">) => {
			// Metadata only: a command or its output could hold anything.
			debugLog({
				kind: "hook",
				event,
				status: r.status,
				code: r.code,
				ms: Math.round(performance.now() - started),
			});
			return { ...base, ...r };
		};
		const ms =
			event === "SessionEnd"
				? Math.min(
						h.timeout !== undefined
							? h.timeout * 1000
							: Number(process.env.MANAS_SESSIONEND_HOOKS_TIMEOUT_MS) ||
									SESSION_END_TIMEOUT,
						SESSION_END_MAX,
					)
				: h.timeout !== undefined
					? h.timeout * 1000
					: event === "UserPromptSubmit"
						? PROMPT_TIMEOUT
						: DEFAULT_TIMEOUT;
		let p: Bun.Subprocess<Uint8Array, "pipe", "pipe">;
		try {
			p = Bun.spawn(argvOf(h), {
				cwd: env.here(),
				env: { ...process.env, MANAS_PROJECT_DIR: env.cwd },
				stdin: Buffer.from(stdin),
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			return done({
				code: null,
				stdout: "",
				stderr: (err as Error).message,
				status: "failed",
			});
		}
		// The whole tree: a hook may start programs of its own.
		const kill = () =>
			Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(p.pid)]);
		const finished = Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stopped = new Promise<"timed out" | "cancelled">((res) => {
			timer = setTimeout(() => res("timed out"), ms);
			if (signal?.aborted) res("cancelled");
			signal?.addEventListener("abort", () => res("cancelled"), { once: true });
		});
		const first = await Promise.race([finished, stopped]);
		clearTimeout(timer);
		if (typeof first === "string") {
			kill();
			return done({ code: null, stdout: "", stderr: "", status: first });
		}
		const [stdout, stderr, code] = first;
		return done({ code, stdout, stderr, status: "ok" });
	}

	function judge(r: Ran, event: HookEvent, tool?: string): Verdict {
		const label = tool ? `${event}:${tool}` : event;
		const error = (m: string) => `${label} hook error: [${r.command}]: ${m}`;
		if (r.status === "cancelled") return {};
		const json = r.status === "ok" ? single(r.stdout) : undefined;
		if (r.code === 2) {
			const own = object(json?.hookSpecificOutput);
			const reason =
				text(json?.reason) ??
				text(own?.permissionDecisionReason) ??
				(r.stderr.trim() || "no reason given");
			return { block: { reason, text: error(reason), exit2: true } };
		}
		if (json) return { json };
		if (r.status === "ok" && r.code === 0) {
			const invalid = r.stdout.trim().startsWith("{");
			if (!invalid || r.onFailure !== "block")
				return { plain: r.stdout.trim() };
		}
		const what = r.status === "timed out" ? "timed out" : "failed";
		const blocked = (why: string) => {
			const reason = `${what}; ${why}`;
			return { block: { reason, text: error(reason), exit2: false } };
		};
		if (r.onFailure === "block")
			return blocked('blocking because onFailure is "block"');
		if (
			!bash &&
			r.code !== null &&
			(event === "PreToolUse" || event === "PermissionRequest")
		)
			return blocked(
				"blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict.",
			);
		env.notice(
			"warn",
			r.status === "timed out"
				? `${label} hook error: timed out; its output was discarded`
				: `${label} hook error: Failed with non-blocking status code: ${r.stderr.trim().split(/\r?\n/)[0] ?? ""}`,
		);
		return {};
	}

	// Every matching hook, in parallel, to the end; identical ones once.
	async function fire(
		event: HookEvent,
		query: string | undefined,
		fields: Json,
		{
			signal,
			tool,
			input,
			name,
		}: {
			signal?: AbortSignal;
			tool?: Tool;
			input?: unknown;
			name?: string;
		} = {},
	): Promise<Verdict[]> {
		const settings = env.settings();
		if (settings.disableAllHooks) return [];
		const handlers = new Map<string, HookHandler>();
		for (const entry of settings.hooks?.[event] ?? []) {
			if (
				!NO_MATCHER.has(event) &&
				query !== undefined &&
				!matcherHits(entry.matcher, query)
			)
				continue;
			for (const h of entry.hooks) {
				if (
					h.if &&
					tool &&
					!(await matchesIf(h.if, tool, input, env.cwd, env.here()))
				)
					continue;
				handlers.set(JSON.stringify([h.command, h.args, h.shell, h.if]), h);
			}
		}
		if (handlers.size === 0) return [];
		const effort = env.effort();
		const mode = env.mode();
		const stdin = JSON.stringify({
			session_id: env.sessionId,
			transcript_path: env.transcript,
			cwd: env.here(),
			...(env.scratch && { scratchpad_dir: env.scratch }),
			// The mode labelled Manual arrives as "default", as Claude Code's.
			permission_mode: mode === "manual" ? "default" : mode,
			...(effort && { effort: { level: effort } }),
			hook_event_name: event,
			...(clean(fields) as Json),
		});
		const ran = await Promise.all(
			[...handlers.values()].map((h) => run(h, event, stdin, signal)),
		);
		const verdicts = ran.map((r) => judge(r, event, name));
		for (const v of verdicts) {
			const message = text(v.json?.systemMessage);
			if (message) env.notice("warn", message);
		}
		return verdicts;
	}

	// hookSpecificOutput counts only if it names this event (Claude's rule).
	const own = (v: Verdict, event: HookEvent) => {
		const o = object(v.json?.hookSpecificOutput);
		return o?.hookEventName === event ? o : undefined;
	};
	// Every hook's context, one after another.
	const contexts = (vs: Verdict[], event: HookEvent, plain = false) => {
		const all = vs.flatMap((v) => {
			const c = text(own(v, event)?.additionalContext);
			return [...(c ? [c] : []), ...(plain && v.plain ? [v.plain] : [])];
		});
		return all.length > 0 ? all.map(capped).join("\n") : undefined;
	};
	// `continue: false`: the reason to stop, shown and kept.
	const stopping = (vs: Verdict[]) => {
		const v = vs.find((x) => x.json?.continue === false);
		return v
			? (text(v.json?.stopReason) ?? "A hook stopped the turn.")
			: undefined;
	};
	// Tool input as a hook sees it: file paths absolute, as in Claude Code.
	const inputOf = (input: unknown) => {
		const o = object(input);
		const path = text(o?.file_path);
		return path ? { ...o, file_path: resolve(env.here(), path) } : input;
	};
	const toolFields = (tool: Tool, input: unknown) => ({
		tool_name: ruleName(tool.name),
		tool_input: inputOf(input),
	});
	const about = (tool: Tool, input: unknown, signal?: AbortSignal) => ({
		tool,
		input,
		signal,
		name: ruleName(tool.name),
	});

	return {
		// Before the permission check.
		async pre(
			tool: Tool,
			input: unknown,
			callId: string,
			signal?: AbortSignal,
		) {
			const event = "PreToolUse";
			const vs = await fire(
				event,
				ruleName(tool.name),
				{ ...toolFields(tool, input), tool_use_id: callId },
				about(tool, input, signal),
			);
			const stop = stopping(vs);
			const blocked = vs.find((v) => v.block)?.block?.text;
			const outs = vs.map((v) => own(v, event)).filter((o) => o !== undefined);
			const said = (d: string) => outs.find((o) => o.permissionDecision === d);
			const deny = said("deny");
			const ask = said("ask");
			const allow = said("allow");
			const updated = outs.findLast((o) =>
				object(o.updatedInput),
			)?.updatedInput;
			return {
				deny:
					blocked ??
					(deny
						? (text(deny.permissionDecisionReason) ?? "denied by a hook")
						: stop),
				stop,
				decision: ask
					? ("ask" as const)
					: allow
						? ("allow" as const)
						: undefined,
				reason: text(ask?.permissionDecisionReason),
				input: updated,
				context: contexts(vs, event),
			};
		},
		// After a tool ran and succeeded.
		async post(
			tool: Tool,
			input: unknown,
			callId: string,
			output: string,
			ms: number,
			signal?: AbortSignal,
		) {
			const event = "PostToolUse";
			const vs = await fire(
				event,
				ruleName(tool.name),
				{
					...toolFields(tool, input),
					tool_use_id: callId,
					tool_response: output,
					duration_ms: Math.round(ms),
				},
				about(tool, input, signal),
			);
			const notes = [
				...vs.flatMap((v) => {
					if (v.block) return [v.block.text];
					const reason = text(v.json?.reason);
					return v.json?.decision === "block" && reason ? [reason] : [];
				}),
				...(contexts(vs, event) ? [contexts(vs, event) as string] : []),
			];
			const output2 = vs
				.map((v) => text(own(v, event)?.updatedToolOutput))
				.findLast((o) => o !== undefined);
			return { output: output2, notes, stop: stopping(vs) };
		},
		// After a tool ran and failed.
		async failure(
			tool: Tool,
			input: unknown,
			callId: string,
			error: string,
			ms: number,
			signal?: AbortSignal,
		) {
			const event = "PostToolUseFailure";
			const vs = await fire(
				event,
				ruleName(tool.name),
				{
					...toolFields(tool, input),
					tool_use_id: callId,
					error,
					is_interrupt: false,
					duration_ms: Math.round(ms),
				},
				about(tool, input, signal),
			);
			const c = contexts(vs, event);
			return {
				output: undefined as string | undefined,
				notes: [
					...vs.flatMap((v) => (v.block ? [v.block.text] : [])),
					...(c ? [c] : []),
				],
				stop: stopping(vs),
			};
		},
		// Races the prompt: undefined leaves the prompt up.
		async permission(
			tool: Tool,
			input: unknown,
			suggestions: unknown,
			signal?: AbortSignal,
		) {
			const event = "PermissionRequest";
			const vs = await fire(
				event,
				ruleName(tool.name),
				{ ...toolFields(tool, input), permission_suggestions: suggestions },
				about(tool, input, signal),
			);
			// Exit 2 isn't honoured here; a failure that blocks denies.
			const failed = vs.find((v) => v.block && !v.block.exit2)?.block;
			if (failed) return { behavior: "deny" as const, message: failed.text };
			const ds = vs
				.map((v) => object(own(v, event)?.decision))
				.filter((d) => d !== undefined);
			const deny = ds.find((d) => d.behavior === "deny");
			if (deny)
				return {
					behavior: "deny" as const,
					message: text(deny.message),
					interrupt: deny.interrupt === true,
				};
			const allow = ds.find((d) => d.behavior === "allow");
			if (allow)
				return {
					behavior: "allow" as const,
					input: object(allow.updatedInput),
				};
			return undefined;
		},
		// After a round's tools, before the next request.
		async batch(
			calls: {
				tool_name: string;
				tool_input: unknown;
				tool_use_id: string;
				tool_response: string;
			}[],
			signal?: AbortSignal,
		) {
			const event = "PostToolBatch";
			const vs = await fire(
				event,
				undefined,
				{
					tool_calls: calls.map((c) => ({
						...c,
						tool_name: ruleName(c.tool_name),
						tool_input: inputOf(c.tool_input),
					})),
				},
				{ signal },
			);
			const blocked = vs.find((v) => v.block)?.block?.reason;
			const reason = vs
				.filter((v) => v.json?.decision === "block")
				.map((v) => text(v.json?.reason) ?? "")[0];
			return {
				context: contexts(vs, event),
				stop:
					blocked ??
					stopping(vs) ??
					(reason !== undefined
						? reason || "A hook stopped the turn."
						: undefined),
			};
		},
		// The model is done: a reason keeps it going.
		async stop(
			active: boolean,
			last: string,
			tasks: unknown,
			signal?: AbortSignal,
		) {
			const event = "Stop";
			const vs = await fire(
				event,
				undefined,
				{
					stop_hook_active: active,
					last_assistant_message: last,
					background_tasks: tasks,
				},
				{ signal },
			);
			if (stopping(vs) !== undefined) return {};
			const reasons = vs.flatMap((v) => {
				if (v.block) return [v.block.reason];
				const reason = text(v.json?.reason);
				return v.json?.decision === "block" && reason ? [reason] : [];
			});
			const c = contexts(vs, event);
			const again = [...reasons, ...(c ? [c] : [])].join("\n");
			return { again: again || undefined };
		},
		// No decisions here, only a notification.
		async stopFailure(kind: string, message: string) {
			await fire("StopFailure", kind, {
				error: kind,
				last_assistant_message: message,
			});
		},
		// A reason to block, or context beside the prompt.
		async prompt(prompt: string, signal?: AbortSignal) {
			const event = "UserPromptSubmit";
			const vs = await fire(event, undefined, { prompt }, { signal });
			const reason = vs.flatMap((v) => {
				if (v.block) return [v.block.reason];
				if (v.json?.decision === "block")
					return [text(v.json.reason) ?? "A hook blocked this prompt."];
				return [];
			})[0];
			return {
				block: reason ?? stopping(vs),
				context: contexts(vs, event, true),
			};
		},
		async sessionStart(source: "startup" | "resume", model: string) {
			const event = "SessionStart";
			const vs = await fire(event, source, { source, model });
			for (const v of vs)
				if (v.block)
					env.notice("warn", `${event} hook error: ${v.block.reason}`);
			return contexts(vs, event, true);
		},
		async sessionEnd(reason: string) {
			const event = "SessionEnd";
			const vs = await fire(event, reason, { reason });
			for (const v of vs)
				if (v.block)
					env.notice("warn", `${event} hook error: ${v.block.reason}`);
		},
	};
}
export type Hooks = ReturnType<typeof openHooks>;

// Claude's StopFailure matcher values, from OpenAI's errors.
export function errorKind(err: unknown) {
	const status = (err as { status?: number }).status;
	if (status === 429) return "rate_limit";
	if (status === 401 || status === 403) return "authentication_failed";
	if (status === 404) return "model_not_found";
	if (status === 400) return "invalid_request";
	if (status !== undefined && status >= 500) return "server_error";
	return "unknown";
}
