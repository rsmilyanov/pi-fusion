import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexBackend } from "../extensions/backends/codex.ts";
import { CODEX_APP_SERVER_ARGS } from "../extensions/backends/codex-launch.ts";
import { RESUME_MOVED } from "../extensions/backends/codex-outcome.ts";
import { CODEX_QUESTION_UNANSWERED } from "../extensions/backends/codex-transport.ts";
import { type BackendName, type HostBackend, hostBackend, type SessionIntent } from "../extensions/backends/types.ts";
import fusion from "../extensions/fusion.ts";
import { memoryProfileStore, type ProfileStore } from "../extensions/profile-store.ts";
import { memorySettingsStore } from "../extensions/settings-store.ts";
import { History, type HistoryRecord } from "../extensions/history.ts";
import { type FakeBackend, fakeBackend, type FakeScript } from "./fake-pi-backend.ts";
import { securityProfiles, toolList, turnOn } from "./host-tools.ts";
import { tripwireReaches, tripwires } from "./tripwire.ts";

/**
 * The shared run lifecycle, driven end to end against backends injected in memory: the registered tools, the host
 * branch the extension appends to, the history it keeps and the controls that act on a run. Nothing here starts a
 * real child of any harness. What these tests cover is Fusion's own policy, never Pi's behavior; the Pi session
 * semantics stay `test/spikes/pi-session-lifecycle.mjs`'s to measure against a real child.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_FUSION_CLAUDE_BIN = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.FAKE_CLAUDE_SCENARIO = "ok";
process.env.PI_FUSION_DASHBOARD_OPEN = "0";

const tempDirs: string[] = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (name: string): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fusion-${name}-`));
	tempDirs.push(dir);
	return dir;
};

/** The variables a test sets for its own extension, restored whatever the test does. */
async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
	const held = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(vars)) {
		held.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await body();
	} finally {
		for (const [key, value] of held) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type Result = { content: Array<{ type: string; text: string }>; details: any };
type Called = { text?: string; error?: string; details?: any };

interface HostOptions {
	backends?: Partial<Record<BackendName, HostBackend>>;
	/** The host branch this extension reads and appends to, shared between registrations to model a Pi restart. */
	branch?: unknown[];
	sessionId?: string;
	/** Only a host session Pi keeps a file for keeps a history. */
	sessionFile?: string;
	cwd?: string;
	/** Where the host's profiles are kept: a store of the case's own, or an empty one in memory. */
	profiles?: ProfileStore;
}

/** A Pi host with the extension registered on it: the tools, the command, the branch it appends to and the messages it got. */
function makeHost(options: HostOptions = {}) {
	const tools = new Map<string, { execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: undefined, ctx: any) => Promise<Result> }>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const branch: unknown[] = options.branch ?? [];
	const notices: string[] = [];
	/** The same notices with the level each was shown at, for a test that reads how loud one was. */
	const notified: Array<{ text: string; level?: string }> = [];
	const sent: Array<[any, any]> = [];
	/** The host's active tool list, which Fusion's own mode changes are the only things here that change. */
	const { activeTools, ...toolAccess } = toolList(() => tools.keys());
	const api = {
		...toolAccess,
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (event: string, handler: any) => handlers.set(event, handler),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		sendMessage: (message: unknown, opts: unknown) => sent.push([message, opts]),
		registerMessageRenderer: () => {},
	} as unknown as ExtensionAPI;
	// The tripwires under whatever the case registered: a host here that named only claude still gets no pi or codex
	// backend it could run, and a case that injects one of its own puts it over these.
	fusion(api, { backends: { ...tripwires(), ...options.backends }, profiles: options.profiles ?? memoryProfileStore(), settings: memorySettingsStore() });
	const sessionManager: Record<string, unknown> = { getSessionId: () => options.sessionId ?? "host-1", getBranch: () => branch };
	if (options.sessionFile !== undefined) sessionManager.getSessionFile = () => options.sessionFile;
	const editors: Array<{ title: string; prefill?: string }> = [];
	let openEditor: ((text: string | undefined) => void) | undefined;
	const ui = {
		setStatus() {},
		setWidget() {},
		notify: (text: string, level?: string) => {
			notices.push(text);
			notified.push({ text, ...(level === undefined ? {} : { level }) });
		},
		editor: (title: string, prefill?: string) =>
			new Promise<string | undefined>((resolve) => {
				editors.push({ title, ...(prefill === undefined ? {} : { prefill }) });
				openEditor = resolve;
			}),
	};
	const ctx = { cwd: options.cwd ?? repoRoot, mode: "print", hasUI: true, ui, sessionManager };
	// Fusion starts off; a case that delegates needs it on, as a user's request for Fusion turns it on.
	void turnOn(tools.get("fusion_activate"), ctx);
	const call = async (tool: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Called> => {
		const registered = tools.get(tool);
		assert.ok(registered, `tool ${tool} is not registered`);
		try {
			const result = await registered.execute("call-1", params, signal, undefined, ctx);
			return { text: result.content[0]!.text, details: result.details };
		} catch (error) {
			return { error: (error as Error).message };
		}
	};
	return {
		activeTools,
		branch,
		notices,
		notified,
		sent,
		ctx,
		tools,
		call,
		editors,
		/** Closes the editor the command opened, as the user does by saving or cancelling it. */
		closeEditor: (typed: string | undefined) => {
			const resolve = openEditor!;
			openEditor = undefined;
			resolve(typed);
		},
		fusion: (params: Record<string, unknown>, signal?: AbortSignal) => call("fusion", params, signal),
		claude: (params: Record<string, unknown>, signal?: AbortSignal) => call("claude", params, signal),
		control: (params: Record<string, unknown>, signal?: AbortSignal) => call("fusion_control", params, signal),
		claudeControl: (params: Record<string, unknown>, signal?: AbortSignal) => call("claude_control", params, signal),
		command: (args: string) => commands.get("fusion")!.handler(args, ctx),
		tree: () => handlers.get("session_before_tree")!({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal }, ctx),
		shutdown: () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx),
		/** The data of every pi-fusion entry the extension appended, oldest first. */
		entries: (): Array<Record<string, any>> => branch.map((item: any) => item.data),
		description: (tool: string): string => (tools.get(tool) as any as { description?: string }).description ?? "",
	};
}

/**
 * Blocks until the run has ended and everything its end path does has landed, its branch entry included. The
 * control wait is that barrier because it awaits the run's own `ended` promise; a status line that reads `done`
 * is not, because the state turns terminal before the run takes its last snapshot and appends its entry.
 */
async function ended(host: ReturnType<typeof makeHost>, handle: string): Promise<string> {
	const waited = await host.control({ action: "wait", run: handle });
	assert.equal(waited.error, undefined, `waiting for ${handle} failed: ${waited.error}`);
	assert.doesNotMatch(waited.text ?? "", /\) asks:/, `${handle} stopped at a question instead of ending`);
	return waited.text ?? "";
}

const PI_MODEL = "deepseek/deepseek-chat";
const piEnv = (over: Record<string, string | undefined> = {}) => ({
	PI_FUSION_PI_PLAN_MODEL: PI_MODEL,
	PI_FUSION_PI_IMPLEMENT_MODEL: PI_MODEL,
	PI_FUSION_PI_ASK_MODEL: PI_MODEL,
	PI_FUSION_PI_PLAN_EFFORT: undefined,
	PI_FUSION_PI_IMPLEMENT_EFFORT: undefined,
	PI_FUSION_PI_ASK_EFFORT: undefined,
	...over,
});

/** The backends a host runs with, so a test names only the ones it uses. */
const both = (pi: FakeBackend, claude?: FakeBackend): Partial<Record<BackendName, HostBackend>> => ({
	pi: pi.backend,
	...(claude ? { claude: claude.backend } : {}),
});

/** Nothing about a Pi run may read as a Claude session to resume, whatever scalar id the child reported. */
const noClaudeResume = (where: string, ...texts: Array<string | undefined>): void => {
	for (const text of texts) assert.ok(!/claude --resume/.test(text ?? ""), `${where} offers a claude resume: ${text}`);
};

const effortOf = (role: unknown): string | undefined => (role as { effort?: string }).effort;

test("a pi run records the identity, checkpoint and selection its backend verified, and the host allocates none of them", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ defaultEffort: "off" });
		const host = makeHost({ backends: both(pi) });
		const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.equal(ran.error, undefined);
		assert.deepEqual(pi.starts[0]!.session, { kind: "new", intent: { kind: "new" } }, "a new pi run carries no id the host invented");
		assert.equal(effortOf(pi.starts[0]!.role), undefined, "a first call that names no effort leaves the child its own default");
		assert.deepEqual(host.entries(), [
			{
				run: "run-1",
				role: "implement",
				backend: "pi",
				hostSessionId: "host-1",
				session: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" },
				selection: { model: PI_MODEL, effort: "off" },
			},
		]);
		noClaudeResume("a settled pi run", ran.text, JSON.stringify(ran.details));
		assert.match(ran.text ?? "", /pi session \/sessions\/pi-1\.jsonl\]$/);
	});
});

test("a pi continuation resumes the recorded reference and repeats the recorded selection, whatever the variables now say", async () => {
	await withEnv(piEnv(), async () => {
		const branch: unknown[] = [];
		const first = fakeBackend({ defaultEffort: "off" });
		await makeHost({ backends: both(first), branch }).fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.equal(first.starts.length, 1);

		// A fresh extension on the same branch is what a Pi restart leaves, and the variables have moved on since.
		await withEnv({ PI_FUSION_PI_IMPLEMENT_MODEL: "openai/gpt-5", PI_FUSION_PI_IMPLEMENT_EFFORT: "xhigh" }, async () => {
			const next = fakeBackend({ defaultEffort: "off" });
			const host = makeHost({ backends: both(next), branch });
			const ran = await host.fusion({ continue: "run-1", task: "and the tests?" });
			assert.equal(ran.error, undefined);
			const start = next.starts[0]!;
			assert.deepEqual(start.intent, { kind: "resume", ref: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" } });
			assert.deepEqual(start.session, { kind: "resume", id: "pi-1", file: "/sessions/pi-1.jsonl", at: "entry-1", intent: start.intent! });
			assert.deepEqual([start.role.model, effortOf(start.role)], [PI_MODEL, "off"], "the continuation repeats what the run ran with");
			const entry = host.entries().at(-1)!;
			// The checkpoint is the one this backend settled on; the fake numbers the runs of each of its own instances.
			assert.deepEqual(entry.session, { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" });
			assert.deepEqual(entry.selection, { model: PI_MODEL, effort: "off" });
		});
	});
});

test("a pi continuation that names only a model keeps the recorded effort, and a model id with slashes survives the round trip", async () => {
	await withEnv(piEnv(), async () => {
		const branch: unknown[] = [];
		const first = fakeBackend({ defaultEffort: "off" });
		await makeHost({ backends: both(first), branch }).fusion({ role: "implement", task: "do the thing", backend: "pi" });
		const next = fakeBackend({ defaultEffort: "off" });
		const host = makeHost({ backends: both(next), branch });
		const ran = await host.fusion({ continue: "run-1", task: "again", model: "openrouter/deepseek/deepseek-chat" });
		assert.equal(ran.error, undefined);
		assert.deepEqual([next.starts[0]!.role.model, effortOf(next.starts[0]!.role)], ["openrouter/deepseek/deepseek-chat", "off"]);
		assert.deepEqual(host.entries().at(-1)!.selection, { model: "openrouter/deepseek/deepseek-chat", effort: "off" });

		// And the record reads back as the selection it meant, so the call after it repeats the provider's own id.
		const third = fakeBackend({ defaultEffort: "off" });
		await makeHost({ backends: both(third), branch }).fusion({ continue: "run-1", task: "once more" });
		assert.equal(third.starts[0]!.role.model, "openrouter/deepseek/deepseek-chat");
	});
});

test("a first pi call that failed with an identity and no checkpoint is kept for reading and never continued", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ fail: "the provider refused the request" }] });
		const host = makeHost({ backends: both(pi) });
		const failed = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.match(failed.error ?? "", /^implement exited 1: the provider refused the request/);
		assert.deepEqual(host.entries(), [
			{
				run: "run-1",
				role: "implement",
				backend: "pi",
				hostSessionId: "host-1",
				session: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl" },
				selection: { model: PI_MODEL, effort: "medium" },
			},
		]);

		// The next process reads that record and fails closed, naming the file the transcript is in.
		const next = fakeBackend();
		const later = makeHost({ backends: both(next), branch: host.branch });
		const refused = await later.fusion({ continue: "run-1", task: "carry on" });
		assert.match(refused.error ?? "", /^run-1 ran on pi and recorded no trusted checkpoint, so it is kept for reading and not continued; its session file is \/sessions\/pi-1\.jsonl/);
		assert.equal(next.starts.length, 0, "nothing was started for a record this host will not act on");
		assert.equal(later.branch.length, 1, "and nothing was recorded over it");
	});
});

test("a refused latest pi plan blocks an implicit plan call instead of walking back to an older plan run", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{}, { fail: "the provider refused the request" }] });
		const host = makeHost({ backends: both(pi) });
		assert.equal((await host.fusion({ role: "plan", task: "agree a plan", backend: "pi" })).error, undefined);
		assert.match((await host.fusion({ role: "plan", task: "a second plan", backend: "pi", fresh: true })).error ?? "", /the provider refused the request/);
		assert.deepEqual(
			host.entries().map((data) => data.run),
			["run-1", "run-2"],
		);

		pi.script({});
		const implicit = await host.fusion({ role: "plan", task: "where were we?", backend: "pi" });
		assert.match(implicit.error ?? "", /^run-2 ran on pi and recorded no trusted checkpoint/);
		assert.equal(pi.starts.length, 2, "an implicit plan call never continues the older plan run instead");

		// Naming a fresh run is the way on, and it takes a new handle rather than the refused one.
		const fresh = await host.fusion({ role: "plan", task: "restating the plan", backend: "pi", fresh: true });
		assert.equal(fresh.error, undefined);
		assert.equal(host.entries().at(-1)!.run, "run-3");
	});
});

test("an early pi failure keeps its report, refuses continuation and requires a fresh handle for every pi role", async (t) => {
	const roles = ["plan", "implement", "ask", "security"] as const;
	const env = Object.fromEntries(roles.flatMap((role) => [[`PI_FUSION_PI_${role.toUpperCase()}_MODEL`, undefined], [`PI_FUSION_PI_${role.toUpperCase()}_EFFORT`, undefined]]));
	await withEnv(env, async () => {
		for (const role of roles) {
			const profiles = profileWith({ [role]: { enabled: true, backend: "pi", model: PI_MODEL, effort: "high" } });
			const pi = fakeBackend({ scripts: [{ fail: true, session: null, selection: null }, {}] });
			const host = makeHost({ backends: both(pi), profiles });
			t.after(() => host.shutdown());
			const first = await host.fusion({ role, task: "do the thing" });
			assert.match(first.error ?? "", new RegExp(`^${role} exited 1:`));
			assert.deepEqual(host.entries(), [{ run: "run-1", role, backend: "pi", hostSessionId: "host-1", ...(role === "ask" ? { mode: "answer" } : {}) }]);
			const refusal = /^run-1 ran on pi and recorded no verified session/;
			assert.match((await host.fusion({ continue: "run-1", task: "retry" })).error ?? "", refusal, role);
			assert.match((await host.fusion({ continue: "run-1", task: "retry", model: "openai/gpt-5" })).error ?? "", refusal, "an override cannot make the handle continuable");
			if (role === "plan") assert.match((await host.fusion({ role, task: "follow up" })).error ?? "", refusal);
			assert.equal(pi.starts.length, 1, "refused retries start no child");
			assert.equal(host.branch.length, 1, "the failure record is unchanged");
			assert.equal((await host.control({ action: "status", run: "run-1" })).details.state, "failed");
			assert.match((await host.control({ action: "wait", run: "run-1" })).text ?? "", new RegExp(`${role} exited 1:`), "the failure report remains readable");
			const message = await host.control({ action: "message", run: "run-1", message: "retry" });
			assert.match(message.text ?? "", /recorded no verified session/);
			assert.match(message.text ?? "", /start a new run without continue/);

			const next = fakeBackend();
			const restored = makeHost({ backends: both(next), branch: host.branch, profiles });
			t.after(() => restored.shutdown());
			assert.match((await restored.fusion({ continue: "run-1", task: "retry after restart" })).error ?? "", refusal);
			for (const action of ["status", "message"]) {
				const status = await restored.control({ action, run: "run-1", ...(action === "message" ? { message: "retry" } : {}) });
				assert.match(status.text ?? "", /recorded no verified session/);
				assert.match(status.text ?? "", /start a new run without continue/);
			}
			await restored.command("status run-1");
			assert.match(restored.notices.at(-1) ?? "", /recorded no verified session/);
			assert.equal(next.starts.length, 0, "a restarted host also refuses before reaching its backend");

			const again = await host.fusion({ role, task: "try again", ...(role === "plan" ? { fresh: true } : {}) });
			assert.equal(again.error, undefined);
			assert.deepEqual(pi.starts[1]!.intent, { kind: "new" });
			assert.deepEqual([pi.starts[1]!.role.model, effortOf(pi.starts[1]!.role)], [PI_MODEL, "high"], "fresh retry uses the profile, not missing role variables");
			assert.equal(host.entries().at(-1)!.run, "run-2", "the failed handle is never reused");
			assert.deepEqual(host.entries().at(-1)!.session, { backend: "pi", sessionId: "pi-2", sessionFile: "/sessions/pi-2.jsonl", checkpoint: "entry-2" });
		}
	});
});

test("a failed pi continuation records nothing, and the call after it restores the last trusted checkpoint", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{}, { fail: "the provider timed out" }, {}] });
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.match((await host.fusion({ continue: "run-1", task: "and now this" })).error ?? "", /the provider timed out/);
		assert.equal(host.branch.length, 1, "a continuation that failed leaves the record it continued as it was");
		const again = await host.fusion({ continue: "run-1", task: "once more" });
		assert.equal(again.error, undefined);
		assert.deepEqual(pi.starts[2]!.intent, { kind: "resume", ref: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" } });
		assert.deepEqual(host.entries().at(-1)!.session, { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-3" });
	});
});

test("a host branch that went back with /tree continues a pi run from the older checkpoint that branch records", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend();
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		await host.fusion({ continue: "run-1", task: "and more" });
		assert.deepEqual(
			host.entries().map((data) => data.session.checkpoint),
			["entry-1", "entry-2"],
		);
		// Going back with /tree is what leaves the older entry as the last one for the handle on the branch.
		const older = host.branch.slice(0, 1);
		const back = fakeBackend();
		const rolled = makeHost({ backends: both(back), branch: older });
		assert.equal((await rolled.fusion({ continue: "run-1", task: "from back here" })).error, undefined);
		assert.equal((back.starts[0]!.intent as { ref: { checkpoint?: string } }).ref.checkpoint, "entry-1");
	});
});

test("a forked host forks the recorded pi session, keeps the fork it verified when the call failed, and resumes it after that", async () => {
	await withEnv(piEnv(), async () => {
		const branch: unknown[] = [];
		const made = fakeBackend();
		await makeHost({ backends: both(made), branch }).fusion({ role: "implement", task: "do the thing", backend: "pi" });

		const pi = fakeBackend({ scripts: [{ fail: "the fork's first turn failed" }, {}] });
		const forked = makeHost({ backends: both(pi), branch, sessionId: "host-2" });
		const failed = await forked.fusion({ continue: "run-1", task: "carry on in the fork" });
		assert.match(failed.error ?? "", /the fork's first turn failed/);
		assert.deepEqual(pi.starts[0]!.intent, { kind: "fork", from: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" } });
		assert.deepEqual(pi.starts[0]!.session, { kind: "fork", from: "pi-1", file: "/sessions/pi-1.jsonl", at: "entry-1", intent: pi.starts[0]!.intent! });
		assert.deepEqual(forked.entries().at(-1), {
			run: "run-1",
			role: "implement",
			backend: "pi",
			hostSessionId: "host-2",
			// The fork the child made and the point it forked at, never the tip the failed call left.
			session: { backend: "pi", sessionId: "pi-1-fork-1", sessionFile: "/sessions/pi-1-fork-1.jsonl", checkpoint: "entry-1" },
			selection: { model: PI_MODEL, effort: "medium" },
		});

		// The fork exists now, so the next call in this host resumes it rather than forking the source again.
		const next = await forked.fusion({ continue: "run-1", task: "and now finish it" });
		assert.equal(next.error, undefined);
		assert.deepEqual(pi.starts[1]!.intent, { kind: "resume", ref: { backend: "pi", sessionId: "pi-1-fork-1", sessionFile: "/sessions/pi-1-fork-1.jsonl", checkpoint: "entry-1" } });
		assert.deepEqual(forked.entries().at(-1)!.session, { backend: "pi", sessionId: "pi-1-fork-1", sessionFile: "/sessions/pi-1-fork-1.jsonl", checkpoint: "entry-2" });
	});
});

test("a pi fork that failed before the child reported one leaves the record it forked from untouched", async () => {
	await withEnv(piEnv(), async () => {
		const branch: unknown[] = [];
		const made = fakeBackend();
		await makeHost({ backends: both(made), branch }).fusion({ role: "implement", task: "do the thing", backend: "pi" });
		const before = JSON.stringify(branch);

		const pi = fakeBackend({ scripts: [{ fail: "the fork never started", session: null, selection: null }] });
		const forked = makeHost({ backends: both(pi), branch, sessionId: "host-2" });
		assert.match((await forked.fusion({ continue: "run-1", task: "in the fork" })).error ?? "", /the fork never started/);
		assert.equal(JSON.stringify(branch), before, "nothing was verified, so the source record stays authoritative");
		const again = fakeBackend();
		await makeHost({ backends: both(again), branch, sessionId: "host-2" }).fusion({ continue: "run-1", task: "try the fork again" });
		assert.equal((again.starts[0]!.intent as SessionIntent).kind, "fork", "the next call forks the source session again");
	});
});

/**
 * The outcome shapes a pi run is failed for. `says` is the postcondition the host names the run by; a script whose
 * child also failed is reported by that failure instead, and the postcondition's only trace is the entry it refused.
 */
const INVALID: Array<{ what: string; script: FakeScript; says?: RegExp; continued?: boolean; forked?: boolean }> = [
	{ what: "a settled call that reported no session", script: { session: null }, says: /succeeded without reporting the session it ran in/ },
	{ what: "a settled call with no checkpoint", script: { checkpoint: null }, says: /succeeded without reporting the checkpoint its session settled on/ },
	{ what: "a settled call with no selection", script: { selection: null }, says: /succeeded without reporting the model and effort it ran with/ },
	{
		what: "an outcome carrying another backend's reference",
		script: { session: { backend: "claude", sessionId: "s-1", checkpoint: "m-1" } },
		says: /reported a session reference without a pi session id and session file/,
	},
	{
		what: "a resume that reported another session id",
		script: { session: { backend: "pi", sessionId: "pi-other", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-9" } },
		says: /resumed one session and reported another/,
		continued: true,
	},
	{
		what: "a resume that reported another session file",
		script: { session: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/elsewhere.jsonl", checkpoint: "entry-9" } },
		says: /resumed one session and reported another/,
		continued: true,
	},
	{
		what: "a fork that reported the session id it forked from",
		script: { newId: "pi-1", newFile: "/sessions/forked.jsonl" },
		says: /forked its session and reported the session it forked from/,
		forked: true,
	},
	{
		what: "a fork that reported the session file it forked from",
		script: { newId: "pi-forked", newFile: "/sessions/pi-1.jsonl" },
		says: /forked its session and reported the session it forked from/,
		forked: true,
	},
	{
		what: "a fork that failed at another checkpoint than the one it forked at",
		script: { fail: true, newId: "pi-forked", checkpoint: "entry-later" },
		forked: true,
	},
	{
		what: "a fork that failed without its fork point",
		script: { fail: true, newId: "pi-forked", checkpoint: null },
		forked: true,
	},
	{
		what: "a first call that failed and claimed a trusted checkpoint",
		script: { fail: true, checkpoint: "entry-9" },
	},
];

test("an outcome that names a session the run cannot have had fails the run and records nothing over what the branch holds", async () => {
	for (const { what, script, says, continued, forked } of INVALID) {
		await withEnv(piEnv(), async () => {
			const branch: unknown[] = [];
			const started = continued || forked;
			if (started) {
				const made = fakeBackend();
				await makeHost({ backends: both(made), branch }).fusion({ role: "implement", task: "do the thing", backend: "pi" });
			}
			const before = JSON.stringify(branch);
			const pi = fakeBackend({ scripts: [script] });
			const host = makeHost({ backends: both(pi), branch, ...(forked ? { sessionId: "host-2" } : {}) });
			const ran = started ? await host.fusion({ continue: "run-1", task: "carry on" }) : await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
			// A child that failed on its own is reported by its own failure; the postcondition then decides only that
			// nothing is written, which is what a valid failed fork does write and this one does not.
			if (script.fail) assert.match(ran.error ?? "", /^implement exited 1: /, what);
			else {
				assert.match(ran.error ?? "", /invalid session postcondition: run-1 /, what);
				assert.match(ran.error ?? "", says!, what);
			}
			assert.equal(JSON.stringify(branch), before, `${what} recorded something`);
		});
	}
});

test("a run whose outcome was refused offers that identity to nothing: not a continuation, not the history", async () => {
	const dir = tempDir("invalid-history");
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const pi = fakeBackend({ scripts: [{ session: { backend: "pi", sessionId: "pi-ghost", sessionFile: "/sessions/pi-ghost.jsonl" } }] });
		const host = makeHost({ backends: both(pi), sessionFile: path.join(dir, "host-1.jsonl") });
		const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.match(ran.error ?? "", /invalid session postcondition: run-1 succeeded without reporting the checkpoint its session settled on/);
		assert.deepEqual(host.entries(), [], "the branch holds nothing for a run whose outcome was refused");
		const held = new History(dir).load("host-1").records.at(-1)!;
		assert.equal(held.handle, "run-1");
		assert.equal(held.ref, undefined, "the history keeps no identity the host refused to record");
		assert.equal(held.selection, undefined);
		// And the handle names no run a later call can continue: the branch never recorded one.
		const again = await host.fusion({ continue: "run-1", task: "carry on" });
		assert.equal(again.error, "unknown run run-1; the runs on this branch are none");
	});
});

test("a backend that throws instead of reporting an outcome fails the run and records nothing", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ throws: "the backend could not start a child" }] });
		const host = makeHost({ backends: both(pi) });
		const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.equal(ran.error, "the backend could not start a child");
		assert.deepEqual(host.entries(), [], "a backend that threw reported no outcome, so there was nothing to record");
		const status = await host.control({ action: "status", run: "run-1" });
		assert.match(status.text ?? "", /^run-1 · implement · deepseek\/deepseek-chat · failed/);
	});
});

test("each backend has its own latest plan run, and a refused one on one backend leaves the other's alone", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend();
		const claude = fakeBackend({ name: "claude" });
		const host = makeHost({ backends: both(pi, claude) });
		assert.equal((await host.fusion({ role: "plan", task: "plan on pi", backend: "pi" })).error, undefined);
		assert.equal((await host.fusion({ role: "plan", task: "plan on claude", backend: "claude" })).error, undefined);
		assert.deepEqual(
			host.entries().map((data) => [data.run, data.backend]),
			[
				["run-1", "pi"],
				["run-2", "claude"],
			],
		);

		// An implicit plan call continues the latest plan of the backend it routes to, and never the other's.
		assert.equal((await host.fusion({ role: "plan", task: "where were we on pi?", backend: "pi" })).error, undefined);
		assert.equal((await host.fusion({ role: "plan", task: "where were we on claude?", backend: "claude" })).error, undefined);
		assert.deepEqual(pi.starts[1]!.intent, { kind: "resume", ref: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" } });
		assert.deepEqual(claude.starts[1]!.intent, { kind: "resume", ref: { backend: "claude", sessionId: "c-1", checkpoint: "m-1" } });
		assert.deepEqual(
			host.entries().map((data) => data.run),
			["run-1", "run-2", "run-1", "run-2"],
		);

		// A pi plan run this host will not continue stops the pi call and leaves the claude plan run reachable.
		pi.script({ fail: "the provider refused the request" });
		assert.match((await host.fusion({ role: "plan", task: "a new pi plan", backend: "pi", fresh: true })).error ?? "", /the provider refused/);
		assert.match((await host.fusion({ role: "plan", task: "carry on", backend: "pi" })).error ?? "", /^run-3 ran on pi and recorded no trusted checkpoint/);
		assert.equal((await host.fusion({ role: "plan", task: "carry on there", backend: "claude" })).error, undefined);
		assert.equal(host.entries().at(-1)!.run, "run-2");
	});
});

test("question and continuation instructions follow the invoking tool pair, while either control can manage the run", async () => {
	for (const tool of ["fusion", "claude"]) {
		const control = tool === "fusion" ? "fusion_control" : "claude_control";
		const other = tool === "fusion" ? "claude_control" : "fusion_control";
		const backend = fakeBackend({ name: "claude", scripts: [{ questions: ["Which name?"], pending: true }] });
		const host = makeHost({ backends: { claude: backend.backend } });
		try {
			const waiting = await host.call(tool, { role: "implement", task: "the change" });
			assert.match(waiting.text ?? "", new RegExp(`answer with ${control} message`));
			assert.equal(waiting.details.control, control, "background notices and cards keep the run's tool pair");
			const active = await host.call(tool, { continue: "run-1", task: "more" });
			assert.match(active.error ?? "", new RegExp(`message with ${control} message, or wait for it with ${control} wait`));
			const waited = await host.call(other, { action: "wait", run: "run-1" });
			assert.match(waited.text ?? "", new RegExp(`answer with ${other} message`), "a control reply uses the control that was called");
			await host.call(other, { action: "message", run: "run-1", message: "use small-name" });
			const start = await backend.started();
			await until("the question to be answered", () => start.answers.length === 1);
			assert.deepEqual(start.answers, ["use small-name"], "the alias changes no question routing");
			start.release();
			await ended(host, "run-1");
			for (const name of [control, other]) {
				const reply = await host.call(name, { action: "message", run: "run-1", message: "follow up" });
				const nextTool = name === "claude_control" ? "claude" : "fusion";
				assert.match(reply.text ?? "", new RegExp(`continue the run with ${nextTool} and continue run-1`));
			}
			await host.call(tool, { role: "ask", task: "the question", background: true });
			await until("the background question notice", () => host.sent.some(([message]) => String(message.content).includes("run-2 (ask) asks:")));
			const notice = host.sent.find(([message]) => String(message.content).includes("run-2 (ask) asks:"))![0];
			assert.match(notice.content, new RegExp(`answer with ${control} message`));
			assert.equal(notice.details.control, control);
		} finally {
			await host.shutdown();
		}
	}
});

test("plan handoff, blocked handoff and context-cap instructions name the tool that was called", async () => {
	for (const tool of ["fusion", "claude"]) {
		const backend = fakeBackend({ name: "claude", scripts: [{ text: "agreed plan", contextTokens: 900, contextWindow: 1_000 }, {}, {}] });
		const host = makeHost({ backends: { claude: backend.backend } });
		try {
			await host.call(tool, { role: "plan", task: "plan it" });
			const original = host.branch[0];
			const handed = await host.call(tool, { role: "plan", task: "next question" });
			assert.match(handed.text ?? "", new RegExp(`call ${tool} with continue run-1`));
			const continued = await host.call(tool, { continue: "run-1", task: "use the earlier reasoning" });
			assert.match(continued.text ?? "", new RegExp(`call ${tool} with role plan and fresh true`));
			const restarted = makeHost({ branch: [original], backends: { claude: backend.backend } });
			try {
				const blocked = await restarted.call(tool, { role: "plan", task: "another question" });
				assert.match(blocked.error ?? "", new RegExp(`Call ${tool} with role plan and fresh true`));
			} finally {
				await restarted.shutdown();
			}
		} finally {
			await host.shutdown();
		}
	}
});

test("a pi plan handoff starts a new handle on the same backend with a fresh session, on the model and level the plan run ran with", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ defaultEffort: "off", scripts: [{ text: "## Plan\n1. do the thing", contextTokens: 900, contextWindow: 1_000 }] });
		const host = makeHost({ backends: both(pi) });
		assert.equal((await host.fusion({ role: "plan", task: "agree a plan", backend: "pi" })).error, undefined);
		assert.deepEqual(host.entries()[0]!.selection, { model: PI_MODEL, effort: "off" });

		// The planner's model and the level it ran at go to the fresh run together, whatever is configured by then: a level
		// chosen for another model may be one this model does not offer.
		pi.script({ contextTokens: 10, contextWindow: 1_000 });
		const handed = await host.fusion({ role: "plan", task: "and the next step?", backend: "pi" });
		assert.equal(handed.error, undefined);
		assert.match(handed.text ?? "", /^run-2 is a fresh plan run: run-1's context had reached 90% of its window/);
		const fresh = pi.starts[1]!;
		assert.deepEqual(fresh.intent, { kind: "new" }, "a handoff starts a new run rather than continuing the old session");
		assert.deepEqual(fresh.session, { kind: "new", intent: { kind: "new" } });
		assert.deepEqual([fresh.role.model, effortOf(fresh.role)], [PI_MODEL, "off"]);
		assert.match(fresh.prompt, /## Plan\n1\. do the thing/, "the fresh run carries the replaced run's report as the plan so far");
		assert.match(fresh.prompt, /and the next step\?/);
		const entry = host.entries().at(-1)!;
		assert.equal(entry.run, "run-2");
		assert.deepEqual(entry.selection, { model: PI_MODEL, effort: "off" });
		assert.deepEqual(entry.session, { backend: "pi", sessionId: "pi-2", sessionFile: "/sessions/pi-2.jsonl", checkpoint: "entry-2" });
		// A deliberately fresh plan is the one that takes the configured defaults rather than the planner's.
		pi.script({});
		assert.equal((await host.fusion({ role: "plan", task: "start over", backend: "pi", fresh: true, effort: "high" })).error, undefined);
		assert.deepEqual([pi.starts[2]!.role.model, effortOf(pi.starts[2]!.role)], [PI_MODEL, "high"]);
	});
});

test("the single writer slot is shared across backends in both directions, and ask runs go next to it", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }, {}] });
		const claude = fakeBackend({ name: "claude" });
		const host = makeHost({ backends: both(pi, claude) });
		assert.equal((await host.fusion({ role: "implement", task: "long pi work", backend: "pi", background: true })).text, "run-1 started in the background; you get the report when it ends");
		const writing = await pi.started();
		const refused = await host.fusion({ role: "implement", task: "other work", backend: "claude" });
		assert.equal(refused.error, "run-1 (implement) is still active; wait for it, message it or cancel it with fusion_control before you start or continue another run that can change files");
		assert.equal(claude.starts.length, 0, "the claude child never started");
		// A read-only run is not a writer, whichever backend it goes to.
		assert.equal((await host.fusion({ role: "ask", task: "where is x?", backend: "claude" })).error, undefined);
		assert.equal((await host.fusion({ role: "ask", task: "and y?", backend: "pi" })).error, undefined);
		writing.release();
		assert.match(await ended(host, "run-1"), /^run-1 \(implement\) done\./);

		// And the other way round: a claude writer keeps a pi writer out.
		claude.script({ pending: true });
		await host.fusion({ role: "implement", task: "long claude work", background: true });
		const other = await claude.started(2);
		const blocked = await host.fusion({ role: "implement", task: "pi work", backend: "pi" });
		assert.match(blocked.error ?? "", /^run-4 \(implement\) is still active; wait for it/);
		other.release();
		assert.match(await ended(host, "run-4"), /^run-4 \(implement\) done\./);
	});
});

test("a pi run that waits for an answer keeps the writer slot, takes one answer and then goes on", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ questions: ["Which name should the flag take?"] }] });
		const claude = fakeBackend({ name: "claude" });
		const host = makeHost({ backends: both(pi, claude) });
		const asked = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.match(asked.text ?? "", /^run-1 \(implement\) asks:\n\nWhich name should the flag take\?/);
		assert.equal(asked.details.state, "waiting");
		const blocked = await host.fusion({ role: "implement", task: "something else", backend: "claude" });
		assert.match(blocked.error ?? "", /^run-1 \(implement\) is still active/);

		// One answer reaches the child: the user's editor is open while the host answers, and whoever is second is told.
		const answering = host.command("answer run-1");
		await until("the answer editor", () => host.editors.length > 0);
		assert.equal(host.editors[0]!.title, "Answer run-1: Which name should the flag take?");
		const sent = await host.control({ action: "message", run: "run-1", message: "call it --strict" });
		assert.equal(sent.text, "answer sent to run-1; the child goes on");
		host.closeEditor("call it --loose");
		await answering;
		assert.deepEqual(host.notices, ["run-1's question was already answered by the host: call it --strict; your answer was not sent"]);
		// The wait is what says the run has finished writing: its entry lands after the state turns done.
		assert.match(await ended(host, "run-1"), /^run-1 \(implement\) done\./);
		assert.deepEqual(pi.starts[0]!.answers, ["call it --strict"], "the child took exactly one answer");
		assert.equal(host.entries().length, 1);
	});
});

test("a message to a running pi child is a steer, and cancelling a pending one records the handle and nothing else", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }] });
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		const start = await pi.started();
		const steered = await host.control({ action: "message", run: "run-1", message: "also update the README" });
		assert.equal(steered.text, "steer sent to run-1; the child reads it when it next takes input");
		assert.equal(await start.nextSteer(), "also update the README");
		const cancelled = await host.control({ action: "cancel", run: "run-1" });
		assert.equal(cancelled.text, "run-1 cancelled");
		assert.deepEqual(host.entries(), [{ run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1" }], "a cancel before any identity records the handle alone");
		assert.deepEqual(host.sent, [], "a cancelled run sends no notice");
	});
});

/** The fixed line a backend may put on a cancelled run's outcome to say what its own ending left for a person. */
const CLEANUP_WARNING = "cleaning up needs attention: leftovers; this call's storage is left behind";

/** How often one text holds another, so a line composed once is shown to be appended once and not twice. */
const times = (text: string, needle: string): number => text.split(needle).length - 1;

/** The outcome a Pi backend returns for a run it was told to stop after its cleanup left something behind. */
const CLEANUP_ABORT = { cleanupNotice: CLEANUP_WARNING, activity: CLEANUP_WARNING };

/** The whole run as the monitor serves it, which is the store the extension fills read back over its own api. */
async function monitorFailure(host: ReturnType<typeof makeHost>, handle: string): Promise<{ failure?: unknown; activity?: unknown }> {
	host.notices.length = 0;
	await host.command("dashboard");
	const url = host.notices.map((text) => /^fusion dashboard: (\S+)$/.exec(text)?.[1]).find(Boolean);
	assert.ok(url, `the dashboard did not report its url: ${host.notices.join("\n")}`);
	try {
		const runs = (await payload(`${url}api/runs`)).runs as Array<{ id: string; handle?: string }>;
		const run = runs.find((entry) => entry.handle === handle);
		assert.ok(run, `no run ${handle} in the monitor`);
		return (await payload(`${url}api/runs/${run.id}`)) as { failure?: unknown; activity?: unknown };
	} finally {
		await host.command("dashboard stop");
	}
}

test("a cancelled run carries its backend's own warning about what the ending left, once, wherever that run is read", async () => {
	const dir = tempDir("pi-cancel-warning");
	const sessionFile = path.join(dir, "host-1.jsonl");
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const pi = fakeBackend({ scripts: [{ pending: true, onAbort: CLEANUP_ABORT }] });
		const host = makeHost({ backends: both(pi), branch: [], sessionFile });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		await pi.started();

		// The host cancelled this one itself, so the reply to that call is the only place it hears the run's end.
		const reply = (await host.control({ action: "cancel", run: "run-1" })).text ?? "";
		assert.equal(reply, `run-1 cancelled; ${CLEANUP_WARNING}`);
		assert.equal(times(reply, CLEANUP_WARNING), 1, `the cancel reply says it twice: ${reply}`);

		// The failure is composed once, and every surface that shows a failure shows that one text: the report a wait
		// hands back, the record the history keeps and the run the monitor serves.
		const failure = `implement cancelled; ${CLEANUP_WARNING}`;
		const report = await ended(host, "run-1");
		assert.match(report, new RegExp(`^run-1 \\(implement\\) cancelled\\.\n\n${failure}\n\n\\[run-1 · implement · `));
		assert.equal(times(report, CLEANUP_WARNING), 1, `the wait report says it twice: ${report}`);
		const held = new History(dir).load("host-1").records.at(-1)!;
		assert.equal(held.failure, failure, "the history keeps the once-composed failure and composes nothing of its own");
		assert.equal(times(held.failure ?? "", CLEANUP_WARNING), 1);

		// The status of a run that has ended carries no failure text at all, and so no copy of the warning either.
		const status = (await host.control({ action: "status", run: "run-1" })).text ?? "";
		assert.equal(times(status, CLEANUP_WARNING), 0, `a status reply shows no failure, so it shows no warning: ${status}`);
		assert.deepEqual(host.sent, [], "a run the host cancelled itself still sends no notice");

		// And the monitor: once in the failure, and not a second time as the line the run was on. This backend mirrors
		// the notice into its outcome's activity, as the Pi one does for a cancelled run, so without the host asking
		// for that copy to go the same sentence would stand beside the failure in the run's own card.
		const monitored = await monitorFailure(host, "run-1");
		assert.equal(monitored.failure, failure);
		assert.equal(times(String(monitored.failure ?? ""), CLEANUP_WARNING), 1, `the monitor's failure says it twice: ${monitored.failure}`);
		assert.equal(monitored.activity, undefined, "the mirrored line is gone from the monitor rather than repeating the failure");
	});
});

test("the user's own cancel says what the ending left too, and a cancellation that left nothing reads as it always did", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true, onAbort: CLEANUP_ABORT }] });
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		await pi.started();
		await host.command("cancel run-1");
		const shown = host.notified.at(-1);
		assert.deepEqual(shown, { text: `run-1 cancelled; ${CLEANUP_WARNING}`, level: "warning" }, "a cancel that left something behind is shown as a warning");
		assert.equal(times(shown?.text ?? "", CLEANUP_WARNING), 1, `the notice says it twice: ${shown?.text}`);
		// The user cancelled it, so the host still gets the end notice, carrying the same failure and one copy of it.
		await until("the completion notice", () => host.sent.length > 0);
		const notice = host.sent[0]![0].content as string;
		assert.match(notice, new RegExp(`^Background run run-1 \\(implement\\) cancelled\\.\n\nimplement cancelled by the user; ${CLEANUP_WARNING}\n\n\\[run-1 · implement · `));
		assert.equal(times(notice, CLEANUP_WARNING), 1, `the background notice says it twice: ${notice}`);
	});

	// A backend with nothing to say leaves every cancellation string exactly as it was, on either backend.
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }] });
		const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }] });
		const host = makeHost({ backends: both(pi, claude) });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		await pi.started();
		assert.equal((await host.control({ action: "cancel", run: "run-1" })).text, "run-1 cancelled");

		await host.fusion({ role: "implement", task: "more long work", backend: "claude", background: true });
		await claude.started();
		await host.command("cancel run-2");
		assert.deepEqual(host.notified.at(-1), { text: "run-2 cancelled", level: "info" });
		await until("the completion notice", () => host.sent.length > 0);
		const notice = host.sent[0]![0].content as string;
		assert.match(notice, /^Background run run-2 \(implement\) cancelled\.\n\nimplement cancelled by the user\n\n\[run-2 · implement · /);
	});
});

test("a pi fork cancelled after the child reported it records that fork and the point it forked at", async () => {
	await withEnv(piEnv(), async () => {
		const branch: unknown[] = [];
		const made = fakeBackend();
		await makeHost({ backends: both(made), branch }).fusion({ role: "implement", task: "do the thing", backend: "pi" });
		const pi = fakeBackend({
			scripts: [
				{
					pending: true,
					// The child made the fork before the user stopped it, so the outcome still carries what it verified.
					onAbort: { session: { backend: "pi", sessionId: "pi-forked", sessionFile: "/sessions/pi-forked.jsonl", checkpoint: "entry-1" }, selection: { model: PI_MODEL, effort: "medium" } },
				},
				{},
			],
		});
		const host = makeHost({ backends: both(pi), branch, sessionId: "host-2" });
		await host.fusion({ continue: "run-1", task: "carry on in the fork", background: true });
		await pi.started();
		assert.equal((await host.control({ action: "cancel", run: "run-1" })).text, "run-1 cancelled");
		assert.deepEqual(host.entries().at(-1), {
			run: "run-1",
			role: "implement",
			backend: "pi",
			hostSessionId: "host-2",
			session: { backend: "pi", sessionId: "pi-forked", sessionFile: "/sessions/pi-forked.jsonl", checkpoint: "entry-1" },
			selection: { model: PI_MODEL, effort: "medium" },
		});
		const again = await host.fusion({ continue: "run-1", task: "now finish it" });
		assert.equal(again.error, undefined);
		assert.deepEqual(pi.starts[1]!.intent, { kind: "resume", ref: { backend: "pi", sessionId: "pi-forked", sessionFile: "/sessions/pi-forked.jsonl", checkpoint: "entry-1" } });
	});
});

test("/tree is refused while a pi run is unfinished, and the session shutdown stops it", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }] });
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		await pi.started();
		assert.deepEqual(await host.tree(), { cancel: true });
		assert.match(host.notices.at(-1) ?? "", /^\/tree is blocked while fusion runs are active: run-1 \(implement\)\./);
		await host.shutdown();
		assert.match((await host.control({ action: "status", run: "run-1" })).text ?? "", /^run-1 · implement · deepseek\/deepseek-chat · cancelled/);
		assert.deepEqual(await host.tree(), undefined, "once every run has finished, /tree goes through");
	});
});

test("a background pi run reports through a message, and a foreground one returns its report", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true, text: "## Changed\nbar.ts" }, { text: "## Changed\nbaz.ts" }] });
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		(await pi.started()).release();
		await until("the completion notice", () => host.sent.length > 0);
		const [message, options] = host.sent[0]!;
		assert.equal(message.customType, "pi-fusion-run");
		assert.match(message.content, /^Background run run-1 \(implement\) done\.\n\n## Changed\nbar\.ts\n\n\[run-1 · implement · deepseek\/deepseek-chat · /);
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		noClaudeResume("a background pi report", message.content);
		const foreground = await host.fusion({ role: "implement", task: "quick work", backend: "pi" });
		assert.match(foreground.text ?? "", /^## Changed\nbaz\.ts\n\n\[run-2 · implement · /);
		assert.equal(host.sent.length, 1, "a foreground run's report is the tool result, not a message");
	});
});

test("both control names act on a pi run, and neither offers a claude resume for it", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true, sessionId: "pi-scalar" }, {}] });
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		const start = await pi.started();
		for (const tool of ["claude_control", "fusion_control"]) {
			const status = await host.call(tool, { action: "status", run: "run-1" });
			assert.match(status.text ?? "", /^run-1 · implement · deepseek\/deepseek-chat · running · background ·/, tool);
			noClaudeResume(`${tool} status of a running pi run`, status.text, JSON.stringify(status.details));
		}
		assert.equal((await host.claudeControl({ action: "message", run: "run-1", message: "a steer" })).text, "steer sent to run-1; the child reads it when it next takes input");
		assert.equal(await start.nextSteer(), "a steer");
		start.release();
		const waited = await host.claudeControl({ action: "wait", run: "run-1" });
		assert.match(waited.text ?? "", /^run-1 \(implement\) done\./);
		noClaudeResume("a pi run's report through claude_control wait", waited.text);
		assert.match(waited.text ?? "", /pi session \/sessions\/pi-1\.jsonl\]/);

		// The scalar id the child reported is a diagnostic: no record, no resume command, no host detail.
		assert.equal(host.entries()[0]!.sessionId, undefined);
		assert.ok(!/pi-scalar/.test(waited.text ?? ""), waited.text);
		for (const tool of ["fusion_control", "claude_control"]) {
			const ended = await host.call(tool, { action: "message", run: "run-1", message: "too late" });
			assert.match(ended.text ?? "", /continue the run with fusion and continue run-1/, tool);
		}
	});
});

test("a restarted Pi process still names a pi run's backend, reference and selection, and offers no claude resume for it", async () => {
	const dir = tempDir("pi-history");
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const branch: unknown[] = [];
		const sessionFile = path.join(dir, "host-1.jsonl");
		const first = fakeBackend({ scripts: [{ sessionId: "pi-scalar", text: "## Changed\nfoo.ts" }] });
		await makeHost({ backends: both(first), branch, sessionFile }).fusion({ role: "implement", task: "do the thing", backend: "pi" });
		const held = new History(dir).load("host-1").records.at(-1)!;
		assert.equal(held.backend, "pi");
		assert.deepEqual(held.ref, { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" });
		assert.deepEqual(held.selection, { model: PI_MODEL, effort: "medium" });
		assert.equal(held.sessionId, undefined, "the scalar id a claude reader would resume is not a pi run's to keep");

		// A later Pi process on the same host session reads that file and shows the run it never started.
		const next = fakeBackend();
		const later = makeHost({ backends: both(next), branch, sessionFile });
		for (const tool of ["claude_control", "fusion_control"]) {
			const status = await later.call(tool, { action: "status", run: "run-1" });
			assert.match(status.text ?? "", /^run-1 \(implement\) ran in an earlier Pi process: done, /, tool);
			assert.match(status.text ?? "", /continue it with fusion and continue run-1/, tool);
			noClaudeResume(`${tool} status of a restored pi run`, status.text);
			assert.ok(!/pi-scalar/.test(status.text ?? ""), status.text);
		}
		later.notices.length = 0;
		await later.command("status");
		assert.match(later.notices[0] ?? "", /^run-1 · implement · deepseek\/deepseek-chat · done · earlier Pi process$/m);
		noClaudeResume("/fusion status after a restart", ...later.notices);

		// And the run is continued from what the branch recorded, on the backend the record names.
		assert.equal((await later.fusion({ continue: "run-1", task: "carry on" })).error, undefined);
		assert.deepEqual(next.starts[0]!.intent, { kind: "resume", ref: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" } });
		assert.deepEqual([next.starts[0]!.role.model, effortOf(next.starts[0]!.role)], [PI_MODEL, "medium"]);
	});
});

test("a record this host cannot read keeps its handle and is refused rather than run on whatever backend is here", async () => {
	await withEnv(piEnv(), async () => {
		const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: "pi-fusion", data });
		const branch: unknown[] = [
			entry({ run: "run-1", role: "implement", backend: "elsewhere", hostSessionId: "host-1" }),
			entry({ run: "run-2", role: "implement", backend: "pi", hostSessionId: "host-1", sessionId: "pi-loose", checkpoint: "entry-1" }),
		];
		const pi = fakeBackend();
		const host = makeHost({ backends: both(pi), branch });
		const unknown = await host.fusion({ continue: "run-1", task: "carry on" });
		assert.match(unknown.error ?? "", /^run-1 was recorded by backend "elsewhere", which this pi-fusion does not know; it cannot be continued, so start a new run$/);
		const loose = await host.fusion({ continue: "run-2", task: "carry on" });
		assert.match(loose.error ?? "", /^run-2 records its pi session in sessionId, checkpoint rather than in a session reference; it cannot be continued, so start a new run$/);
		assert.equal(pi.starts.length, 0, "neither record started a child");

		// Both handles stay taken, so a new run never takes the name of a run this host cannot read.
		assert.equal((await host.fusion({ role: "implement", task: "a new run", backend: "pi" })).error, undefined);
		assert.equal(host.entries().at(-1)!.run, "run-3");
	});
});

const entryOf = (data: Record<string, unknown>) => ({ type: "custom", customType: "pi-fusion", data });

/** A run as an earlier Pi process left it in the history, for a test that writes that file itself. */
const heldRecord = (over: Partial<HistoryRecord> = {}): HistoryRecord => ({
	id: "id-1",
	handle: "run-1",
	role: "implement",
	model: PI_MODEL,
	hostSessionId: "host-1",
	cwd: repoRoot,
	origin: "tool",
	state: "done",
	startedAt: 1_000,
	endedAt: 2_000,
	prompt: "do the thing",
	report: "## Changed\nfoo.ts",
	files: [{ path: "foo.ts", status: "M" }],
	filesTotal: 1,
	backend: "pi",
	...over,
});

test("a claude outcome that knows its session only as a reference fails the run and records nothing", async () => {
	const claude = fakeBackend({ name: "claude", scripts: [{ sessionId: null, session: { backend: "claude", sessionId: "c-9", checkpoint: "m-9" } }, {}] });
	const host = makeHost({ backends: { claude: claude.backend } });
	const ran = await host.fusion({ role: "implement", task: "do the thing" });
	assert.match(ran.error ?? "", /^invalid session postcondition: run-1 reported claude session c-9 in a session reference and no session id beside it/);
	assert.deepEqual(host.entries(), [], "an outcome the host refused writes nothing");
	// The handle stays taken by the run this process started, so the next run is a new one.
	assert.equal((await host.fusion({ role: "implement", task: "again" })).error, undefined);
	assert.equal(host.entries().at(-1)!.run, "run-2");
});

test("a claude entry that keeps its identity only in a session reference is refused by the tools and keeps its handle", async () => {
	const claude = fakeBackend({ name: "claude" });
	const branch: unknown[] = [entryOf({ run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", session: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } })];
	const host = makeHost({ backends: { claude: claude.backend }, branch });
	for (const tool of ["fusion", "claude"]) {
		const refused = await host.call(tool, { continue: "run-1", task: "carry on" });
		assert.match(refused.error ?? "", /^run-1 records its claude session s-1 in a session reference and not in the session id this format carries/, tool);
	}
	assert.equal(claude.starts.length, 0, "nothing was started over a record this host will not act on");
	assert.equal((await host.fusion({ role: "implement", task: "a new run" })).error, undefined);
	assert.equal(host.entries().at(-1)!.run, "run-2", "the refused record keeps its handle");
});

test("a backend registered under another backend's name is refused before it can map a session, run a child or record one", () => {
	const wrong = fakeBackend({ name: "claude" });
	const branch: unknown[] = [];
	assert.throws(
		() => makeHost({ backends: { pi: wrong.backend }, branch }),
		/^Error: pi-fusion: the backend registered as pi calls itself "claude"; a backend must be registered under its own name$/,
	);
	assert.deepEqual(wrong.sessions, [], "no intent reached it");
	assert.deepEqual(wrong.starts, [], "no child ran on it");
	assert.deepEqual(branch, [], "and nothing was recorded for it");
	// A key that is no backend of this build is refused the same way, before anything is registered.
	assert.throws(
		() => makeHost({ backends: { gemini: fakeBackend({ name: "pi" }).backend } as unknown as Partial<Record<BackendName, HostBackend>> }),
		/^Error: pi-fusion: "gemini" is not a backend this build knows; use one of claude, pi, codex$/,
	);
	// A backend registered under its own name is what the rest of this suite runs on, and it still registers.
	assert.doesNotThrow(() => makeHost({ backends: both(fakeBackend()) }));
});

test("a pi run the history kept is only this branch's run when the whole identity matches, file included", async () => {
	const dir = tempDir("pi-identity");
	const sessionFile = path.join(dir, "host-1.jsonl");
	const held = (ref: HistoryRecord["ref"]) => new History(dir).saveAll("host-1", repoRoot, [heldRecord(ref === undefined ? { state: "failed", failure: "the provider refused" } : { ref })]);
	const branchWith = (file: string) => [
		entryOf({
			run: "run-1",
			role: "implement",
			backend: "pi",
			hostSessionId: "host-1",
			session: { backend: "pi", sessionId: "pi-1", sessionFile: file, checkpoint: "entry-1" },
			selection: { model: PI_MODEL, effort: "medium" },
		}),
	];
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		// The same session id in another file is another child, and the history record is not shown as this one's.
		held({ backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/elsewhere.jsonl", checkpoint: "entry-1" });
		const other = makeHost({ backends: both(fakeBackend()), branch: branchWith("/sessions/pi-1.jsonl"), sessionFile });
		const apart = await other.control({ action: "status", run: "run-1" });
		assert.match(apart.text ?? "", /^run-1 \(implement\) ran before this Pi session started and is not active\./);
		assert.doesNotMatch(apart.text ?? "", /ran in an earlier Pi process/, "a record of another child is not this run's");
		other.notices.length = 0;
		await other.command("review run-1");
		assert.doesNotMatch(other.notices.join("\n"), /reviews run-1/, "and its work is not reviewed as this run's");

		// A history record whose identity the host refused to keep matches no trusted record either.
		held(undefined);
		const stripped = makeHost({ backends: both(fakeBackend()), branch: branchWith("/sessions/pi-1.jsonl"), sessionFile });
		const unverified = await stripped.control({ action: "status", run: "run-1" });
		assert.match(unverified.text ?? "", /^run-1 \(implement\) ran before this Pi session started and is not active\./);
		assert.doesNotMatch(unverified.text ?? "", /ran in an earlier Pi process/);

		// The whole identity matching is what makes it this run: same id, same file.
		held({ backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" });
		const same = makeHost({ backends: both(fakeBackend()), branch: branchWith("/sessions/pi-1.jsonl"), sessionFile });
		const matched = await same.control({ action: "status", run: "run-1" });
		assert.match(matched.text ?? "", /^run-1 \(implement\) ran in an earlier Pi process: done, /);
		assert.match(matched.text ?? "", /continue it with fusion and continue run-1/);
	});
});

test("a record this host will not continue says so wherever a run's next step is offered, instead of pointing at continue", async () => {
	const dir = tempDir("pi-refusal");
	const sessionFile = path.join(dir, "host-1.jsonl");
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const branch: unknown[] = [];
		const pi = fakeBackend({ scripts: [{ fail: "the provider refused the request" }] });
		const host = makeHost({ backends: both(pi), branch, sessionFile });
		assert.match((await host.fusion({ role: "implement", task: "do the thing", backend: "pi" })).error ?? "", /^implement exited 1:/);
		const refusal = /run-1 ran on pi and recorded no trusted checkpoint, so it is kept for reading and not continued; its session file is \/sessions\/pi-1\.jsonl/;

		// The run of this process has ended: a message to it says what the record allows, not "continue the run".
		const message = await host.control({ action: "message", run: "run-1", message: "one more thing" });
		assert.match(message.text ?? "", /^run-1 \(implement\) has ended: failed\. The message was not sent\./);
		assert.match(message.text ?? "", refusal);
		assert.doesNotMatch(message.text ?? "", /continue the run with/, message.text);
		assert.equal(message.details.refused, true);

		// A later Pi process reads the same record and says the same thing, through either control name and /fusion.
		const later = makeHost({ backends: both(fakeBackend()), branch, sessionFile });
		for (const tool of ["fusion_control", "claude_control"]) {
			const status = await later.call(tool, { action: "status", run: "run-1" });
			assert.match(status.text ?? "", refusal, tool);
			assert.doesNotMatch(status.text ?? "", /continue it with|Continue it with/, `${tool}: ${status.text}`);
			assert.equal(status.details.refused, true, tool);
			const sent = await later.call(tool, { action: "message", run: "run-1", message: "late" });
			assert.match(sent.text ?? "", /The message was not sent\./, tool);
			assert.match(sent.text ?? "", refusal, tool);
			assert.doesNotMatch(sent.text ?? "", /Continue it with/, tool);
		}
		later.notices.length = 0;
		await later.command("status run-1");
		assert.match(later.notices.join("\n"), refusal);
		assert.doesNotMatch(later.notices.join("\n"), /continue it with/);

		// And the attempted continuation is still refused, which is the policy these hints describe.
		assert.match((await later.fusion({ continue: "run-1", task: "carry on" })).error ?? "", refusal);
	});
});

test("a run an earlier Pi process left is offered as a continuation only while its record allows one", async () => {
	const dir = tempDir("pi-held-refusal");
	const sessionFile = path.join(dir, "host-1.jsonl");
	const branch: unknown[] = [];
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const pi = fakeBackend({ scripts: [{ fail: "the provider refused the request" }] });
		const host = makeHost({ backends: both(pi), branch, sessionFile });
		await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		// The history kept the run, and its identity matches the record, so this is the held text with the refusal in it.
		const later = makeHost({ backends: both(fakeBackend()), branch, sessionFile });
		const status = await later.control({ action: "status", run: "run-1" });
		assert.match(status.text ?? "", /^run-1 \(implement\) ran in an earlier Pi process: failed, /);
		assert.match(status.text ?? "", /ran on pi and recorded no trusted checkpoint/);
		assert.doesNotMatch(status.text ?? "", /continue it with/, status.text);
		later.notices.length = 0;
		await later.command("status run-1");
		assert.match(later.notices.join("\n"), /ran on pi and recorded no trusted checkpoint/);
		assert.doesNotMatch(later.notices.join("\n"), /continue it with/);
	});
});

test("a pi fork verified before the call failed or was cancelled keeps its identity, with no selection guessed for it", async () => {
	for (const how of ["failed", "cancelled"] as const) {
		const dir = tempDir(`pi-fork-${how}`);
		const sessionFile = path.join(dir, "host-1.jsonl");
		const branch: unknown[] = [];
		// The source ran with a selection, and the variables name another: neither may stand in for what the fork
		// never reported. The env is set the whole way through, so a guess would show up in the record.
		await withEnv({ ...piEnv({ PI_FUSION_PI_IMPLEMENT_EFFORT: "xhigh" }), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
			const made = fakeBackend();
			await makeHost({ backends: both(made), branch, sessionFile }).fusion({ role: "implement", task: "do the thing", backend: "pi" });
			assert.deepEqual((branch[0] as { data: { selection: unknown } }).data.selection, { model: PI_MODEL, effort: "xhigh" }, "the source did report what it ran with");

			// The child made the fork and then the call ended without ever reading a selection back.
			const forked = { backend: "pi" as const, sessionId: "pi-forked", sessionFile: "/sessions/pi-forked.jsonl", checkpoint: "entry-1" };
			const pi = fakeBackend({
				scripts:
					how === "failed"
						? [{ fail: "the provider dropped the connection", session: forked, selection: null }]
						: [{ pending: true, onAbort: { session: forked, selection: null } }],
			});
			const host = makeHost({ backends: both(pi), branch, sessionFile, sessionId: "host-2" });
			if (how === "failed") {
				assert.match((await host.fusion({ continue: "run-1", task: "carry on in the fork" })).error ?? "", /the provider dropped the connection/);
			} else {
				await host.fusion({ continue: "run-1", task: "carry on in the fork", background: true });
				await pi.started();
				assert.equal((await host.control({ action: "cancel", run: "run-1" })).text, "run-1 cancelled");
			}
			assert.deepEqual(
				host.entries().at(-1),
				{ run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-2", session: forked },
				`a ${how} fork keeps the child it made, and no selection is invented for it`,
			);

			// Across a restart the fork is still named, still refused, and still reforks nothing.
			const later = fakeBackend();
			const next = makeHost({ backends: both(later), branch, sessionFile, sessionId: "host-2" });
			const refusal = /^run-1 recorded no model and effort this host can repeat, so it is kept for reading and not continued against whatever is configured now; its session file is \/sessions\/pi-forked\.jsonl, and new work needs a new run \(a plan call takes fresh true\)/;
			for (const attempt of [1, 2]) {
				const again = await next.fusion({ continue: "run-1", task: "try once more" });
				assert.match(again.error ?? "", refusal, `attempt ${attempt}`);
				assert.deepEqual(later.sessions, [], `attempt ${attempt} mapped a session for a record this host refuses`);
				assert.deepEqual(later.starts, [], `attempt ${attempt} started a child for a record this host refuses`);
			}
			// A plan call of the same backend stops at it too, rather than walking back to an older plan run.
			assert.match((await next.fusion({ role: "implement", task: "and now", backend: "pi", continue: "run-1" })).error ?? "", refusal);
			// The status of the run says the same, and the history kept the child the fork made.
			const status = await next.control({ action: "status", run: "run-1" });
			assert.match(status.text ?? "", /\/sessions\/pi-forked\.jsonl/);
			assert.doesNotMatch(status.text ?? "", /continue it with|Continue it with/, status.text);
			const kept = new History(dir).load("host-2").records.at(-1)!;
			assert.deepEqual(kept.ref, forked, "the history keeps the fork the host verified");
			assert.equal(kept.selection, undefined, "and no selection the child never reported");
			// New work goes to a new handle, which is the way on the refusal names.
			assert.equal((await next.fusion({ role: "implement", task: "a new run", backend: "pi" })).error, undefined);
			assert.equal(next.entries().at(-1)!.run, "run-2");
		});
	}
});

/** What the dashboard server answers, which is how a test reads the store the extension fills. */
function payload(url: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const request = http.get(url, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on("error", reject);
	});
}

test("the monitor names a pi run by the session the host verified, and names none for an outcome it refused", async () => {
	await withEnv(piEnv(), async () => {
		const branch: unknown[] = [];
		const made = fakeBackend();
		const first = makeHost({ backends: both(made), branch });
		await first.fusion({ role: "implement", task: "do the thing", backend: "pi" });

		const forked = { backend: "pi" as const, sessionId: "pi-forked", sessionFile: "/sessions/pi-forked.jsonl", checkpoint: "entry-1" };
		const pi = fakeBackend({
			scripts: [
				// A fork that failed after the child made it: verified, with no selection ever read back.
				{ fail: "the provider dropped the connection", session: forked, selection: null },
				// And an outcome the host refuses: a settled call that named no checkpoint.
				{ checkpoint: null },
			],
		});
		const host = makeHost({ backends: both(pi), branch, sessionId: "host-2" });
		await host.fusion({ continue: "run-1", task: "carry on in the fork" });
		await host.fusion({ role: "implement", task: "and something new", backend: "pi" });
		await host.command("dashboard");
		const url = host.notices.map((text) => /^fusion dashboard: (\S+)$/.exec(text)?.[1]).find(Boolean);
		assert.ok(url, `the dashboard did not report its url: ${host.notices.join("\n")}`);
		try {
			const runs = (await payload(`${url}api/runs`)).runs as Array<{ id: string; handle?: string }>;
			const detailOf = async (handle: string) => {
				const run = runs.find((entry) => entry.handle === handle);
				assert.ok(run, `no run ${handle} in the monitor`);
				return (await payload(`${url}api/runs/${run.id}`)) as { session?: unknown; ref?: unknown };
			};
			const fork = await detailOf("run-1");
			assert.deepEqual(fork.session, { kind: "fork", backend: "pi", from: "pi-1", file: "/sessions/pi-1.jsonl", at: "entry-1" }, "the launch request names the session it forked from");
			assert.deepEqual(fork.ref, forked, "and the verified result names the child the fork made, selection or no selection");
			const refused = await detailOf("run-2");
			assert.equal(refused.ref, undefined, "an outcome the host refused to record names no session anything can open");
			assert.deepEqual(refused.session, { kind: "new", backend: "pi" });
		} finally {
			await host.command("dashboard stop");
		}
	});
});

/** The run detail the monitor serves, which is what the page reads and what a Copy button would take from it. */
const monitorDetail = async (host: ReturnType<typeof makeHost>, handle: string): Promise<{ ref?: any; session?: any; text?: any }> => {
	host.notices.length = 0;
	await host.command("dashboard");
	const url = host.notices.map((text) => /^fusion dashboard: (\S+)$/.exec(text)?.[1]).find(Boolean);
	assert.ok(url, `the dashboard did not report its url: ${host.notices.join("\n")}`);
	try {
		const runs = (await payload(`${url}api/runs`)).runs as Array<{ id: string; handle?: string }>;
		const run = runs.find((entry) => entry.handle === handle);
		assert.ok(run, `no run ${handle} in the monitor`);
		return (await payload(`${url}api/runs/${run.id}`)) as { ref?: any; session?: any; text?: any };
	} finally {
		await host.command("dashboard stop");
	}
};

test("a long pi transcript path reaches the branch, the history and the monitor as the child reported it", async () => {
	const dir = tempDir("pi-long-path");
	const sessionFile = path.join(dir, "host-1.jsonl");
	const file = `/home/asen/.pi/agent/sessions/${"a-deeply-nested-project-directory/".repeat(12)}0199c9e2-1b3a-7f00-8000-0123456789ab.jsonl`;
	assert.ok(file.length > 400 && file.length < 4_096, `the path under test is ${file.length} characters`);
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const branch: unknown[] = [];
		const pi = fakeBackend({ scripts: [{ newId: "0199c9e2-1b3a-7f00-8000-0123456789ab", newFile: file }] });
		const host = makeHost({ backends: both(pi), branch, sessionFile });
		assert.equal((await host.fusion({ role: "implement", task: "do the thing", backend: "pi" })).error, undefined);
		const ref = { backend: "pi", sessionId: "0199c9e2-1b3a-7f00-8000-0123456789ab", sessionFile: file, checkpoint: "entry-1" };
		assert.deepEqual(host.entries().at(-1)!.session, ref, "the branch entry a continuation reads is never bounded");
		assert.deepEqual(new History(dir).load("host-1").records.at(-1)!.ref, ref, "and the history keeps the same path whole");
		assert.deepEqual((await monitorDetail(host, "run-1")).ref, ref, "so the page opens the file the child wrote, not a prefix of it");

		// A later process reads that path back and continues the run with it, which a shortened one could not do.
		const next = fakeBackend();
		const later = makeHost({ backends: both(next), branch, sessionFile });
		assert.equal((await later.fusion({ continue: "run-1", task: "carry on" })).error, undefined);
		assert.deepEqual(next.starts[0]!.intent, { kind: "resume", ref });
		assert.deepEqual((await monitorDetail(later, "run-1")).ref, { ...ref, sessionFile: file, checkpoint: "entry-1" });
	});
});

/*
 * Metadata no backend in this build reports, shaped like what a credential-aware one could: paths to an auth and a
 * models file, a key, a token pair and a structured blob holding more of the same. The host composes its branch entry,
 * its history record and its monitor entry from the fields it names, so none of this may appear in any of the three.
 * What that pins is the allowlisting of the structured metadata Fusion composes, and nothing else: a prompt, a report,
 * a model id and a tool name are the run's own text and are kept as the run gave them.
 */
const PLANTED: Record<string, unknown> = {
	authPath: "/dummy/auth-DUMMYAUTHPATH.json",
	modelsPath: "/dummy/models-DUMMYMODELSPATH.json",
	apiKey: "sk-DUMMYAPIKEY-0123456789",
	access: "DUMMYACCESSTOKEN-0123456789",
	refresh: "DUMMYREFRESHTOKEN-0123456789",
	credential: { provider: "dummy", store: "/dummy/store-DUMMYSTOREPATH.json", apiKey: "sk-DUMMYNESTEDKEY-0123456789", expiresAt: 4_102_444_800_000 },
};

/** Every planted value, each unmistakable, so a match is a leak rather than a word two things happen to share. */
const PLANTED_VALUES = ["DUMMYAUTHPATH", "DUMMYMODELSPATH", "DUMMYAPIKEY", "DUMMYACCESSTOKEN", "DUMMYREFRESHTOKEN", "DUMMYSTOREPATH", "DUMMYNESTEDKEY", "sk-DUMMY"];

/**
 * A field the record does carry, planted in the same map as the fields it does not: the run's report. It is what keeps
 * the absences below from being vacuous for good rather than by inspection — if the fake ever stopped applying that map
 * to the terminal outcome, this value would not be in the persisted report and the test would fail there, instead of
 * passing on a run that planted nothing. It is also the ordinary case the promise does not touch: a report is the run's
 * own text and is recorded as the run gave it, never filtered.
 */
const PLANTED_REPORT = "planted-report-reaches-the-host";

test("an outcome carrying metadata no backend reports reaches the branch, the history and the monitor as the fields they name and nothing more", async () => {
	const dir = tempDir("pi-planted");
	const sessionFile = path.join(dir, "host-1.jsonl");
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const pi = fakeBackend({ defaultEffort: "off", scripts: [{ extra: { ...PLANTED, text: PLANTED_REPORT }, costUsd: 0.5 }] });
		const host = makeHost({ backends: both(pi), sessionFile });
		const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.equal(ran.error, undefined);
		const ref = { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" };
		const selection = { model: PI_MODEL, effort: "off" };

		// The controls first, so the absences below are absences and not an empty record: the identity, the selection, the
		// spend and the report the run really did produce are all where they belong, in all three places.
		assert.deepEqual(host.entries(), [{ run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", session: ref, selection }]);
		const held = new History(dir).load("host-1").records.at(-1)!;
		assert.deepEqual(held.ref, ref, "the history keeps the session the host validated");
		assert.deepEqual(held.selection, selection);
		assert.deepEqual(held.usage, { costUsd: 0.5, tokensIn: 10, tokensOut: 5, toolCalls: 2 });
		assert.equal(held.state, "done");
		// The report is the control that keeps every absence below honest: it is a supported field planted in the very map
		// the unknown ones were planted in, so it is in the history only because that map reached the terminal outcome.
		assert.equal(held.report, PLANTED_REPORT, "the planted report reached the history, so the map the rest was planted in was applied at all");
		const detail = await monitorDetail(host, "run-1");
		assert.deepEqual(detail.ref, ref, "and the monitor names the same session");
		assert.equal(detail.text, PLANTED_REPORT, "and the monitor shows the same report, which is the run's own text and is not filtered");
		assert.match(ran.text ?? "", new RegExp(PLANTED_REPORT), "as does what the host was told when the call returned");

		// And now the planted fields, over everything each of the three actually holds rather than the keys it was asked for.
		const historyFile = path.join(dir, "host-1.json");
		const places: Array<[string, unknown]> = [
			["the host branch entry", host.entries()],
			["the history file", JSON.parse(fs.readFileSync(historyFile, "utf8"))],
			["the monitor detail", detail],
		];
		for (const [what, value] of places) {
			const text = JSON.stringify(value);
			for (const key of Object.keys(PLANTED)) assert.ok(!text.includes(`"${key}"`), `${what} carries the planted field ${key}`);
			for (const dummy of PLANTED_VALUES) assert.ok(!text.includes(dummy), `${what} carries the planted value ${dummy}`);
		}
	});
});

test("the history keeps the session the host validated when the run returned, never one a child claimed while it worked", async () => {
	const dir = tempDir("pi-progress");
	const copy = tempDir("pi-progress-copy");
	const sessionFile = path.join(dir, "host-1.jsonl");
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const branch: unknown[] = [];
		const claimed = { backend: "pi" as const, sessionId: "pi-claimed", sessionFile: "/sessions/pi-claimed.jsonl", checkpoint: "entry-claimed" };
		const pi = fakeBackend({
			scripts: [
				{
					pending: true,
					// While it works the child claims a session and a selection the host has checked nothing about,
					// and the outcome it finally returns is another one that never goes through the progress stream.
					running: { session: claimed, selection: { model: "openai/gpt-5", effort: "max" } },
					finalProgress: false,
					newId: "pi-returned",
					newFile: "/sessions/pi-returned.jsonl",
				},
			],
		});
		const host = makeHost({ backends: both(pi), branch, sessionFile });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		const start = await pi.started();
		await until("the running run to reach the history", () => (new History(dir).load("host-1").records.at(-1)?.usage?.tokensIn ?? 0) > 0);
		const running = new History(dir).load("host-1").records.at(-1)!;
		assert.equal(running.state, "running");
		assert.equal(running.ref, undefined, "a run still going has reported no result the host has checked");
		assert.equal(running.selection, undefined);

		// A Pi process killed here leaves exactly that record. Restoring it must offer no transcript to open.
		fs.copyFileSync(path.join(dir, "host-1.json"), path.join(copy, "host-1.json"));
		await withEnv({ PI_FUSION_HISTORY_DIR: copy }, async () => {
			const killed = makeHost({ backends: both(fakeBackend()), branch: [], sessionFile, sessionId: "host-1" });
			const restored = await monitorDetail(killed, "run-1");
			assert.equal(restored.ref, undefined, "a session a child only claimed is not one a later process may open");
			const held = await killed.control({ action: "status", run: "run-1" });
			assert.match(held.text ?? "", /^run-1 \(implement\) ran in an earlier Pi process: aborted/);
			assert.ok(!/pi-claimed/.test(held.text ?? ""), held.text);
		});

		// The run returns, and what it returned is what everything keeps, without a progress update to match.
		start.release();
		assert.match(await ended(host, "run-1"), /^run-1 \(implement\) done\./);
		const returned = { backend: "pi", sessionId: "pi-returned", sessionFile: "/sessions/pi-returned.jsonl", checkpoint: "entry-1" };
		assert.deepEqual(host.entries().at(-1)!.session, returned);
		assert.deepEqual(host.entries().at(-1)!.selection, { model: PI_MODEL, effort: "medium" });
		const settled = new History(dir).load("host-1").records.at(-1)!;
		assert.deepEqual(settled.ref, returned, "the history takes the returned result, not the last progress");
		assert.deepEqual(settled.selection, { model: PI_MODEL, effort: "medium" });
		assert.deepEqual((await monitorDetail(host, "run-1")).ref, returned);

		// And a cold process reads that same returned file back.
		const cold = makeHost({ backends: both(fakeBackend()), branch: [], sessionFile, sessionId: "host-1" });
		assert.deepEqual((await monitorDetail(cold, "run-1")).ref, returned);
	});
});

test("a backend that broke, or an outcome the host refused, publishes nothing the child claimed in progress", async () => {
	const claimed = { backend: "pi" as const, sessionId: "pi-claimed", sessionFile: "/sessions/pi-claimed.jsonl", checkpoint: "entry-claimed" };
	for (const [what, script] of [
		["a backend that threw after its child reported progress", { throwsLate: "the backend broke mid-run", running: { session: claimed } }],
		["an outcome the host refused after the same progress", { running: { session: claimed }, checkpoint: null }],
	] as const) {
		const dir = tempDir("pi-unverified");
		const sessionFile = path.join(dir, "host-1.jsonl");
		await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
			const branch: unknown[] = [];
			const host = makeHost({ backends: both(fakeBackend({ scripts: [script as FakeScript] })), branch, sessionFile });
			const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
			assert.ok(ran.error, `${what} should fail the run`);
			assert.ok(!/pi-claimed/.test(ran.error ?? ""), `${what}: ${ran.error}`);
			const held = new History(dir).load("host-1").records.at(-1)!;
			assert.equal(held.ref, undefined, `${what} left a verified session in the history`);
			assert.equal(held.selection, undefined, `${what} left a selection in the history`);
			assert.equal((await monitorDetail(host, "run-1")).ref, undefined, `${what} left a transcript path in the monitor`);
			const cold = makeHost({ backends: both(fakeBackend()), branch: [], sessionFile, sessionId: "host-1" });
			assert.equal((await monitorDetail(cold, "run-1")).ref, undefined, `${what} left a path a later process could open`);
		});
	}
});

/** The session usage line `/fusion status` ends with, which is the live ledger as the user reads it. */
const usageLine = async (host: ReturnType<typeof makeHost>): Promise<string> => {
	host.notices.length = 0;
	await host.command("status");
	const line = (host.notices.at(-1) ?? "").split("\n").find((text) => text.startsWith("session usage:"));
	assert.ok(line, `no session usage line in: ${host.notices.at(-1)}`);
	return line;
};

test("the outcome a run returned is its authoritative usage, in the live ledger, the history and a later process's total", async () => {
	for (const [what, script] of [
		["reported progress the outcome then replaced", { running: { costUsd: 1 }, finalProgress: false, costUsd: 5 }],
		["reported no progress at all", { runningProgress: false, finalProgress: false, costUsd: 5 }],
	] as const) {
		const dir = tempDir("pi-returned-usage");
		const sessionFile = path.join(dir, "host-1.jsonl");
		await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
			const branch: unknown[] = [];
			const host = makeHost({ backends: both(fakeBackend({ scripts: [script as FakeScript] })), branch, sessionFile });
			const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
			assert.equal(ran.error, undefined, what);
			assert.equal(ran.details.sessionUsage.costUsd, 5, `${what}: the ledger takes what the run returned`);
			assert.equal(ran.details.toolCalls, 2, `${what}: and the counters are the outcome's own`);
			assert.match(ran.text ?? "", /· 2 tool calls ·/, `${what}: the stats line counts what the outcome reported`);
			assert.match(await usageLine(host), /^session usage: est\. \$5\.00 ·/, what);
			assert.deepEqual(new History(dir).load("host-1").records.at(-1)!.usage, { costUsd: 5, tokensIn: 10, tokensOut: 5, toolCalls: 2 }, `${what}: the history keeps the same total`);

			// And a later process restores that record, so its cold total is the $5 the run really cost.
			const cold = makeHost({ backends: both(fakeBackend()), branch: [], sessionFile, sessionId: "host-1" });
			assert.match(await usageLine(cold), /^session usage: est\. \$5\.00 ·/, `${what}: a restored total`);
		});
	}
});

test("a run that ended badly keeps the cost its outcome returned, and one whose backend threw keeps the cost it had reported", async () => {
	for (const [what, script, cost] of [
		["a child that failed", { fail: "the provider refused the request", running: { costUsd: 1 }, finalProgress: false, costUsd: 5 }, 5],
		["an outcome the host refused", { checkpoint: null, running: { costUsd: 1 }, finalProgress: false, costUsd: 5 }, 5],
		["a backend that threw after its child reported progress", { throwsLate: "the backend broke mid-run", running: { costUsd: 1 } }, 1],
	] as const) {
		const dir = tempDir("pi-failed-usage");
		const sessionFile = path.join(dir, "host-1.jsonl");
		await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
			const host = makeHost({ backends: both(fakeBackend({ scripts: [script as FakeScript] })), branch: [], sessionFile });
			const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
			assert.ok(ran.error, `${what} should fail the run`);
			assert.match(await usageLine(host), new RegExp(`^session usage: est\\. \\$${cost}\\.00 ·`), `${what}: the ledger`);
			assert.equal(new History(dir).load("host-1").records.at(-1)!.usage?.costUsd, cost, `${what}: the history`);
		});
	}

	// A cancelled run ends on the outcome its backend still returned, and that is what its cost is.
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true, running: { costUsd: 1 }, finalProgress: false, costUsd: 5 }] });
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		await pi.started();
		assert.equal((await host.control({ action: "cancel", run: "run-1" })).text, "run-1 cancelled");
		assert.match(await usageLine(host), /^session usage: est\. \$5\.00 ·/, "a cancelled run's spending is what its outcome reported");
	});
});

test("the budget limit a returned outcome passed blocks the next call, before and after a restart", async () => {
	const dir = tempDir("pi-limit");
	const sessionFile = path.join(dir, "host-1.jsonl");
	await withEnv({ ...piEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir, PI_FUSION_BUDGET_LIMIT_USD: "3" }, async () => {
		const branch: unknown[] = [];
		const pi = fakeBackend({ scripts: [{ running: { costUsd: 1 }, finalProgress: false, costUsd: 5 }] });
		const host = makeHost({ backends: both(pi), branch, sessionFile });
		assert.equal((await host.fusion({ role: "implement", task: "do the thing", backend: "pi" })).error, undefined);
		const blocked = /have cost an estimated \$5\.00, at or over the PI_FUSION_BUDGET_LIMIT_USD limit of \$3\.00/;
		assert.match((await host.fusion({ role: "implement", task: "and more", backend: "pi" })).error ?? "", blocked, "the run the limit counts is the one that returned $5, not the $1 it reported");
		assert.equal(pi.starts.length, 1, "no second child started");

		const later = fakeBackend();
		const cold = makeHost({ backends: both(later), branch, sessionFile, sessionId: "host-1" });
		assert.match((await cold.fusion({ role: "implement", task: "after the restart", backend: "pi" })).error ?? "", blocked);
		assert.deepEqual(later.starts, [], "and the restored total blocks the call before a child starts");
	});
});

/** The line `/fusion status run-N` ends with for a run whose session the host can offer, if it offers one at all. */
const statusOf = async (host: ReturnType<typeof makeHost>, handle: string): Promise<string> => {
	host.notices.length = 0;
	await host.command(`status ${handle}`);
	return host.notices.at(-1) ?? "";
};

const noPiHint = (where: string, ...texts: Array<string | undefined>): void => {
	for (const text of texts) assert.ok(!/pi session /.test(text ?? ""), `${where} offers a pi session hint: ${text}`);
};

test("a generated pi session hint names only an identity the host accepted, wherever the host generates one", async () => {
	const claimed = { backend: "pi" as const, sessionId: "pi-claimed", sessionFile: "/sessions/pi-claimed.jsonl", checkpoint: "entry-claimed" };
	for (const [what, script] of [
		["an outcome the host refused after the child claimed a session", { running: { session: claimed }, checkpoint: null }],
		["a backend that threw after the child claimed one", { throwsLate: "the backend broke mid-run", running: { session: claimed } }],
	] as const) {
		await withEnv(piEnv(), async () => {
			// In the foreground the hint rides on the error the tool throws.
			const host = makeHost({ backends: both(fakeBackend({ scripts: [script as FakeScript] })) });
			const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
			assert.ok(ran.error, `${what} should fail the run`);
			noPiHint(`${what}, in the foreground error`, ran.error);
			noPiHint(`${what}, in the status after it ended`, await statusOf(host, "run-1"));

			// In the background it rides on the completion notice, and on the report a control wait hands back.
			const background = makeHost({ backends: both(fakeBackend({ scripts: [script as FakeScript] })) });
			await background.fusion({ role: "implement", task: "do the thing", backend: "pi", background: true });
			await until(`the notice for ${what}`, () => background.sent.length > 0);
			noPiHint(`${what}, in the background notice`, background.sent[0]![0].content);
			noPiHint(`${what}, in a control wait`, (await background.control({ action: "wait", run: "run-1" })).text);
			noPiHint(`${what}, in a control message after the end`, (await background.control({ action: "message", run: "run-1", message: "too late" })).text);
		});
	}

	// A run still going has had nothing validated, whatever session it claims in progress.
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true, running: { session: claimed } }] });
		const host = makeHost({ backends: both(pi) });
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		await pi.started();
		const running = await statusOf(host, "run-1");
		assert.match(running, /^run-1 · implement · deepseek\/deepseek-chat · running · background ·/);
		noPiHint("the status of a running pi run", running);
		assert.equal((await host.control({ action: "cancel", run: "run-1" })).text, "run-1 cancelled");
	});
});

test("a pi identity the host accepted is offered wherever a hint is generated, diagnostic references included", async () => {
	await withEnv(piEnv(), async () => {
		const branch: unknown[] = [];
		// A settled run, a first call that failed with an identity and no checkpoint, and a fork verified before the
		// call failed without a selection: the last two are refused for continuation and still name a file to read.
		const pi = fakeBackend({
			scripts: [{}, { fail: "the provider refused the request", newId: "pi-failed", newFile: "/sessions/pi-failed.jsonl" }],
		});
		const host = makeHost({ backends: both(pi), branch });
		const settled = await host.fusion({ role: "implement", task: "do the thing", backend: "pi" });
		assert.equal(settled.error, undefined);
		assert.match(settled.text ?? "", /pi session \/sessions\/pi-1\.jsonl\]$/);
		assert.match(await statusOf(host, "run-1"), /\npi session \/sessions\/pi-1\.jsonl$/);

		const failed = await host.fusion({ role: "implement", task: "something new", backend: "pi" });
		assert.match(failed.error ?? "", /pi session \/sessions\/pi-failed\.jsonl\]$/, "a first call that failed with an identity still says where to read it");
		assert.match(await statusOf(host, "run-2"), /\npi session \/sessions\/pi-failed\.jsonl$/);

		// A forked host session forks the recorded run, and that fork failed before it read a selection back.
		const forked = { backend: "pi" as const, sessionId: "pi-forked", sessionFile: "/sessions/pi-forked.jsonl", checkpoint: "entry-1" };
		const forking = fakeBackend({ scripts: [{ fail: "the provider dropped the connection", session: forked, selection: null }] });
		const other = makeHost({ backends: both(forking), branch, sessionId: "host-2" });
		const fork = await other.fusion({ continue: "run-1", task: "carry on in the fork" });
		assert.equal(forking.starts[0]!.intent?.kind, "fork", "the run under test is the fork a forked host makes");
		assert.match(fork.error ?? "", /pi session \/sessions\/pi-forked\.jsonl\]$/, "a fork kept for reading names the child it made");
		assert.match(await statusOf(other, "run-1"), /\npi session \/sessions\/pi-forked\.jsonl$/);
	});
});

test("a claude run still offers the live scalar resume command it always did, running and ended", async () => {
	await withEnv(piEnv(), async () => {
		const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }] });
		const host = makeHost({ backends: both(fakeBackend(), claude) });
		await host.fusion({ role: "implement", task: "long work", backend: "claude", background: true });
		const start = await claude.started();
		assert.match(await statusOf(host, "run-1"), /\nclaude --resume c-1$/, "a running claude run offers the id its child reported");
		start.release();
		assert.match(await ended(host, "run-1"), /claude --resume c-1\]/);
		assert.match(await statusOf(host, "run-1"), /\nclaude --resume c-1$/);
		noPiHint("a claude run", host.sent.map(([message]) => message.content).join("\n"));
	});
});

/*
 * The role pi alone runs, driven through the shared lifecycle: the writer slot it takes, the continuation that stays
 * on pi, and the reviewer a finished one gets, which is the one reviewer of this build that is not a Claude child.
 * What the review policy decides on its own is `test/review.test.ts`'s; what is here is the run that policy produces.
 */

/** The model a security run is configured with. It is not the one any other role here runs, so a reviewer that inherited the wrong one shows. */
const SECURITY_MODEL = "openai/gpt-5";

/** The variables a security run needs beside the other roles': the role has no default model and no default level. */
const securityEnv = (over: Record<string, string | undefined> = {}) => piEnv({ PI_FUSION_PI_SECURITY_MODEL: SECURITY_MODEL, PI_FUSION_PI_SECURITY_EFFORT: undefined, ...over });

/** Security is opt-in, so these lifecycle cases load an enabled profile instead of changing the built-in defaults. */
const makeSecurityHost = (options: HostOptions = {}) => makeHost({ ...options, profiles: options.profiles ?? securityProfiles() });

/** The Pi tool lists a role is made of: the coding set a role that changes files runs with, and the read-only set a review runs with. */
const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const READING_TOOLS = ["read", "bash", "grep", "find", "ls"];

/** The tool list a backend's own binding put on the role, which the host's view of a role does not name. */
const toolsOf = (role: unknown): string[] | undefined => (role as { tools?: string[] }).tools;

/** A scratch git repository with one commit, so a run made in it has a tree two snapshots can be compared in. */
function gitRepo(name: string): string {
	const dir = fs.realpathSync(tempDir(name));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	fs.writeFileSync(path.join(dir, "base.txt"), "b\n");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	return dir;
}

/**
 * One run that leaves a changed file behind, which is what a review has to be given to be started at all. The
 * scripted child writes nothing itself, so the file is written here, while the run is held and between the two
 * snapshots the host takes around it. The run it is given has to be scripted `pending`.
 */
async function runThatChanged(host: ReturnType<typeof makeHost>, backend: FakeBackend, dir: string, params: Record<string, unknown>, file = "fixed.ts"): Promise<Called> {
	const nth = backend.starts.length + 1;
	const call = host.fusion(params);
	const held = await backend.started(nth);
	fs.writeFileSync(path.join(dir, file), `const ${path.basename(file, ".ts")} = true;\n`);
	held.release();
	return await call;
}

test("a security call names no backend and runs on pi, and while it runs nothing else may change files on either backend", async () => {
	await withEnv(securityEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }, {}] });
		const claude = fakeBackend({ name: "claude" });
		const host = makeSecurityHost({ backends: both(pi, claude) });
		const started = await host.fusion({ role: "security", task: "audit the token check", background: true });
		assert.equal(started.text, "run-1 started in the background; you get the report when it ends");
		const writing = await pi.started();
		assert.deepEqual(claude.starts, [], "the role runs on pi alone, so a call that named no backend went there");
		assert.deepEqual([writing.role.name, writing.role.model, effortOf(writing.role), writing.role.contract], ["security", SECURITY_MODEL, undefined, "security.md"]);
		assert.deepEqual(toolsOf(writing.role), CODING_TOOLS, "the role investigates and, when its task authorizes one, writes the fix");
		assert.deepEqual(writing.session, { kind: "new", intent: { kind: "new" } });

		// It holds the one writer slot against either backend, and a read-only run still goes next to it.
		for (const backend of ["pi", "claude"] as const) {
			const refused = await host.fusion({ role: "implement", task: "other work", backend });
			assert.equal(
				refused.error,
				"run-1 (security) is still active; wait for it, message it or cancel it with fusion_control before you start or continue another run that can change files",
				backend,
			);
		}
		assert.equal((await host.fusion({ role: "ask", task: "where is x?", backend: "claude" })).error, undefined);
		assert.equal((await host.fusion({ role: "ask", task: "and y?", backend: "pi" })).error, undefined);
		assert.equal(claude.starts.length, 1, "the claude child that started is the ask run, never the implement one the slot kept out");
		writing.release();
		assert.match(await ended(host, "run-1"), /^run-1 \(security\) done\./);
		assert.deepEqual(
			host.entries().find((data) => data.run === "run-1"),
			{
				run: "run-1",
				role: "security",
				backend: "pi",
				hostSessionId: "host-1",
				session: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" },
				selection: { model: SECURITY_MODEL, effort: "medium" },
			},
		);

		// A model and a level the call names are what that run goes to, over what is configured for the role.
		const named = await host.fusion({ role: "security", task: "and the refresh path?", model: "deepseek/deepseek-chat", effort: "xhigh" });
		assert.equal(named.error, undefined);
		const second = pi.starts.at(-1)!;
		assert.deepEqual([second.role.name, second.role.model, effortOf(second.role)], ["security", "deepseek/deepseek-chat", "xhigh"]);
		assert.deepEqual(host.entries().at(-1)!.selection, { model: "deepseek/deepseek-chat", effort: "xhigh" });
	});
});

test("a security run waiting for an answer keeps the writer slot, and takes one answer before it goes on", async () => {
	await withEnv(securityEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ questions: ["May I patch the token check, or do you want findings only?"] }] });
		const claude = fakeBackend({ name: "claude" });
		const host = makeSecurityHost({ backends: both(pi, claude) });
		const asked = await host.fusion({ role: "security", task: "audit the token check" });
		assert.match(asked.text ?? "", /^run-1 \(security\) asks:\n\nMay I patch the token check/);
		assert.equal(asked.details.state, "waiting");
		for (const backend of ["pi", "claude"] as const) {
			const blocked = await host.fusion({ role: "implement", task: "something else", backend });
			assert.match(blocked.error ?? "", /^run-1 \(security\) is still active; wait for it/, backend);
		}
		assert.equal((await host.fusion({ role: "ask", task: "where is x?", backend: "pi" })).error, undefined, "a read-only run still goes next to a waiting security run");
		const sent = await host.control({ action: "message", run: "run-1", message: "findings only, change no application code" });
		assert.equal(sent.text, "answer sent to run-1; the child goes on");
		assert.match(await ended(host, "run-1"), /^run-1 \(security\) done\./);
		assert.deepEqual(pi.starts[0]!.answers, ["findings only, change no application code"], "the child took exactly one answer");
		assert.deepEqual(claude.starts, [], "nothing of this run reached the other backend");
	});
});

test("a security continuation stays on pi with the selection that run ran with, and every claude route to it is refused", async () => {
	await withEnv(securityEnv({ PI_FUSION_PI_SECURITY_EFFORT: "high" }), async () => {
		const branch: unknown[] = [];
		const first = fakeBackend();
		assert.equal((await makeSecurityHost({ backends: both(first), branch }).fusion({ role: "security", task: "audit the token check" })).error, undefined);
		assert.deepEqual([first.starts[0]!.role.model, effortOf(first.starts[0]!.role)], [SECURITY_MODEL, "high"]);

		// A fresh extension on the same branch is what a Pi restart leaves, and the variables have moved on since.
		await withEnv({ PI_FUSION_PI_SECURITY_MODEL: "deepseek/deepseek-chat", PI_FUSION_PI_SECURITY_EFFORT: "off" }, async () => {
			const next = fakeBackend();
			const claude = fakeBackend({ name: "claude" });
			const host = makeSecurityHost({ backends: both(next, claude), branch });
			const ran = await host.fusion({ continue: "run-1", task: "and the refresh path?" });
			assert.equal(ran.error, undefined);
			const start = next.starts[0]!;
			assert.deepEqual(start.intent, { kind: "resume", ref: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" } });
			assert.deepEqual([start.role.name, start.role.model, effortOf(start.role), start.role.contract], ["security", SECURITY_MODEL, "high", "security.md"]);
			assert.deepEqual(host.entries().at(-1)!.selection, { model: SECURITY_MODEL, effort: "high" });
			noClaudeResume("a settled security run", ran.text, JSON.stringify(ran.details));

			// The compatibility tool runs the four roles claude runs, and no route through claude reaches a child here.
			assert.equal(
				(await host.claude({ continue: "run-1", task: "carry on there" })).error,
				"run-1 ran on the pi backend, which the claude tool does not run; continue it with fusion and continue run-1",
			);
			assert.equal((await host.claude({ role: "security", task: "a fresh audit" })).error, "unknown role security; use one of plan, implement, ultracode, ask");
			assert.equal((await host.fusion({ continue: "run-1", task: "carry on", backend: "claude" })).error, "run-1 ran on the pi backend; omit backend or use pi");
			assert.equal((await host.fusion({ role: "security", task: "a fresh audit", backend: "claude" })).error, "role security does not run on the claude backend; use one of pi");
			assert.deepEqual(claude.starts, [], "no claude child started for any of them");
			assert.equal(next.starts.length, 1, "and no second pi child either");
		});
	});
});

/** Every role as a saved profile states it, with the legacy defaults, for a case that changes one or two of them. */
const PROFILE_ROLES: Record<string, Record<string, unknown>> = {
	plan: { enabled: true, backend: "claude", model: "fable", effort: "xhigh" },
	implement: { enabled: true, backend: "claude", model: "opus", effort: "high" },
	ultracode: { enabled: true, backend: "claude", model: "fable" },
	ask: { enabled: true, backend: "claude", model: "opus", effort: "high" },
	security: { enabled: true, backend: "pi", model: SECURITY_MODEL },
};

/** A profiles file in memory whose default profile, `work`, is the legacy defaults with the roles a case names over them. */
const profileWith = (roles: Record<string, Record<string, unknown>>): ProfileStore =>
	memoryProfileStore(JSON.stringify({ version: 1, defaultProfile: "work", profiles: { work: { roles: { ...PROFILE_ROLES, ...roles } } } }));

test("a finished security run is reviewed by this session's ask run, a claude one by default, and nothing of the source run's selection reaches it", async () => {
	const dir = gitRepo("security-review");
	await withEnv(securityEnv({ PI_FUSION_PI_SECURITY_EFFORT: "high", PI_FUSION_PI_ASK_MODEL: PI_MODEL, PI_FUSION_PI_ASK_EFFORT: "low" }), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true, text: "## Findings\n1. high, confirmed: the token check accepts an expired token" }] });
		const claude = fakeBackend({ name: "claude" });
		const host = makeSecurityHost({ backends: both(pi, claude), cwd: dir });
		const done = await runThatChanged(host, pi, dir, { role: "security", task: "audit the token check; fixes are authorized" });
		assert.equal(done.error, undefined);
		assert.deepEqual(done.details.files, ["fixed.ts"], "the run under test has to have changed files, so the reviewer it gets is the only thing left to judge");
		assert.deepEqual(host.entries()[0]!.selection, { model: SECURITY_MODEL, effort: "high" });

		host.notices.length = 0;
		await host.command("review run-1");
		assert.deepEqual(host.notices, ["run-2 reviews run-1 in the background; its report arrives as a message"]);
		assert.equal(pi.starts.length, 1, "no pi child reviews it: role ask runs on claude in this configuration");
		const reviewer = claude.starts[0]!;
		assert.deepEqual(
			[reviewer.role.name, reviewer.role.mode, reviewer.role.contract, reviewer.role.model, effortOf(reviewer.role)],
			["ask", "review", "ask-review.md", "opus", "high"],
			"the reviewer is the ask role as configured, whatever the source ran with",
		);
		assert.deepEqual(reviewer.session, { kind: "new", intent: { kind: "new" } }, "nobody briefed the reviewer: it is a session of its own");
		assert.match(reviewer.prompt, /^Review run-1, a security run that ended done\./);
		assert.ok(reviewer.prompt.includes("A fixed.ts"), reviewer.prompt);
		await ended(host, "run-2");
		assert.equal((await host.control({ action: "status", run: "run-1" })).details.reviewedBy, "run-2");
	});
});

test("a profile that runs ask on pi reviews every role there, on the ask role's own model and effort", async () => {
	const dir = gitRepo("profile-pi-review");
	await withEnv(securityEnv({ PI_FUSION_PI_SECURITY_EFFORT: "high" }), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }, {}, {}] });
		const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }] });
		const host = makeSecurityHost({ backends: both(pi, claude), cwd: dir, profiles: profileWith({ ask: { enabled: true, backend: "pi", model: PI_MODEL, effort: "low" } }) });
		const done = await runThatChanged(host, pi, dir, { role: "security", task: "audit the token check" });
		assert.equal(done.error, undefined);
		await host.command("review run-1");
		const reviewer = pi.starts[1]!;
		assert.deepEqual(
			[reviewer.role.name, reviewer.role.mode, reviewer.role.contract, reviewer.role.model, effortOf(reviewer.role)],
			["ask", "review", "ask-review.md", PI_MODEL, "low"],
			"the profile's ask model and effort, and not the security run's model or level",
		);
		assert.deepEqual(toolsOf(reviewer.role), READING_TOOLS, "a review reads and reports, so it has no edit or write tool at all");
		await ended(host, "run-2");
		assert.deepEqual(host.entries().at(-1)!.selection, { model: PI_MODEL, effort: "low" });

		// A claude implement run is reviewed by that same pi ask run: the source's backend does not pick the reviewer.
		const other = await runThatChanged(host, claude, dir, { role: "implement", task: "add the retry" }, "retried.ts");
		assert.equal(other.error, undefined);
		await host.command("review run-3");
		assert.deepEqual([pi.starts[2]!.role.name, pi.starts[2]!.role.model, effortOf(pi.starts[2]!.role)], ["ask", PI_MODEL, "low"]);
		assert.equal(claude.starts.length, 1, "no claude child reviewed it");
		await ended(host, "run-4");
	});
});

test("PI_FUSION_AUTO_REVIEW gives a security run and a claude run the same configured ask reviewer, and none at all while ask is disabled", async () => {
	const dir = gitRepo("security-auto-review");
	await withEnv({ ...securityEnv(), PI_FUSION_AUTO_REVIEW: "1" }, async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }] });
		const claude = fakeBackend({ name: "claude", scripts: [{}, { pending: true }, {}] });
		const host = makeSecurityHost({ backends: both(pi, claude), cwd: dir });
		const done = await runThatChanged(host, pi, dir, { role: "security", task: "audit the token check" });
		assert.ok((done.text ?? "").endsWith("\n\nrun-2 reviews this run in the background; its report arrives as a message."), done.text);
		await ended(host, "run-2");
		assert.equal(pi.starts.length, 1, "no pi child reviewed the security run");
		assert.deepEqual([claude.starts[0]!.role.name, claude.starts[0]!.role.mode, claude.starts[0]!.role.model], ["ask", "review", "opus"]);
		const other = await runThatChanged(host, claude, dir, { role: "implement", task: "add the retry" }, "retried.ts");
		assert.equal(other.details.reviewedBy, "run-4");
		await ended(host, "run-4");
		assert.deepEqual([claude.starts[2]!.role.name, claude.starts[2]!.role.mode], ["ask", "review"]);
	});
	const quiet = gitRepo("auto-review-ask-disabled");
	await withEnv({ ...piEnv(), PI_FUSION_AUTO_REVIEW: "1" }, async () => {
		const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }] });
		const host = makeSecurityHost({ backends: both(fakeBackend(), claude), cwd: quiet, profiles: profileWith({ ask: { enabled: false, backend: "claude" } }) });
		const done = await runThatChanged(host, claude, quiet, { role: "implement", task: "add the retry" });
		assert.equal(done.error, undefined);
		assert.equal(done.details.reviewedBy, undefined, "a disabled ask role starts no review");
		assert.ok(!(done.text ?? "").includes("reviews this run"), done.text);
		assert.equal(claude.starts.length, 1, "and no reviewer");
		assert.deepEqual(host.notices, [], "skipping it is not a warning");
		host.notices.length = 0;
		await host.command("review run-1");
		assert.deepEqual(host.notices, ["role ask is disabled in profile work, so nothing reviews run-1; change /fusion config or select another profile"]);
		assert.equal(claude.starts.length, 1);
	});
});

test("a security run an earlier Pi process left is reviewed by this session's ask run, whatever model it recorded", async () => {
	const dir = gitRepo("security-restored-review");
	const historyDir = tempDir("security-restored-history");
	const sessionFile = path.join(historyDir, "host-1.jsonl");
	const branch: unknown[] = [];
	await withEnv({ ...securityEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: historyDir }, async () => {
		const first = fakeBackend({ scripts: [{ pending: true }] });
		const host = makeSecurityHost({ backends: both(first), branch, sessionFile, cwd: dir });
		const done = await runThatChanged(host, first, dir, { role: "security", task: "audit the token check", model: "openrouter/deepseek/deepseek-chat", effort: "max" });
		assert.equal(done.error, undefined);
	});
	await withEnv({ ...securityEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: historyDir }, async () => {
		const later = fakeBackend();
		const host = makeSecurityHost({ backends: both(later), branch, sessionFile, cwd: dir, profiles: profileWith({ ask: { enabled: true, backend: "pi", model: PI_MODEL, effort: "medium" } }) });
		const status = await statusOf(host, "run-1");
		assert.match(status, /\nreview it with \/fusion review run-1$/);
		host.notices.length = 0;
		await host.command("review run-1");
		assert.deepEqual(host.notices, ["run-2 reviews run-1 in the background; its report arrives as a message"]);
		const reviewer = later.starts[0]!;
		assert.deepEqual([reviewer.role.name, reviewer.role.mode, reviewer.role.model, effortOf(reviewer.role)], ["ask", "review", PI_MODEL, "medium"]);
		assert.ok(reviewer.prompt.includes("A fixed.ts"), "the reviewer is given the paths the restored run changed");
		await ended(host, "run-2");
		assert.equal(new History(historyDir).load("host-1").records.find((record) => record.handle === "run-1")!.reviewedBy, "run-2", "and the restored run is linked to the review that read it");
	});
});

test("an ask reviewer this host cannot bind refuses the review in the binding's own words, and starts, records and links nothing", async () => {
	const dir = gitRepo("security-review-unbindable");
	await withEnv(securityEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }, {}] });
		const claude = fakeBackend({ name: "claude" });
		const host = makeSecurityHost({ backends: both(pi, claude), cwd: dir, profiles: profileWith({ ask: { enabled: true, backend: "pi" } }) });
		const done = await runThatChanged(host, pi, dir, { role: "security", task: "audit the token check" });
		assert.equal(done.error, undefined);
		host.notices.length = 0;
		await host.command("review run-1");
		assert.deepEqual(host.notices, [
			"run-2 would review run-1, and its reviewer could not be bound: role ask has no model for the pi backend in profile work: choose a provider and a model id, such as deepseek/deepseek-chat, with /fusion config, or name one in the call's model parameter. The pi backend has no default model and resolves none for you",
		]);
		assert.equal(pi.starts.length, 1, "no reviewer was started");
		assert.deepEqual(claude.starts, [], "and no claude child stood in for the reviewer this host could not bind");
		assert.equal(host.entries().length, 1, "nothing was recorded for a handle nothing took");
		assert.equal((await host.control({ action: "status", run: "run-1" })).details.reviewedBy, undefined, "and the source is linked to no review");
	});
});

test("an ask reviewer configured on a backend this host did not register is refused before anything is started, recorded or linked", async () => {
	const dir = tempDir("security-review-no-pi");
	const sessionFile = path.join(dir, "host-1.jsonl");
	new History(dir).saveAll("host-1", repoRoot, [
		heldRecord({
			role: "security",
			selection: { model: SECURITY_MODEL, effort: "high" },
			ref: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" },
		}),
	]);
	await withEnv({ ...securityEnv(), PI_FUSION_HISTORY: "1", PI_FUSION_HISTORY_DIR: dir }, async () => {
		const claude = fakeBackend({ name: "claude" });
		// Codex left out as well, so the backends the refusal offers instead are the one this host registered.
		const host = makeSecurityHost({ backends: { pi: undefined, codex: undefined, claude: claude.backend }, sessionFile, profiles: profileWith({ ask: { enabled: true, backend: "pi", model: PI_MODEL } }) });
		await host.command("review run-1");
		assert.deepEqual(host.notices, [
			"the pi backend is not available in this build: run-2 would review run-1, and this pi-fusion runs claude only. Nothing was started and nothing was recorded. Take the work to claude with a role it runs, or do it yourself; no configuration makes pi available here.",
		]);
		assert.deepEqual(claude.starts, [], "no claude child stands in for the backend the ask role is configured on");
		assert.equal(host.branch.length, 0, "nothing was recorded for a handle nothing took");
		assert.equal(new History(dir).load("host-1").records[0]!.reviewedBy, undefined, "and the restored run is linked to no review");
	});
});

/**
 * What an own in-memory codex double reports for a run that settled: its own thread, and the model and provider the
 * child read back. The fake builds no codex identity of its own, so a case scripts the one a correct child reports.
 */
const codexScript = (thread: string, over: FakeScript = {}): FakeScript => ({
	session: { backend: "codex", sessionId: thread },
	selection: { model: "gpt-5.5", provider: "openai" },
	extra: { modelId: "gpt-5.5" },
	...over,
});

test("a codex role is bound before it reaches a registered codex backend, and the runtime gets the raw role with no host-default label in it", async () => {
	// An own in-memory double over the shared codex tripwire: with a binding in place, a call that reaches a backend at all
	// reaches this one, and nothing here is a production codex child.
	const codex = fakeBackend({ name: "codex", scripts: [codexScript("thread-1"), codexScript("thread-2", { text: "## Answer\nyes" })] });
	const claude = fakeBackend({ name: "claude" });
	const host = makeHost({ backends: { claude: claude.backend, codex: codex.backend }, profiles: profileWith({ implement: { enabled: true, backend: "codex" } }) });
	const done = await host.fusion({ role: "implement", task: "do the thing" });
	assert.equal(done.error, undefined);
	const runtime = codex.starts[0]!.role as unknown as Record<string, unknown>;
	assert.deepEqual(runtime, { name: "implement", contract: "implement.md", sandboxMode: "workspace-write", approvalPolicy: "never" });
	assert.equal("model" in runtime, false, "the runtime is never handed the display label as a model");
	assert.deepEqual(codex.starts[0]!.session, { kind: "new", intent: { kind: "new" } });
	// The stats line names the host default and what the child reported it was, and the thread to reopen.
	assert.match(done.text ?? "", /\[run-1 · implement · host default -> gpt-5\.5 · \d+s · 2 tool calls · in 10 out 5 · codex resume thread-1\]$/);
	assert.equal(done.details.model, "host default -> gpt-5.5");
	assert.match(await statusOf(host, "run-1"), /^run-1 · implement · host default -> gpt-5\.5 · done/);
	// The record keeps the thread and the selection the child read back, and no label stands in for a model.
	assert.deepEqual(host.entries()[0], { run: "run-1", role: "implement", backend: "codex", hostSessionId: "host-1", session: { backend: "codex", sessionId: "thread-1" }, selection: { model: "gpt-5.5", provider: "openai" } });
	// A call naming codex and a model is bound with that model and shown on it alone.
	const named = await host.fusion({ role: "ask", task: "a question", backend: "codex", model: "gpt-5-codex", effort: "high" });
	assert.equal(named.error, undefined);
	assert.deepEqual(codex.starts[1]!.role, { name: "ask", model: "gpt-5-codex", effort: "high", contract: "ask-answer.md", mode: "answer", sandboxMode: "read-only", approvalPolicy: "never" });
	assert.match(named.text ?? "", /\[run-2 · ask · gpt-5-codex · /);
	assert.deepEqual(claude.starts, [], "no claude child stood in for codex");
	assert.deepEqual(tripwireReaches("codex"), [], "the own double stood in for the tripwire, which nothing reached");
});

test("the registered fusion tool hands an effort only codex takes to the codex backend, named or configured, and claude and pi refuse it before starting", async () => {
	await withEnv(piEnv(), async () => {
		// Own in-memory doubles spread over the shared tripwires by the host: no production backend and no process.
		const codex = fakeBackend({ name: "codex", scripts: [codexScript("thread-1"), codexScript("thread-2")] });
		const pi = fakeBackend();
		const claude = fakeBackend({ name: "claude" });
		const host = makeHost({ backends: { ...both(pi, claude), codex: codex.backend }, profiles: profileWith({ ask: { enabled: true, backend: "codex" } }) });
		const named = await host.fusion({ role: "implement", task: "x", backend: "codex", effort: "ultra" });
		assert.equal(named.error, undefined);
		assert.equal(codex.starts[0]!.role.effort, "ultra", "the call's level reached the codex backend as written");
		const configured = await host.fusion({ role: "ask", task: "a question", effort: "ultra" });
		assert.equal(configured.error, undefined);
		assert.deepEqual([codex.starts[1]!.role.name, codex.starts[1]!.role.effort], ["ask", "ultra"], "a role configured on codex takes it with no backend parameter");
		assert.equal((await host.fusion({ role: "implement", task: "x", effort: "ultra" })).error, "unknown effort ultra; use one of low, medium, high, xhigh, max");
		assert.equal((await host.claude({ role: "implement", task: "x", effort: "ultra" })).error, "unknown effort ultra; use one of low, medium, high, xhigh, max");
		assert.equal(
			(await host.fusion({ role: "implement", task: "x", backend: "pi", effort: "ultra" })).error,
			'the call names effort "ultra", which is not a pi thinking level; use one of off, minimal, low, medium, high, xhigh, max',
		);
		assert.match((await host.fusion({ role: "implement", task: "x", backend: "codex", effort: "very high" })).error ?? "", /^the call names effort "very high", which is not a codex effort/);
		assert.equal(codex.starts.length, 2, "the refused calls started nothing");
		assert.deepEqual([pi.starts.length, claude.starts.length], [0, 0]);
		assert.equal(host.entries().length, 2, "and recorded nothing");
		assert.deepEqual(tripwireReaches("codex"), []);
		assert.deepEqual(tripwireReaches("pi"), []);
	});
});

test("a manual review by an ask role configured on codex is bound read-only on it, and inherits nothing from the reviewed run", async () => {
	const dir = gitRepo("security-review-codex");
	await withEnv(securityEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }, {}] });
		const claude = fakeBackend({ name: "claude" });
		const codex = fakeBackend({ name: "codex", scripts: [codexScript("thread-1", { text: "## Verdict\nReady" })] });
		const host = makeSecurityHost({ backends: { ...both(pi, claude), codex: codex.backend }, cwd: dir, profiles: profileWith({ ask: { enabled: true, backend: "codex" } }) });
		const done = await runThatChanged(host, pi, dir, { role: "security", task: "audit the token check" });
		assert.equal(done.error, undefined);
		host.notices.length = 0;
		await host.command("review run-1");
		assert.deepEqual(host.notices, ["run-2 reviews run-1 in the background; its report arrives as a message"]);
		const reviewer = await codex.started();
		assert.deepEqual(reviewer.role, { name: "ask", contract: "ask-review.md", mode: "review", sandboxMode: "read-only", approvalPolicy: "never" }, "the reviewer is the configured codex ask role, not the security run's model");
		assert.deepEqual(reviewer.session, { kind: "new", intent: { kind: "new" } }, "nobody briefed the reviewer: it is a thread of its own");
		await ended(host, "run-2");
		assert.equal(pi.starts.length, 1, "no pi child reviewed it");
		assert.deepEqual(claude.starts, [], "and no claude child stood in for it");
		assert.equal((await host.control({ action: "status", run: "run-1" })).details.reviewedBy, "run-2");
		assert.deepEqual(tripwireReaches("codex"), []);
	});
});

const OFF_REFUSAL = "fusion is off; turn it on with /fusion on, or ask for Fusion by name";

/** What a host is told when a codex run's input took its steer: queued for the turn, never said to be read. */
const CODEX_QUEUED = "steer queued for run-1: it goes once, with no retry, to the run's current turn, and the turn taking it does not show the child read it; the run's report counts what became of it";

test("a running codex run takes a steer from both control tools and /fusion steer, said to be queued for its turn and not read, and status, wait and cancel act on it as on any run", async () => {
	// An own in-memory double over the shared codex tripwire, its input open from admission as this build's codex backend's is.
	const verified = { model: "gpt-5.5", provider: "openai" };
	const codex = fakeBackend({
		name: "codex",
		scripts: [codexScript("thread-1", { pending: true }), codexScript("thread-2", { pending: true, onAbort: { session: { backend: "codex", sessionId: "thread-2" }, selection: verified } })],
	});
	const host = makeHost({ backends: { codex: codex.backend } });
	const started = await host.fusion({ role: "implement", task: "long work", backend: "codex", background: true });
	assert.equal(started.text, "run-1 started in the background; you get the report when it ends");
	const running = await codex.started();
	for (const [tool, control] of [["fusion_control", host.control], ["claude_control", host.claudeControl]] as const) {
		const queued = await control({ action: "message", run: "run-1", message: `from ${tool}` });
		assert.equal(queued.text, CODEX_QUEUED, tool);
		assert.deepEqual([queued.details.state, queued.details.sent], ["running", "steer"], tool);
	}
	host.notices.length = 0;
	await host.command("steer run-1 also fix the typo");
	assert.deepEqual(host.notices, [CODEX_QUEUED]);
	assert.deepEqual(running.steers, ["from fusion_control", "from claude_control", "also fix the typo"], "each message reached the run's input once, in order");
	assert.equal(host.sent.filter(([message]) => message.details?.kind === "steer").length, 1, "the user's steer is told to the host once");
	assert.match((await host.control({ action: "status", run: "run-1" })).text ?? "", /^run-1 · implement · host default · running · background · /);

	const waiting = host.control({ action: "wait", run: "run-1" });
	running.release();
	const waited = await waiting;
	assert.match(waited.text ?? "", /^run-1 \(implement\) done\.\n\n## Changed\nfoo\.ts\n\n\[run-1 · implement · host default -> gpt-5\.5 · .* · codex resume thread-1\]$/);

	// A cancellation that lands after the child verified its selection is still a cancellation: failed() and the record
	// decision say so, and the selection it carried is kept on a readable record, never read as a success.
	await host.fusion({ role: "implement", task: "more work", backend: "codex", background: true });
	await codex.started(2);
	const cancelled = await host.control({ action: "cancel", run: "run-2" });
	assert.deepEqual([cancelled.text, cancelled.details.state], ["run-2 cancelled", "cancelled"]);
	await ended(host, "run-2");
	assert.deepEqual(host.entries()[1], { run: "run-2", role: "implement", backend: "codex", hostSessionId: "host-1", session: { backend: "codex", sessionId: "thread-2" }, selection: verified });
	assert.match(await statusOf(host, "run-2"), /^run-2 · implement · host default -> gpt-5\.5 · cancelled · background/);
	assert.equal(
		(await host.fusion({ continue: "run-2", task: "go on" })).error,
		"run-2 ran on codex and recorded no trusted checkpoint, so it is kept for reading and not continued; open its thread with codex resume thread-2, and new work needs a new run without continue (a plan call takes fresh true)",
	);
	assert.equal(codex.starts.length, 2, "nothing continued the cancelled thread");
});

test("a run whose input was closed from its admission takes no steer: both control tools and /fusion steer say so at once, by its input and not its backend's name", async () => {
	// The double's input is closed on purpose: no backend of this build hands over such an input, and the host reads the
	// input's own state rather than a backend name to say so.
	const codex = fakeBackend({ name: "codex", steers: false, scripts: [codexScript("thread-1", { pending: true })] });
	const host = makeHost({ backends: { codex: codex.backend } });
	await host.fusion({ role: "implement", task: "long work", backend: "codex", background: true });
	const running = await codex.started();
	for (const [tool, control] of [["fusion_control", host.control], ["claude_control", host.claudeControl]] as const) {
		const refused = await control({ action: "message", run: "run-1", message: "also fix the typo" });
		assert.equal(
			refused.text,
			`run-1 (implement) runs on the codex backend, whose child takes no steer while it runs. The message was not sent. Wait for its report with ${tool} wait, or stop it with ${tool} cancel; to follow up, start a new fusion run that carries its report as context.`,
		);
		assert.deepEqual([refused.details.state, refused.details.sent], ["running", "none"], tool);
	}
	host.notices.length = 0;
	await host.command("steer run-1 also fix the typo");
	assert.deepEqual(host.notices, ["run-1 runs on the codex backend, whose child takes no steer while it runs; nothing was sent. Wait for it with /fusion wait run-1 or stop it with /fusion cancel run-1"]);
	assert.deepEqual(running.steers, [], "nothing reached the child");
	assert.equal(host.sent.filter(([message]) => message.details?.kind === "steer").length, 0, "and no notice told the host a steer was sent");
	running.release();
	await ended(host, "run-1");
});

test("a running child whose open input takes no more says at once that the message was not accepted, and nothing is queued, retried or told as sent", async () => {
	const codex = fakeBackend({ name: "codex", steerCapacity: 1, scripts: [codexScript("thread-1", { pending: true })] });
	const host = makeHost({ backends: { codex: codex.backend } });
	await host.fusion({ role: "implement", task: "long work", backend: "codex", background: true });
	const running = await codex.started();
	assert.equal((await host.control({ action: "message", run: "run-1", message: "first" })).text, CODEX_QUEUED);
	// The reply comes while the run is still running: nothing waits for its end to say the message was not taken.
	for (const [tool, control] of [["fusion_control", host.control], ["claude_control", host.claudeControl]] as const) {
		const full = await control({ action: "message", run: "run-1", message: "second" });
		assert.equal(
			full.text,
			`run-1 (implement) is running and did not accept the message now: its input took no more, as a full one does. The message was not sent, and nothing sends it later. Send it again with ${tool} message once the run has taken what it holds, wait for its report with ${tool} wait, or stop it with ${tool} cancel.`,
		);
		assert.deepEqual([full.details.state, full.details.sent], ["running", "none"], tool);
	}
	host.notices.length = 0;
	await host.command("steer run-1 third");
	assert.deepEqual(host.notices, ["run-1 did not accept the steer now: its input took no more, as a full one does; nothing was sent, and nothing sends it later"]);
	assert.deepEqual(running.steers, ["first"], "only the steer the input took reached it");
	assert.equal(host.sent.filter(([message]) => message.details?.kind === "steer").length, 0, "no refused steer was told to the host as sent");
	running.release();
	await ended(host, "run-1");
	assert.equal(running.steers.length, 1, "and nothing resent the refused ones");
});

test("a codex plan run is continued implicitly from its recorded checkpoint, and a cap handoff starts a fresh thread on its model and effort with no provider", async () => {
	// An own in-memory double over the shared codex tripwire: what each scripted run reports is what a correct codex
	// child would, a thread at a settled checkpoint with its usage baseline and the selection read back.
	const selection = { model: "gpt-5.5", provider: "openai", effort: "high" };
	const first = { inputTokens: 1_200, cachedInputTokens: 400, outputTokens: 130, reasoningOutputTokens: 25, totalTokens: 1_330 };
	const second = { inputTokens: 3_000, cachedInputTokens: 1_000, outputTokens: 300, reasoningOutputTokens: 50, totalTokens: 3_300 };
	const codex = fakeBackend({
		name: "codex",
		scripts: [
			codexScript("thread-1", { text: "## Agreed plan\n1. do the thing", session: { backend: "codex", sessionId: "thread-1", checkpoint: "turn-1", baseline: first }, selection, contextTokens: 1_000, contextWindow: 100_000 }),
			codexScript("thread-1", { text: "## Agreed plan\n1. do the thing\n2. and the next", session: { backend: "codex", sessionId: "thread-1", checkpoint: "turn-2", baseline: second }, selection, contextTokens: 50_000, contextWindow: 100_000 }),
			codexScript("thread-2", { session: { backend: "codex", sessionId: "thread-2", checkpoint: "turn-1", baseline: first }, selection: { model: "gpt-5.5", provider: "azure", effort: "high" } }),
		],
	});
	const host = makeHost({ backends: { codex: codex.backend }, profiles: profileWith({ plan: { enabled: true, backend: "codex" } }) });
	assert.equal((await host.fusion({ role: "plan", task: "agree a plan", effort: "high" })).error, undefined);
	await ended(host, "run-1");
	assert.deepEqual(codex.starts[0]!.role, { name: "plan", effort: "high", contract: "plan.md", sandboxMode: "workspace-write", approvalPolicy: "never" });
	assert.deepEqual(host.entries()[0], { run: "run-1", role: "plan", backend: "codex", hostSessionId: "host-1", session: { backend: "codex", sessionId: "thread-1", checkpoint: "turn-1", baseline: first }, selection, contextTokens: 1_000, contextWindow: 100_000 });

	// A plan call with no handle continues the latest codex plan run, resuming its thread at the recorded checkpoint on the
	// recorded selection, provider included.
	const continued = await host.fusion({ role: "plan", task: "and the next step?" });
	assert.equal(continued.error, undefined);
	await ended(host, "run-1");
	const resumed = codex.starts[1]!;
	assert.deepEqual(resumed.intent, { kind: "resume", ref: { backend: "codex", sessionId: "thread-1", checkpoint: "turn-1", baseline: first } });
	assert.deepEqual(resumed.role, { name: "plan", model: "gpt-5.5", provider: "openai", effort: "high", contract: "plan.md", sandboxMode: "workspace-write", approvalPolicy: "never" });
	assert.equal(resumed.prompt, "and the next step?", "a continuation is no handoff and carries no earlier report");
	assert.deepEqual(host.entries()[1]!.session, { backend: "codex", sessionId: "thread-1", checkpoint: "turn-2", baseline: second });

	// Past the cap — the latest response's input against the window, 50% here — the next plan call starts a fresh thread
	// carrying the last report, on the model and effort the run verified and with no provider: the host's own is used.
	const handed = await host.fusion({ role: "plan", task: "and after that?" });
	assert.equal(handed.error, undefined);
	assert.match(handed.text ?? "", /^run-2 is a fresh plan run: run-1's context had reached 50% of its window/);
	const fresh = codex.starts[2]!;
	assert.deepEqual(fresh.intent, { kind: "new" });
	assert.deepEqual(fresh.role, { name: "plan", model: "gpt-5.5", effort: "high", contract: "plan.md", sandboxMode: "workspace-write", approvalPolicy: "never" });
	assert.match(fresh.prompt, /## Agreed plan\n1\. do the thing\n2\. and the next/, "the fresh run carries the replaced run's last report as the plan so far");
	await ended(host, "run-2");
	// What the fresh thread read back is what it records, provider included: nothing pinned the old one.
	assert.deepEqual(host.entries()[2]!.selection, { model: "gpt-5.5", provider: "azure", effort: "high" });
	assert.deepEqual(tripwireReaches("codex"), []);
});

test("a codex outcome's scalar session id and flat checkpoint are diagnostics: after wait the record keeps the tagged thread and selection alone, readable and checkpointless", async () => {
	const selection = { model: "gpt-5.5", provider: "openai", effort: "high" };
	// The scalar and the flat checkpoint disagree with the tagged thread on purpose: a writer that read either would show.
	const codex = fakeBackend({ name: "codex", scripts: [codexScript("thread-1", { sessionId: "codex-scalar", selection, extra: { modelId: "gpt-5.5", checkpoint: "codex-flat-checkpoint" } })] });
	const host = makeHost({ backends: { codex: codex.backend } });
	const ran = await host.fusion({ role: "implement", task: "do the thing", backend: "codex", effort: "high" });
	assert.equal(ran.error, undefined);
	await ended(host, "run-1");
	assert.deepEqual(host.entries(), [{ run: "run-1", role: "implement", backend: "codex", hostSessionId: "host-1", session: { backend: "codex", sessionId: "thread-1" }, selection }]);
	for (const field of ["sessionId", "checkpoint", "model", "effort"]) assert.equal(field in host.entries()[0]!, false, `no flat ${field} is written for a codex run`);
	assert.equal(ran.details.sessionId, undefined, "no scalar reaches the host's details");
	const status = await statusOf(host, "run-1");
	for (const text of [ran.text, status]) {
		assert.match(text ?? "", /codex resume thread-1/);
		assert.doesNotMatch(text ?? "", /codex-scalar|codex-flat-checkpoint|claude --resume/);
	}
	// Kept for reading, and continued through neither tool pair; each names fusion or the thread to reopen.
	const refusal = "run-1 ran on codex and recorded no trusted checkpoint, so it is kept for reading and not continued; open its thread with codex resume thread-1, and new work needs a new run without continue (a plan call takes fresh true)";
	assert.equal((await host.fusion({ continue: "run-1", task: "more" })).error, refusal);
	assert.equal((await host.claude({ continue: "run-1", task: "more" })).error, "run-1 ran on the codex backend, which the claude tool does not run; continue it with fusion and continue run-1");
	for (const control of [host.control, host.claudeControl]) {
		const left = await control({ action: "message", run: "run-1", message: "more" });
		assert.ok((left.text ?? "").startsWith("run-1 (implement) has ended: done. The message was not sent."), left.text);
		assert.ok((left.text ?? "").endsWith(`${refusal}.`), left.text);
		assert.equal(left.details.refused, true);
	}
	assert.equal(codex.starts.length, 1, "nothing was continued");
});

test("a running codex implement run holds the one writer slot against every backend; off, settings and /tree wait for it, and shutdown cancels and records it", async () => {
	await withEnv(piEnv(), async () => {
		const codex = fakeBackend({ name: "codex", scripts: [codexScript("thread-1", { pending: true, onAbort: { session: { backend: "codex", sessionId: "thread-1" } } }), codexScript("thread-2", { text: "## Answer\nyes" })] });
		const pi = fakeBackend();
		const claude = fakeBackend({ name: "claude" });
		const host = makeHost({ backends: { ...both(pi, claude), codex: codex.backend } });
		await host.fusion({ role: "implement", task: "long work", backend: "codex", background: true });
		await codex.started();
		const busy = (control: string) => `run-1 (implement) is still active; wait for it, message it or cancel it with ${control} before you start or continue another run that can change files`;
		assert.equal((await host.fusion({ role: "implement", task: "x", backend: "pi" })).error, busy("fusion_control"));
		assert.equal((await host.fusion({ role: "implement", task: "x", backend: "codex" })).error, busy("fusion_control"));
		assert.equal((await host.claude({ role: "implement", task: "x" })).error, busy("claude_control"));
		// A read-only codex ask goes next to it.
		assert.equal((await host.fusion({ role: "ask", task: "a question", backend: "codex" })).error, undefined);
		assert.deepEqual([pi.starts.length, claude.starts.length, codex.starts.length], [0, 0, 2]);

		host.notices.length = 0;
		await host.command("off");
		await host.command("profile use builtin");
		assert.deepEqual(host.notices, [
			"fusion stays on while runs are unfinished: run-1 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry /fusion off.",
			"fusion settings stay as they are while runs are unfinished: run-1 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry.",
		]);
		assert.deepEqual(await host.tree(), { cancel: true });

		await host.shutdown();
		assert.deepEqual(
			host.entries().map((entry) => [entry.run, entry.session]),
			[
				["run-2", { backend: "codex", sessionId: "thread-2" }],
				["run-1", { backend: "codex", sessionId: "thread-1" }],
			],
			"shutdown cancelled the writer and awaited its record",
		);
		assert.equal((await host.control({ action: "status", run: "run-1" })).details.state, "cancelled");
	});
});

test("fusion off and a disabled role refuse a codex call, and a disabled ask refuses a manual codex review and quietly skips an automatic one, before the codex backend is asked for anything", async () => {
	const codex = fakeBackend({ name: "codex" });
	const host = makeHost({ backends: { codex: codex.backend }, profiles: profileWith({ implement: { enabled: false, backend: "codex" }, ask: { enabled: true, backend: "codex" } }) });
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, "role implement is disabled in profile work; change /fusion config or select another profile");
	assert.equal((await host.fusion({ role: "implement", task: "x", backend: "codex" })).error, "role implement is disabled in profile work; change /fusion config or select another profile");
	await host.command("off");
	assert.equal((await host.fusion({ role: "ask", task: "x", backend: "codex" })).error, OFF_REFUSAL);
	assert.deepEqual([codex.sessions, codex.starts.length], [[], 0]);

	const dir = gitRepo("codex-ask-disabled");
	await withEnv({ PI_FUSION_AUTO_REVIEW: "1" }, async () => {
		const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }] });
		const quiet = fakeBackend({ name: "codex" });
		const reviewing = makeHost({ backends: { claude: claude.backend, codex: quiet.backend }, cwd: dir, profiles: profileWith({ ask: { enabled: false, backend: "codex" } }) });
		const done = await runThatChanged(reviewing, claude, dir, { role: "implement", task: "add the retry" });
		assert.equal(done.details.reviewedBy, undefined, "a disabled ask role starts no review");
		assert.deepEqual(reviewing.notices, [], "skipping it is not a warning");
		await reviewing.command("review run-1");
		assert.deepEqual(reviewing.notices, ["role ask is disabled in profile work, so nothing reviews run-1; change /fusion config or select another profile"]);
		assert.deepEqual([quiet.sessions, quiet.starts.length], [[], 0]);
	});
});

test("PI_FUSION_AUTO_REVIEW gives a claude run an ask reviewer configured on codex, bound read-only there and inheriting nothing from the run", async () => {
	const dir = gitRepo("codex-auto-review");
	await withEnv({ PI_FUSION_AUTO_REVIEW: "1" }, async () => {
		const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }] });
		const codex = fakeBackend({ name: "codex", scripts: [codexScript("thread-9", { text: "## Verdict\nReady" })] });
		const host = makeHost({ backends: { claude: claude.backend, codex: codex.backend }, cwd: dir, profiles: profileWith({ ask: { enabled: true, backend: "codex", model: "gpt-5-codex" } }) });
		const done = await runThatChanged(host, claude, dir, { role: "implement", task: "add the retry" });
		assert.equal(done.details.reviewedBy, "run-2");
		const reviewer = await codex.started();
		assert.deepEqual(reviewer.role, { name: "ask", model: "gpt-5-codex", contract: "ask-review.md", mode: "review", sandboxMode: "read-only", approvalPolicy: "never" });
		assert.deepEqual(reviewer.session, { kind: "new", intent: { kind: "new" } });
		await ended(host, "run-2");
		assert.deepEqual(host.entries()[1], { run: "run-2", role: "ask", mode: "review", backend: "codex", hostSessionId: "host-1", session: { backend: "codex", sessionId: "thread-9" }, selection: { model: "gpt-5.5", provider: "openai" } });
		assert.equal(claude.starts.length, 1, "no claude child reviewed it");
	});
});

test("a codex run admitted while a dollar warning or limit is set says once that codex spend is outside the estimate, and refuses or estimates nothing", async () => {
	const notice = /codex runs report no cost/;
	await withEnv({ PI_FUSION_BUDGET_WARN_USD: "5", PI_FUSION_BUDGET_LIMIT_USD: undefined }, async () => {
		const codex = fakeBackend({ name: "codex", scripts: [codexScript("thread-1"), codexScript("thread-2")] });
		const claude = fakeBackend({ name: "claude" });
		const host = makeHost({ backends: { claude: claude.backend, codex: codex.backend } });
		assert.equal((await host.claude({ role: "ask", task: "a question" })).error, undefined);
		assert.equal(host.notified.filter((one) => notice.test(one.text)).length, 0, "a claude run is priced, and says nothing of codex");
		const first = await host.fusion({ role: "ask", task: "a question", backend: "codex" });
		assert.equal((await host.fusion({ role: "ask", task: "another", backend: "codex" })).error, undefined);
		assert.deepEqual(host.notified.filter((one) => notice.test(one.text)), [
			{ text: "fusion: codex runs report no cost, so the estimate PI_FUSION_BUDGET_WARN_USD and PI_FUSION_BUDGET_LIMIT_USD act on does not include what codex runs spend; their tokens are counted, and no codex cost is estimated", level: "warning" },
		]);
		assert.equal(first.details.costUsd, undefined, "no dollar figure is shown for a codex run");
		assert.doesNotMatch(first.text ?? "", /\$/);
		await host.command("status");
		assert.match(host.notices.at(-1) ?? "", /\nsession usage: est\. \$0\.\d{4} · in .* · 3 calls · cost unknown for 2 codex runs, not in the estimate · warn at \$5\.00$/);
	});
	await withEnv({ PI_FUSION_BUDGET_WARN_USD: undefined, PI_FUSION_BUDGET_LIMIT_USD: undefined }, async () => {
		const codex = fakeBackend({ name: "codex", scripts: [codexScript("thread-1")] });
		const host = makeHost({ backends: { codex: codex.backend } });
		assert.equal((await host.fusion({ role: "ask", task: "a question", backend: "codex" })).error, undefined);
		assert.equal(host.notified.filter((one) => notice.test(one.text)).length, 0, "with no dollar control set there is nothing to qualify");
	});
});

test("a codex thread id a shell would interpret is offered as one quoted literal argument wherever the host names it, and the scalar never stands in", async () => {
	const hostile = "$(touch pwned) `id` it's";
	const quoted = "codex resume '$(touch pwned) `id` it'\\''s'";
	const codex = fakeBackend({ name: "codex", scripts: [codexScript(hostile, { sessionId: "codex-scalar" }), codexScript("-rf")] });
	const host = makeHost({ backends: { codex: codex.backend } });
	const ran = await host.fusion({ role: "ask", task: "a question", backend: "codex" });
	assert.equal(ran.error, undefined);
	await ended(host, "run-1");
	assert.ok((ran.text ?? "").endsWith(` · ${quoted}]`), ran.text);
	const status = await statusOf(host, "run-1");
	assert.ok(status.endsWith(`\n${quoted}`), status);
	const refused = await host.fusion({ continue: "run-1", task: "more" });
	assert.ok((refused.error ?? "").includes(`open its thread with ${quoted}, and new work`), refused.error);
	for (const text of [ran.text, status, refused.error]) assert.doesNotMatch(text ?? "", /codex-scalar|claude --resume/);
	// The record keeps the id exactly as the child reported it: quoting is the hint's, never the identity's.
	assert.deepEqual(host.entries()[0]!.session, { backend: "codex", sessionId: hostile });
	const option = await host.fusion({ role: "ask", task: "another", backend: "codex" });
	assert.ok((option.text ?? "").endsWith(" · codex resume -- '-rf']"), option.text);
});

/** The literal fake app-server, and the fence its node process imports first. Neither is Codex. */
const FAKE_CODEX = path.join(repoRoot, "test", "fake-codex.mjs");
const SDK_FENCE = path.join(repoRoot, "test", "sdk-fence.mjs");

/**
 * This build's own codex backend, composed by its own factory, over an explicit launch of the literal fake app-server
 * by its own path under this node, with an environment of the case's own: no codex binary, `PATH` lookup, Codex home,
 * auth or model is involved, and nothing here is evidence about a real app-server.
 */
function literalCodex(home: string, env: Record<string, string> = { FAKE_CODEX_SCENARIO: "ok" }): HostBackend {
	// The environment object is the case's own and read at each launch, so a case can tell the next fake process what
	// an earlier one left: a fixture variable, never a field of any production request.
	env.CODEX_HOME = home;
	return hostBackend(
		createCodexBackend({
			env,
			launch: (request) => ({
				launch: { command: process.execPath, args: ["--import", pathToFileURL(SDK_FENCE).href, FAKE_CODEX, ...CODEX_APP_SERVER_ARGS], cwd: request.cwd, env: { ...request.env } },
				executable: { command: process.execPath, prefix: [FAKE_CODEX], path: FAKE_CODEX, source: "override" },
				expectedCwd: fs.realpathSync(request.cwd),
				expectedCodexHome: home,
			}),
			cleanup: { exitGraceMs: 800, stopGraceMs: 1_000, leftoverGraceMs: 200, pipeGraceMs: 500, tableTimeoutMs: 3_000 },
			bounds: { initializeMs: 10_000, requestMs: 10_000, shutdownStepMs: 1_500 },
		}),
	);
}

test("a full host call runs this build's codex backend against the literal fake app-server, and an independently configured codex reviewer reviews a claude run", async () => {
	const dir = gitRepo("codex-literal");
	const home = path.join(tempDir("codex-literal-home"), "codex-home");
	const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }] });
	const host = makeHost({ backends: { claude: claude.backend, codex: literalCodex(home) }, cwd: dir, profiles: profileWith({ ask: { enabled: true, backend: "codex" } }) });
	const selection = { model: "gpt-host-default", provider: "openai" };

	const asked = await host.fusion({ role: "ask", task: "what does base.txt hold?" });
	assert.equal(asked.error, undefined);
	assert.match(asked.text ?? "", /^fake answer\n/);
	assert.match(asked.text ?? "", /\[run-1 · ask · host default -> gpt-host-default · \d+s · \d+ tool calls · in 1\.2k out 130 · context 200\/200\.0k \(<1%\) · codex resume thr-1\]$/);
	assert.equal(asked.details.costUsd, undefined);
	await ended(host, "run-1");
	// The fresh thread settled on its admitted turn and the total read at its barrier: a record a later call can continue.
	const settled = { backend: "codex", sessionId: "thr-1", checkpoint: "turn-1", baseline: { inputTokens: 1_200, cachedInputTokens: 400, outputTokens: 130, reasoningOutputTokens: 25, totalTokens: 1_330, cacheWriteInputTokens: 0 } };
	assert.deepEqual(host.entries()[0], { run: "run-1", role: "ask", mode: "answer", backend: "codex", hostSessionId: "host-1", session: settled, selection, contextTokens: 200, contextWindow: 200_000 });

	const done = await runThatChanged(host, claude, dir, { role: "implement", task: "add the retry", backend: "claude" });
	assert.equal(done.error, undefined);
	host.notices.length = 0;
	await host.command("review run-2");
	assert.deepEqual(host.notices, ["run-3 reviews run-2 in the background; its report arrives as a message"]);
	const reviewed = await ended(host, "run-3");
	assert.match(reviewed, /^run-3 \(ask, review of run-2\) done\.\n\nfake answer\n/);
	assert.deepEqual(host.entries()[2], { run: "run-3", role: "ask", mode: "review", backend: "codex", hostSessionId: "host-1", session: settled, selection, contextTokens: 200, contextWindow: 200_000 });
	assert.equal((await host.control({ action: "status", run: "run-2" })).details.reviewedBy, "run-3");
	assert.equal(claude.starts.length, 1, "no claude child reviewed it");
	assert.deepEqual(tripwireReaches("codex"), [], "the explicit registration stood in for the tripwire");
});

test("a codex run continued through the host over the literal fake resumes its thread, records the new checkpoint and baseline, and a failed resume keeps the good record", async () => {
	const dir = gitRepo("codex-continue");
	const home = path.join(tempDir("codex-continue-home"), "codex-home");
	const env: Record<string, string> = { FAKE_CODEX_SCENARIO: "resume-ok" };
	const host = makeHost({ backends: { codex: literalCodex(home, env) }, cwd: dir });
	const selection = { model: "gpt-host-default", provider: "openai", effort: "high" };

	assert.equal((await host.fusion({ role: "ask", task: "a question", backend: "codex", effort: "high" })).error, undefined);
	await ended(host, "run-1");
	const first = { inputTokens: 400, cachedInputTokens: 300, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 420, cacheWriteInputTokens: 0 };
	assert.deepEqual(host.entries()[0]!.session, { backend: "codex", sessionId: "thr-1", checkpoint: "turn-1", baseline: first });

	// The next fake process loads what the first one left — its turn and its total — and names its own turns apart.
	Object.assign(env, { FAKE_CODEX_HISTORY: JSON.stringify({ turns: [{ id: "turn-1", status: "completed" }], seed: first }), FAKE_CODEX_PREFIX: "b-" });
	const resumed = await host.fusion({ continue: "run-1", task: "a follow-up" });
	assert.equal(resumed.error, undefined);
	assert.match(resumed.text ?? "", /^loaded answer\n/);
	// The call's own share of the thread's total, not the total its history seeded.
	assert.match(resumed.text ?? "", /\[run-1 · ask · gpt-host-default · \d+s · \d+ tool calls · in 400 out 20 · context 400\/200\.0k \(<1%\) · codex resume thr-1\]$/);
	await ended(host, "run-1");
	const second = { inputTokens: 800, cachedInputTokens: 600, outputTokens: 40, reasoningOutputTokens: 10, totalTokens: 840, cacheWriteInputTokens: 0 };
	assert.deepEqual(host.entries()[1], { run: "run-1", role: "ask", mode: "answer", backend: "codex", hostSessionId: "host-1", session: { backend: "codex", sessionId: "thr-1", checkpoint: "b-turn-1", baseline: second }, selection, contextTokens: 400, contextWindow: 200_000 });

	// A thread that moved past its recorded checkpoint is refused before any turn, and the good record stays authoritative.
	Object.assign(env, { FAKE_CODEX_SCENARIO: "resume-moved", FAKE_CODEX_HISTORY: JSON.stringify({ turns: [{ id: "b-turn-1", status: "completed" }], seed: second }), FAKE_CODEX_PREFIX: "c-" });
	const moved = await host.fusion({ continue: "run-1", task: "again" });
	assert.ok((moved.text ?? moved.error ?? "").includes(RESUME_MOVED), moved.text ?? moved.error);
	await ended(host, "run-1");
	assert.equal(host.entries().length, 2, "a failed resume records nothing");
	assert.deepEqual(host.entries()[1]!.session, { backend: "codex", sessionId: "thr-1", checkpoint: "b-turn-1", baseline: second });
	assert.deepEqual(tripwireReaches("codex"), []);
});

test("an implicit codex plan call whose thread moved past its checkpoint is refused with the fresh true way on over the literal fake, and fresh true starts a new thread", async () => {
	const dir = gitRepo("codex-plan-moved");
	const home = path.join(tempDir("codex-plan-moved-home"), "codex-home");
	const env: Record<string, string> = { FAKE_CODEX_SCENARIO: "resume-ok" };
	const host = makeHost({ backends: { codex: literalCodex(home, env) }, cwd: dir, profiles: profileWith({ plan: { enabled: true, backend: "codex" } }) });
	assert.equal((await host.fusion({ role: "plan", task: "agree a plan" })).error, undefined);
	await ended(host, "run-1");
	const first = { inputTokens: 400, cachedInputTokens: 300, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 420, cacheWriteInputTokens: 0 };
	assert.deepEqual(host.entries()[0]!.session, { backend: "codex", sessionId: "thr-1", checkpoint: "turn-1", baseline: first });

	// The next plan call names no handle, so it resumes run-1's thread; the thread moved on, and the refusal names the way
	// on for a plan call, since leaving out continue alone would resume the same thread again.
	Object.assign(env, { FAKE_CODEX_SCENARIO: "resume-moved", FAKE_CODEX_HISTORY: JSON.stringify({ turns: [{ id: "turn-1", status: "completed" }], seed: first }), FAKE_CODEX_PREFIX: "b-" });
	const moved = await host.fusion({ role: "plan", task: "and the next step?" });
	const said = moved.text ?? moved.error ?? "";
	assert.ok(said.includes(RESUME_MOVED), said);
	assert.match(RESUME_MOVED, /\(a plan call takes fresh true\)$/);
	await ended(host, "run-1");
	assert.equal(host.entries().length, 1, "a failed resume records nothing, and run-1's record stays the authority");

	// fresh true starts a new plan thread rather than resuming run-1's.
	for (const key of ["FAKE_CODEX_HISTORY", "FAKE_CODEX_PREFIX"]) delete env[key];
	env.FAKE_CODEX_SCENARIO = "resume-ok";
	const fresh = await host.fusion({ role: "plan", task: "start the plan again", fresh: true });
	assert.equal(fresh.error, undefined);
	await ended(host, "run-2");
	assert.deepEqual([host.entries()[1]!.run, host.entries()[1]!.role], ["run-2", "plan"]);
	assert.deepEqual(tripwireReaches("codex"), []);
});

test("a host message to a running codex run is one turn/steer to its admitted turn, and the run's report says what became of it", async () => {
	const dir = gitRepo("codex-steer");
	const root = tempDir("codex-steer-home");
	const log = path.join(root, "requests.log");
	const host = makeHost({ backends: { codex: literalCodex(path.join(root, "codex-home"), { FAKE_CODEX_SCENARIO: "steer-script", FAKE_CODEX_STEERS: "accept", FAKE_CODEX_LOG: log }) }, cwd: dir });
	assert.equal((await host.fusion({ role: "ask", task: "long question", backend: "codex", background: true })).error, undefined);
	// Whether the turn is admitted yet or not, the message is taken: it waits for the turn and is then sent to it once.
	const sent = await host.control({ action: "message", run: "run-1", message: "focus on the parser" });
	assert.equal(sent.text, CODEX_QUEUED);
	const report = await ended(host, "run-1");
	assert.match(report, /\n\nsteered answer\n\n(Note: [^\n]*\n\n)?Note: of the 1 message sent to this codex run while it ran, 1 taken into its turn's input, which does not show the model read it\. None was sent twice\.\n/);
	const steers = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.in?.method === "turn/steer");
	assert.deepEqual(steers.map((entry) => entry.in.params), [{ threadId: "thr-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "focus on the parser" }] }]);
	// Once the run has ended, a message sends nothing.
	const late = await host.control({ action: "message", run: "run-1", message: "and more" });
	assert.match(late.text ?? "", /^run-1 \(ask\) has ended: done\. The message was not sent\./);
	assert.equal(fs.readFileSync(log, "utf8").split("\n").filter((line) => line.includes('"turn/steer"')).length, 1);
});

/** Every line the literal fake read, parsed, oldest first. */
const fakeLog = (log: string): Array<Record<string, any>> =>
	fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.in !== undefined)
		.map((entry) => entry.in);

test("a codex child's question waits through the host over the literal fake: the writer slot is held, off and /tree wait, and one answer wins without becoming a steer", async () => {
	const dir = gitRepo("codex-question");
	const root = tempDir("codex-question-home");
	const log = path.join(root, "requests.log");
	const host = makeHost({ backends: { codex: literalCodex(path.join(root, "codex-home"), { FAKE_CODEX_SCENARIO: "question", FAKE_CODEX_LOG: log }) }, cwd: dir });
	const asked = await host.fusion({ role: "implement", task: "add the helper", backend: "codex" });
	assert.match(asked.text ?? "", /^run-1 \(implement\) asks:\n\nWhich name should the helper take\?/);
	assert.equal(asked.details.state, "waiting");

	assert.match((await host.fusion({ role: "implement", task: "something else", backend: "codex" })).error ?? "", /^run-1 \(implement\) is still active/, "a waiting run keeps the writer slot");
	host.notices.length = 0;
	await host.command("off");
	assert.match(host.notices[0] ?? "", /^fusion stays on while runs are unfinished: run-1 \(implement\)/);
	assert.deepEqual(await host.tree(), { cancel: true });

	// One answer reaches the child: the user's editor is open while the host answers, and whoever is second is told.
	host.notices.length = 0;
	const answering = host.command("answer run-1");
	await until("the answer editor", () => host.editors.length > 0);
	assert.equal(host.editors[0]!.title, "Answer run-1: Which name should the helper take?");
	assert.equal((await host.control({ action: "message", run: "run-1", message: "call it fooHelper" })).text, "answer sent to run-1; the child goes on");
	host.closeEditor("call it barHelper");
	await answering;
	assert.deepEqual(host.notices, ["run-1's question was already answered by the host: call it fooHelper; your answer was not sent"]);

	const report = await ended(host, "run-1");
	assert.match(report, /^run-1 \(implement\) done\.\n\nanswer received: call it fooHelper\n/);
	const sent = fakeLog(log);
	assert.deepEqual(sent.filter((message) => message.method === undefined), [{ id: 21, result: { success: true, contentItems: [{ type: "inputText", text: "call it fooHelper" }] } }], "the child took exactly one answer");
	assert.equal(sent.filter((message) => message.method === "turn/steer").length, 0, "the losing answer was not sent as a steer");
	assert.deepEqual(sent[0]!.params.capabilities, { experimentalApi: true });
	assert.equal(host.entries().length, 1);
	assert.equal(host.entries()[0]!.session.checkpoint, "turn-1", "an answered run settles on its own turn like any other");
	assert.deepEqual(tripwireReaches("codex"), []);
});

test("cancelling a codex run while its question waits ends the question once through the run's own stop, and frees the writer slot", async () => {
	const dir = gitRepo("codex-question-cancel");
	const root = tempDir("codex-question-cancel-home");
	const log = path.join(root, "requests.log");
	const env: Record<string, string> = { FAKE_CODEX_SCENARIO: "question-cancel", FAKE_CODEX_LOG: log };
	const host = makeHost({ backends: { codex: literalCodex(path.join(root, "codex-home"), env) }, cwd: dir });
	const asked = await host.fusion({ role: "implement", task: "add the helper", backend: "codex", background: true });
	assert.equal(asked.error, undefined);
	await until("the question", async () => (await host.control({ action: "status", run: "run-1" })).details.state === "waiting");
	assert.equal((await host.control({ action: "cancel", run: "run-1" })).text, "run-1 cancelled");
	await host.control({ action: "wait", run: "run-1" });
	assert.equal((await host.control({ action: "status", run: "run-1" })).details.state, "cancelled");
	const sent = fakeLog(log);
	assert.deepEqual(sent.filter((message) => message.method === undefined), [{ id: 21, result: { success: false, contentItems: [{ type: "inputText", text: CODEX_QUESTION_UNANSWERED }] } }], "one reply, and no resent or retried question");
	assert.equal(sent.filter((message) => message.method === "turn/interrupt").length, 1);
	assert.equal(host.entries().length, 1, "the cancelled run is recorded once");

	env.FAKE_CODEX_SCENARIO = "ok";
	assert.equal((await host.fusion({ role: "implement", task: "the next task", backend: "codex" })).error, undefined, "the writer slot is free again");
	await ended(host, "run-2");
	assert.deepEqual(tripwireReaches("codex"), []);
});

test("/fusion off hides the fusion tools and starts nothing, and /fusion on gives back the ones it hid", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend();
		const claude = fakeBackend({ name: "claude" });
		const host = makeHost({ backends: both(pi, claude) });
		assert.equal((await host.fusion({ role: "implement", task: "first", backend: "pi" })).error, undefined);
		// A tool the user had turned off before stays off after on.
		host.activeTools.splice(host.activeTools.indexOf("claude_control"), 1);

		await host.command("off");
		assert.deepEqual(host.notices.at(-1), "fusion is off; no run can start until /fusion on");
		assert.deepEqual(host.activeTools, ["read", "bash", "fusion_activate"]);
		await host.command("off");
		assert.equal(host.notices.at(-1), "fusion is already off; turn it on with /fusion on");
		assert.deepEqual(host.activeTools, ["read", "bash", "fusion_activate"], "a second off changes nothing");
		await host.command("status");
		assert.match(host.notices.at(-1) ?? "", /^fusion: off\nprofile: builtin\nhistory: [^\n]*\n\n[\s\S]*?\n\nrun-1 · implement · /);

		// A call already in the host's turn when off was accepted still reaches the tools, and every one of them is refused.
		assert.equal((await host.fusion({ role: "implement", task: "second", backend: "pi" })).error, OFF_REFUSAL);
		assert.equal((await host.fusion({ role: "implement", task: "more", continue: "run-1" })).error, OFF_REFUSAL);
		assert.equal((await host.claude({ role: "ask", task: "a question" })).error, OFF_REFUSAL);
		assert.equal((await host.fusion({ role: "plan", task: "a plan", backend: "claude" })).error, OFF_REFUSAL);
		await host.command("review run-1");
		assert.equal(host.notices.at(-1), OFF_REFUSAL);
		assert.equal(pi.starts.length + claude.starts.length, 1, "nothing started while off");
		assert.equal(host.entries().length, 1, "and nothing was recorded");

		// A tool the user turned on while fusion was off survives on, and on puts back only what off took, with its own way out.
		host.activeTools.push("grep");
		await host.command("on");
		assert.equal(host.notices.at(-1), "fusion is on");
		assert.deepEqual(host.activeTools, ["read", "bash", "grep", "fusion", "fusion_control", "claude", "fusion_deactivate"]);
		await host.command("on");
		assert.equal(host.notices.at(-1), "fusion is already on");
		assert.deepEqual(host.activeTools, ["read", "bash", "grep", "fusion", "fusion_control", "claude", "fusion_deactivate"], "a second on changes nothing");
		await host.command("status");
		assert.match(host.notices.at(-1) ?? "", /^fusion: on\n/);
		const again = await host.fusion({ role: "implement", task: "more", continue: "run-1" });
		assert.equal(again.error, undefined);
		assert.equal(pi.starts.length, 2, "a call after on starts its run");
	});
});

test("/fusion off is refused while a run is running or waiting for an answer, and changes nothing", async () => {
	await withEnv(piEnv(), async () => {
		const pi = fakeBackend({ scripts: [{ pending: true }, { questions: ["Which name?"] }, {}] });
		const host = makeHost({ backends: both(pi) });
		const tools = [...host.activeTools];
		await host.fusion({ role: "implement", task: "long work", backend: "pi", background: true });
		const running = await pi.started();
		await host.command("off");
		assert.equal(
			host.notices.at(-1),
			"fusion stays on while runs are unfinished: run-1 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry /fusion off.",
		);
		assert.deepEqual(host.activeTools, tools);
		running.release();
		await ended(host, "run-1");

		const asked = await host.fusion({ role: "ask", task: "a question", backend: "pi" });
		assert.equal(asked.details.state, "waiting");
		await host.command("off");
		assert.match(host.notices.at(-1) ?? "", /^fusion stays on while runs are unfinished: run-2 \(ask\)\./);
		assert.deepEqual(host.activeTools, tools, "the host can still answer the run it is waiting on");
		await host.control({ action: "message", run: "run-2", message: "call it foo" });
		await ended(host, "run-2");
		await host.command("off");
		assert.equal(host.notices.at(-1), "fusion is off; no run can start until /fusion on");
		assert.deepEqual(host.activeTools, ["read", "bash", "fusion_activate"]);
	});
});

test("/fusion off is refused while an automatic review is unfinished, and on starts no review of its own", async () => {
	const dir = gitRepo("off-auto-review");
	await withEnv({ ...piEnv(), PI_FUSION_AUTO_REVIEW: "1" }, async () => {
		const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }, { pending: true }, {}] });
		const host = makeHost({ backends: both(fakeBackend(), claude), cwd: dir });
		const done = await runThatChanged(host, claude, dir, { role: "implement", task: "add the retry", backend: "claude" });
		assert.equal(done.details.reviewedBy, "run-2");
		const review = await claude.started(2);
		await host.command("off");
		assert.match(host.notices.at(-1) ?? "", /^fusion stays on while runs are unfinished: run-2 \(ask\)\./);
		review.release();
		await ended(host, "run-2");
		await host.command("off");
		assert.equal(host.notices.at(-1), "fusion is off; no run can start until /fusion on");
		await host.command("on");
		assert.equal(claude.starts.length, 2, "on starts no review of its own");
	});
});
