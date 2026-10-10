import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { CODEX_CONTRACT_FILES, type CodexCall, codexRole } from "../extensions/backends/codex-binding.ts";
import { CODEX_APP_SERVER_ARGS, type CodexLaunch, type CodexLaunchRequest } from "../extensions/backends/codex-launch.ts";
import { CODEX_CLIENT_VERSION_UNKNOWN, CODEX_QUESTION_REQUIRED, CODEX_SESSION_INVALID, CONTRACT_UNREADABLE, type CodexBackendDeps, type CodexCallReport, codexClientInfo, createCodexBackend } from "../extensions/backends/codex.ts";
import {
	CLEANUP_ATTENTION,
	CLEANUP_UNCERTAIN,
	CODEX_FOREIGN_SESSION,
	CODEX_NO_CHECKPOINT,
	callUsage,
	codexFeed,
	CWD_MISMATCH,
	FORK_NO_TIP,
	FORK_SAME_THREAD,
	FORK_TIP_UNSETTLED,
	finishCodexRun,
	HOME_MISMATCH,
	NO_FINAL,
	NO_USAGE,
	NOT_IDLE,
	newCodexRun,
	RESUME_MOVED,
	RESUME_UNSETTLED,
	RUN_ABORTED,
	RUN_CANCELLED,
	threadStartProblem,
	USAGE_BASELINE_INCONSISTENT,
	type CodexRun,
} from "../extensions/backends/codex-outcome.ts";
import type { CodexThreadStart } from "../extensions/backends/codex-protocol.ts";
import {
	type CodexBounds,
	type CodexChild,
	type CodexChildOptions,
	type CodexExit,
	CODEX_QUESTION_TOOL_SPEC,
	CODEX_QUESTION_UNANSWERED,
	CodexTransportError,
	startCodexChild,
} from "../extensions/backends/codex-transport.ts";
import { type ChildControl, type ChildEvent, type CodexUsageBaseline, failed, hostBackend, type ResolvedSelection, type SessionIntent } from "../extensions/backends/types.ts";
import { type OwnedCleanup, productionFacilities } from "../extensions/process-tree.ts";

/*
 * The fresh-run Codex backend composed over its real launch shape, transport and outcome mapping, driven against
 * `test/fake-codex.mjs`: a builtins-only node program speaking literal app-server JSON-RPC, launched by its own path
 * under this host's node through an injected launch. No Codex package, binary, home, auth or `PATH` lookup is involved,
 * and nothing here is evidence about what a real Codex app-server does. The shapes are a source reading of 0.160.0.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CODEX = path.join(repoRoot, "test", "fake-codex.mjs");
const FENCE = path.join(repoRoot, "test", "sdk-fence.mjs");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version as string;

const TEST_BOUNDS: Partial<CodexBounds> = { initializeMs: 10_000, requestMs: 10_000, shutdownStepMs: 1_500 };
const TEST_CLEANUP: OwnedCleanup = { exitGraceMs: 800, stopGraceMs: 1_000, leftoverGraceMs: 200, pipeGraceMs: 500, tableTimeoutMs: 3_000 };
const CASE_DEADLINE_MS = 20_000;

/** A thread gets the shared role contract alone, on fresh calls and continuations alike. */
const readContract = (name: string): string => `contract ${name}\n`;
const INSTRUCTIONS = (role: "implement" | "ask") => `contract ${role === "ask" ? "ask-answer.md" : "implement.md"}\n`;
/** Every fixture call has a callback, as the host does; an unscripted question must not get an invented answer. */
const unexpectedQuestion = async (): Promise<string> => { throw new Error("unexpected question in a case without a scripted answer"); };

const RETAINED: string[] = [];
after(() => assert.deepEqual(RETAINED, [], "every case proved its fake was over before its root was removed"));

async function within<T>(what: string, work: Promise<T>, ms = CASE_DEADLINE_MS): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} had not come back inside the case deadline of ${ms}ms`)), ms);
	});
	work.catch(() => {});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** A child as the backend is handed it, delegating every member and counting the shutdowns asked of it. */
function counted(child: CodexChild, hooks: { onTurn?: () => void; onRead?: (when: "sent" | "answered") => void } = {}): { child: CodexChild; shutdowns: () => number } {
	let shutdowns = 0;
	return {
		shutdowns: () => shutdowns,
		child: {
			get pid() {
				return child.pid;
			},
			get initialize() {
				return child.initialize;
			},
			get counters() {
				return child.counters;
			},
			get exited() {
				return child.exited;
			},
			startThread: (params, timeoutMs) => child.startThread(params, timeoutMs),
			startTurn: async (params, timeoutMs) => {
				const turn = await child.startTurn(params, timeoutMs);
				hooks.onTurn?.();
				return turn;
			},
			readThread: async (threadId, timeoutMs) => {
				const read = child.readThread(threadId, timeoutMs);
				hooks.onRead?.("sent");
				const answer = await read;
				hooks.onRead?.("answered");
				return answer;
			},
			resumeThread: (params, timeoutMs) => child.resumeThread(params, timeoutMs),
			forkThread: (params, timeoutMs) => child.forkThread(params, timeoutMs),
			latestTurn: (threadId, timeoutMs) => child.latestTurn(threadId, timeoutMs),
			steer: (turn, text, timeoutMs) => child.steer(turn, text, timeoutMs),
			interrupt: (turn, timeoutMs) => child.interrupt(turn, timeoutMs),
			threadStatus: (threadId) => child.threadStatus(threadId),
			shutdown: (reason) => {
				shutdowns += 1;
				return child.shutdown(reason);
			},
		},
	};
}

interface Outcome {
	run: CodexRun;
	events: ChildEvent[];
	progress: number;
	report: CodexCallReport;
	/** Shutdowns the composition asked of the child it was handed; undefined when it was handed none. */
	shutdowns?: number;
	/** The control the run was handed, as it was left. */
	input: ChildControl;
}

interface CaseOptions {
	env?: Record<string, string>;
	/** What the launch predicts the child will report, apart from the fake's own. */
	expectedCwd?: string;
	expectedCodexHome?: string;
	deps?: Partial<CodexBackendDeps>;
	signal?: AbortSignal;
	/** Called when the start seam is entered, before the transport is. */
	onStart?: () => void;
	/** Called once the backend's turn/start has been answered. */
	onTurn?: () => void;
	/** Called once the backend's thread/read is issued, and again once it is answered. */
	onRead?: (when: "sent" | "answered") => void;
	onEvent?: (event: ChildEvent) => void;
	prompt?: string;
	/** What the host asks of the session, mapped by the backend's own `session`. A new thread when unset. */
	intent?: SessionIntent;
	/** The selection the run it continues recorded, which the binding repeats. */
	recorded?: ResolvedSelection;
	/** Steers pushed into the run's control before the run is started. */
	steers?: string[];
	/** Overrides the fixture's fail-on-unexpected-question callback, always handed to the backend as the host does. */
	onQuestion?: (question: string, signal: AbortSignal) => Promise<string>;
}

interface Fixture {
	root: string;
	work: string;
	home: string;
	log(): { in?: Record<string, any>; stdin?: string }[];
	call(call: CodexCall, options?: CaseOptions): Promise<Outcome>;
	launches: CodexLaunchRequest[];
}

const requests = (fixture: Fixture) => fixture.log().filter((entry) => entry.in !== undefined).map((entry) => entry.in!);
const methods = (fixture: Fixture) => requests(fixture).map((message) => message.method ?? "reply");
const sent = (fixture: Fixture, method: string) => requests(fixture).filter((message) => message.method === method);

/**
 * One case and its own root: a work directory the fake runs in, the Codex home it reports and a log it appends to.
 * Every child the backend was handed is awaited to its exit, and the root is removed only when every one is proved over.
 */
async function withBackend(scenario: string, body: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-codex-backend-"));
	fs.chmodSync(root, 0o700);
	const work = path.join(root, "work");
	fs.mkdirSync(work);
	const home = path.join(root, "codex-home");
	const logFile = path.join(root, "requests.log");
	const exits: CodexExit[] = [];
	const children: CodexChild[] = [];
	let attempts = 0;
	const launches: CodexLaunchRequest[] = [];
	const fixture: Fixture = {
		root,
		work,
		home,
		launches,
		log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
		call: async (call, options = {}) => {
			let shutdowns: (() => number) | undefined;
			const launch = (request: CodexLaunchRequest): CodexLaunch => {
				launches.push(request);
				return {
					launch: { command: process.execPath, args: ["--import", pathToFileURL(FENCE).href, FAKE_CODEX, ...CODEX_APP_SERVER_ARGS], cwd: request.cwd, env: { ...request.env } },
					executable: { command: process.execPath, prefix: [FAKE_CODEX], path: FAKE_CODEX, source: "override" },
					expectedCwd: options.expectedCwd ?? fs.realpathSync(request.cwd),
					expectedCodexHome: options.expectedCodexHome ?? home,
				};
			};
			const start = async (startOptions: CodexChildOptions): Promise<CodexChild> => {
				attempts += 1;
				options.onStart?.();
				try {
					const child = await startCodexChild(startOptions);
					children.push(child);
					const wrapped = counted(child, { ...(options.onTurn === undefined ? {} : { onTurn: options.onTurn }), ...(options.onRead === undefined ? {} : { onRead: options.onRead }) });
					shutdowns = wrapped.shutdowns;
					return wrapped.child;
				} catch (error) {
					if (error instanceof CodexTransportError && error.finalExit) exits.push(error.finalExit);
					throw error;
				}
			};
			let report: CodexCallReport | undefined;
			const backend = createCodexBackend({
				readContract,
				env: { FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_LOG: logFile, CODEX_HOME: home, ...options.env },
				launch,
				start,
				cleanup: TEST_CLEANUP,
				bounds: TEST_BOUNDS,
				onCall: (made) => (report = made),
				...options.deps,
			});
			const events: ChildEvent[] = [];
			let progress = 0;
			const input = backend.control();
			for (const steer of options.steers ?? []) assert.equal(input.push(steer), true, "a steer is taken before the run starts");
			const run = await within(
				"a run",
				backend.run({
					role: codexRole(call, options.recorded, {}),
					prompt: options.prompt ?? "do the task",
					cwd: work,
					session: backend.session(options.intent ?? { kind: "new" }),
					signal: options.signal,
					input,
					onQuestion: options.onQuestion ?? unexpectedQuestion,
					onProgress: () => (progress += 1),
					onEvent: (event) => {
						events.push(event);
						options.onEvent?.(event);
					},
					killGraceMs: 1_000,
				}),
			);
			return { run, events, progress, report: report!, input, ...(shutdowns === undefined ? {} : { shutdowns: shutdowns() }) };
		},
	};
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	for (const child of children) {
		try {
			exits.push(await within("an exit", child.exited));
		} catch (error) {
			failure ??= error;
		}
	}
	const over = exits.length === attempts && exits.every((exit) => ["unspawned", "exited", "stopped"].includes(exit.cleanup.root) && exit.cleanup.stdio === "closed" && exit.counters.streamsUnclosed === 0 && !exit.cleanup.leftovers.length);
	if (over) fs.rmSync(root, { recursive: true, force: true });
	else {
		RETAINED.push(root);
		failure ??= new Error(`the root ${root} was kept: not every child of this case was proved over`);
	}
	if (failure !== undefined) throw failure;
}

/** What every run that was handed a child shares: one shutdown, one terminal event, and its stop reason. */
function ended(outcome: Outcome, stopReason: string): void {
	assert.equal(outcome.shutdowns, 1, "the composition stops the child it was handed exactly once");
	assert.equal(outcome.report.shutdowns, 1);
	assert.equal(outcome.events.filter((event) => event.type === "turn_result").length, 1, "one terminal event");
	assert.equal(outcome.run.stopReason, stopReason, outcome.run.errorMessage);
	assert.equal(outcome.run.checkpoint, undefined, "no flat checkpoint is ever set");
	// Only a success that stays one settles on a checkpoint with its baseline; nothing else claims a baseline.
	if (stopReason === "stop") assert.ok(outcome.run.session?.backend === "codex" && outcome.run.session.checkpoint !== undefined && outcome.run.session.baseline !== undefined);
	else assert.ok(outcome.run.session?.backend !== "codex" || outcome.run.session.baseline === undefined);
	assert.equal(outcome.input.open, false, "the run's input is closed once it has ended");
	assert.equal(outcome.run.costUsd, undefined, "no cost is reported or estimated");
	assert.equal(outcome.run.models, undefined);
}

/* ------------------------------------------------------------------------------------------------------------------
 * Success
 * ---------------------------------------------------------------------------------------------------------------- */

test("a host-default implement run: one thread, one turn, the readback barrier, the parent thread's usage and one clean stop", async () => {
	await withBackend("ok", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" });
		const { run } = outcome;
		ended(outcome, "stop");
		assert.equal(failed(run), false);
		assert.equal(run.exitCode, 0);
		assert.equal(run.signal, null);
		assert.equal(run.aborted, false);
		assert.equal(run.errorMessage, undefined);
		assert.equal(run.cleanupNotice, undefined);
		assert.equal(run.text, "fake answer\n\nNote: the codex child reported no effort for this thread, so this run records none and its effort was whatever the host's Codex configuration chose.");
		// The admitted turn, completed, is the checkpoint, and the thread's total at the readback barrier its baseline.
		assert.deepEqual(run.session, { backend: "codex", sessionId: "thr-1", checkpoint: "turn-1", baseline: { inputTokens: 1_200, cachedInputTokens: 400, outputTokens: 130, reasoningOutputTokens: 25, totalTokens: 1_330, cacheWriteInputTokens: 0 } });
		assert.equal(run.sessionId, "thr-1", "a diagnostic scalar the host's writer filters for codex");
		assert.deepEqual(run.selection, { model: "gpt-host-default", provider: "openai" });
		assert.equal(run.modelId, "gpt-host-default");
		assert.equal(run.role.model, undefined, "the role keeps no model it did not choose");
		// The late usage, cumulative for this fresh thread: input already counts the cached part, which is never added again.
		assert.deepEqual([run.tokensIn, run.tokensOut, run.cacheRead, run.cacheWrite], [1_200, 130, 400, 0]);
		assert.equal(run.contextTokens, 200, "the latest response's input, not the thread's total");
		assert.equal(run.contextWindow, 200_000);
		assert.deepEqual(outcome.events.filter((event) => event.type === "init"), [{ type: "init", sessionId: "thr-1" }]);
		assert.deepEqual(outcome.events.at(-1), { type: "turn_result", ok: true });
		assert.equal(outcome.report.stage, "done");

		assert.deepEqual(methods(fixture), ["initialize", "initialized", "thread/start", "turn/start", "thread/read"]);
		assert.deepEqual(sent(fixture, "initialize")[0].params, { clientInfo: { name: "pi-fusion", version: PACKAGE_VERSION, title: "Pi-Fusion" }, capabilities: { experimentalApi: true } });
		assert.notEqual(PACKAGE_VERSION, "0");
		assert.deepEqual(sent(fixture, "thread/start")[0].params, { sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: INSTRUCTIONS("implement"), dynamicTools: [{ ...CODEX_QUESTION_TOOL_SPEC }] });
		assert.deepEqual(sent(fixture, "turn/start")[0].params, { threadId: "thr-1", input: [{ type: "text", text: "do the task" }] });
		assert.deepEqual(fixture.launches.map((launch) => launch.cwd), [fixture.work]);
		assert.equal(fixture.launches[0].env?.CODEX_HOME, fixture.home, "the launch takes the environment it is given, unchanged");
	});
});

test("an explicit model and effort: the model on thread/start, the effort on turn/start only, and both verified after the turn", async () => {
	await withBackend("ok", async (fixture) => {
		const outcome = await fixture.call({ role: "ask", model: "gpt-5", effort: "high" });
		ended(outcome, "stop");
		assert.equal(outcome.run.text, "fake answer");
		assert.deepEqual(outcome.run.selection, { model: "gpt-5", provider: "openai", effort: "high" });
		assert.deepEqual(sent(fixture, "thread/start")[0].params, { model: "gpt-5", sandbox: "read-only", approvalPolicy: "never", developerInstructions: INSTRUCTIONS("ask"), dynamicTools: [{ ...CODEX_QUESTION_TOOL_SPEC }] });
		assert.deepEqual(sent(fixture, "turn/start")[0].params, { threadId: "thr-1", input: [{ type: "text", text: "do the task" }], effort: "high" });
	});
});

test("an unnamed effort is the readback's, then the start's with a note, and none is invented", async () => {
	await withBackend("host-effort", async (fixture) => {
		const read = await fixture.call({ role: "implement" });
		ended(read, "stop");
		assert.deepEqual(read.run.selection, { model: "gpt-host-default", provider: "openai", effort: "medium" });
		assert.equal(read.run.text, "fake answer");
		const fallback = await fixture.call({ role: "implement" }, { env: { FAKE_CODEX_READ: JSON.stringify({ reasoningEffort: null }) } });
		ended(fallback, "stop");
		assert.deepEqual(fallback.run.selection, { model: "gpt-host-default", provider: "openai", effort: "medium" });
		assert.match(fallback.run.text, /Note: the codex thread read back no effort after its turn, so the effort its start reported, medium, is what this run records\./);
	});
});

test("a readback with no model and no effort, and usage with no window: the start's model is kept and each gap is noted", async () => {
	await withBackend("null-readback", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" });
		ended(outcome, "stop");
		assert.deepEqual(outcome.run.selection, { model: "gpt-host-default", provider: "openai" });
		assert.equal(outcome.run.contextWindow, undefined, "no window is guessed");
		assert.equal(outcome.run.contextTokens, undefined, "and with no window no context is shown either");
		const notes = outcome.run.text.split("\n\n").slice(1);
		assert.deepEqual(notes, [
			"Note: the codex thread read back no model after its turn, so the model its start reported, gpt-host-default, is what this run records.",
			"Note: the codex child reported no effort for this thread, so this run records none and its effort was whatever the host's Codex configuration chose.",
			"Note: the codex child reported no context window, so this run shows no share of one.",
		]);
	});
});

test("a retryable error is not an end: the turn goes on and completes", async () => {
	await withBackend("retry", async (fixture) => {
		const outcome = await fixture.call({ role: "implement", effort: "low" });
		ended(outcome, "stop");
		assert.equal(outcome.run.text, "answer after a retry");
		assert.deepEqual(outcome.run.selection, { model: "gpt-host-default", provider: "openai", effort: "low" });
	});
});

test("a host-default reroute is accepted with a note quoting it, and the selection stays the configured model", async () => {
	await withBackend("reroute", async (fixture) => {
		const outcome = await fixture.call({ role: "implement", effort: "high" });
		ended(outcome, "stop");
		assert.deepEqual(outcome.run.selection, { model: "gpt-host-default", provider: "openai", effort: "high" });
		assert.equal(outcome.run.modelId, "gpt-host-default");
		assert.match(outcome.run.text, /Note: Codex rerouted this turn from gpt-host-default to gpt-safer \(highRiskCyberActivity\); the selection recorded is the configured gpt-host-default, not a model the turn was rerouted to\./);
	});
});

test("an explicit-model run that Codex rerouted fails, keeping its thread and no selection", async () => {
	await withBackend("reroute", async (fixture) => {
		const outcome = await fixture.call({ role: "implement", model: "gpt-host-default", effort: "high" });
		ended(outcome, "verify");
		assert.equal(failed(outcome.run), true);
		assert.match(outcome.run.errorMessage ?? "", /^Codex rerouted this turn from gpt-host-default to gpt-safer \(highRiskCyberActivity\), so it did not run on the model gpt-host-default this call named$/);
		assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-1" });
		assert.equal(outcome.run.selection, undefined);
	});
});

test("a subagent's thread and a foreign turn of the same thread cannot win: their final text, usage and tools stay out", async () => {
	await withBackend("foreign-final", async (fixture) => {
		const outcome = await fixture.call({ role: "implement", effort: "high" });
		ended(outcome, "stop");
		assert.equal(outcome.run.text, "own final report");
		assert.deepEqual([outcome.run.tokensIn, outcome.run.tokensOut, outcome.run.cacheRead], [300, 30, 100]);
		assert.equal(outcome.run.toolCalls, 1);
		const tools = outcome.events.filter((event) => event.type === "tool_call" || event.type === "tool_result");
		assert.deepEqual(tools, [
			{ type: "tool_call", name: "command", brief: "ls -la", id: "cmd-1", input: { command: "ls -la\nsecond line" } },
			{ type: "tool_result", toolUseId: "cmd-1", text: "file-a\nfile-b", isError: false },
		]);
		assert.ok(!JSON.stringify(outcome.events).includes("subagent"), "nothing of the subagent's reached the monitor");
	});
});

test("approval requests are declined and listed, and a run that then reports completes", async () => {
	await withBackend("approvals", async (fixture) => {
		const outcome = await fixture.call({ role: "implement", effort: "high" });
		ended(outcome, "stop");
		assert.equal(outcome.run.text, "declined and reported");
		assert.deepEqual(outcome.run.deniedTools, ["command approval declined: rm -rf /tmp/fake-target", "file approval declined"]);
		assert.deepEqual(
			requests(fixture).filter((message) => message.method === undefined),
			[
				{ id: "srv-1", result: { decision: "decline" } },
				{ id: 7, result: { decision: "decline" } },
				{ id: 8, result: { decision: "decline" } },
			],
		);
	});
});

/* ------------------------------------------------------------------------------------------------------------------
 * Refusals before the turn
 * ---------------------------------------------------------------------------------------------------------------- */

test("a Codex home other than the predicted one is refused before any thread is started", async () => {
	await withBackend("ok", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" }, { expectedCodexHome: path.join(fixture.root, "other-home") });
		ended(outcome, "startup");
		assert.equal(outcome.run.errorMessage, HOME_MISMATCH);
		assert.equal(outcome.run.session, undefined);
		assert.deepEqual(methods(fixture), ["initialize", "initialized"]);
	});
});

test("the home and the working directory are compared canonical: a symlinked spelling of the same directory is the same", async () => {
	await withBackend("ok", async (fixture) => {
		const link = path.join(fixture.root, "home-link");
		fs.mkdirSync(fixture.home);
		fs.symlinkSync(fixture.home, link);
		const cwdLink = path.join(fixture.root, "work-link");
		fs.symlinkSync(fixture.work, cwdLink);
		const outcome = await fixture.call({ role: "implement" }, { expectedCodexHome: link, expectedCwd: cwdLink });
		ended(outcome, "stop");
	});
});

const START_MISMATCHES: [string, Record<string, unknown>, CodexCall, RegExp][] = [
	["the sandbox", { sandbox: { type: "dangerFullAccess" } }, { role: "implement" }, /^the codex child started its thread in a dangerFullAccess sandbox, not the workspace-write sandbox role implement runs in/],
	["the read-only sandbox", { sandbox: { type: "workspaceWrite", networkAccess: false } }, { role: "ask" }, /in a workspaceWrite sandbox, not the read-only sandbox role ask runs in/],
	["the approval policy", { approvalPolicy: "on-request" }, { role: "implement" }, /with approval policy on-request, not never/],
	["a null approval policy", { approvalPolicy: null }, { role: "implement" }, /did not confirm approval policy never for its thread/],
	["a granular approval policy object", { approvalPolicy: { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true } } }, { role: "implement" }, /did not confirm approval policy never for its thread/],
	["an explicit model", { model: "gpt-other" }, { role: "implement", model: "gpt-5" }, /on model gpt-other, not the model gpt-5 this call named/],
];

test("the start check confirms approval policy never exactly: an answer that reports none is refused like a mismatch", () => {
	const role = codexRole({ role: "implement" }, undefined, {});
	const start: CodexThreadStart = { threadId: "thr-1", model: "gpt-5", modelProvider: "openai", cwd: "/work", sandbox: { type: "workspaceWrite" }, reasoningEffort: null, approvalPolicy: "never" };
	assert.equal(threadStartProblem(role, start, "/work", "/work"), undefined);
	const { approvalPolicy: _never, ...missing } = start;
	assert.equal(threadStartProblem(role, missing, "/work", "/work"), "the codex child did not confirm approval policy never for its thread, so no turn was started");
	assert.match(threadStartProblem(role, { ...start, approvalPolicy: "untrusted" }, "/work", "/work") ?? "", /with approval policy untrusted, not never/);
});

for (const [what, over, call, message] of START_MISMATCHES) {
	test(`a thread/start answer that disagrees on ${what} is refused before any turn`, async () => {
		await withBackend("ok", async (fixture) => {
			const outcome = await fixture.call(call, { env: { FAKE_CODEX_START: JSON.stringify(over) } });
			ended(outcome, "thread");
			assert.match(outcome.run.errorMessage ?? "", message);
			assert.equal(outcome.run.session, undefined, "a thread that failed its checks is not published");
			assert.equal(sent(fixture, "turn/start").length, 0);
		});
	});
}

test("a working directory other than the run's is refused before any turn", async () => {
	await withBackend("ok", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" }, { expectedCwd: fixture.root });
		ended(outcome, "thread");
		assert.equal(outcome.run.errorMessage, CWD_MISMATCH);
		assert.equal(sent(fixture, "turn/start").length, 0);
	});
});

/* ------------------------------------------------------------------------------------------------------------------
 * Failures after the turn
 * ---------------------------------------------------------------------------------------------------------------- */

const READ_MISMATCHES: [string, CodexCall, Record<string, unknown>, string][] = [
	["another model", { role: "implement" }, { model: "gpt-other" }, "the codex thread read back model gpt-other after its turn, not the model gpt-host-default it started on"],
	["another provider", { role: "implement" }, { modelProvider: "azure" }, "the codex thread read back provider azure after its turn, not the provider openai it started on"],
	["another effort", { role: "implement", effort: "high" }, { reasoningEffort: "low" }, "the codex thread read back effort low after its turn, not the effort high this call named"],
	["no effort for a named one", { role: "implement", effort: "high" }, { reasoningEffort: null }, "the codex thread read back no effort after a turn this call ran at effort high, so the effort it ran at is unverified"],
	["a thread that is not idle", { role: "implement" }, { status: { type: "active", activeFlags: [] } }, NOT_IDLE],
];

for (const [what, call, over, message] of READ_MISMATCHES) {
	test(`a readback with ${what} fails the run after its turn, keeping its thread and no selection`, async () => {
		await withBackend("ok", async (fixture) => {
			const outcome = await fixture.call(call, { env: { FAKE_CODEX_READ: JSON.stringify(over) } });
			ended(outcome, "verify");
			assert.equal(outcome.run.errorMessage, message);
			assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-1" });
			assert.equal(outcome.run.selection, undefined);
			assert.equal(outcome.run.text, "fake answer", "the turn's own message is shown on the failed run");
		});
	});
}

for (const [scenario, message] of [
	["no-final", NO_FINAL],
	["no-usage", NO_USAGE],
] as const) {
	test(`a completed turn with ${scenario === "no-final" ? "no final agent message" : "no usage"} is not a success`, async () => {
		await withBackend(scenario, async (fixture) => {
			const outcome = await fixture.call({ role: "implement" });
			ended(outcome, "verify");
			assert.equal(outcome.run.errorMessage, message);
			assert.equal(outcome.run.selection, undefined);
		});
	});
}

test("a terminal error and a failed turn fail the run with the child's own bounded message", async () => {
	await withBackend("errors", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" });
		ended(outcome, "turn");
		assert.equal(outcome.run.errorMessage, "the codex turn failed: usage limit reached (usageLimitExceeded)");
		assert.equal(sent(fixture, "thread/read").length, 0, "a failed turn is not read back as if it had worked");
	});
});

test("a turn the child interrupted on its own is a failure, not a cancellation, and shows only its own message", async () => {
	await withBackend("self-interrupt", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" });
		ended(outcome, "turn");
		assert.equal(outcome.run.aborted, false);
		assert.equal(outcome.run.errorMessage, "the codex turn was interrupted before it finished");
		assert.equal(outcome.run.text, "half an answer");
		assert.equal(sent(fixture, "turn/interrupt").length, 0);
	});
});

test("a question for the user is unsupported: answered with an error on the wire, the turn interrupted and the run failed", async () => {
	await withBackend("user-input", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" });
		ended(outcome, "turn");
		assert.match(outcome.run.errorMessage ?? "", /asked for something this backend does not support: it sent a item\/tool\/requestUserInput request/);
		assert.ok(sent(fixture, "turn/interrupt").length === 1);
	});
});

test("a turn/start that is not answered in its bound fails once, is never retried, and its late answer changes nothing", async () => {
	await withBackend("late-turn-ack", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" }, { deps: { bounds: { ...TEST_BOUNDS, requestMs: 1_000 } } });
		ended(outcome, "turn");
		assert.match(outcome.run.errorMessage ?? "", /did not answer turn\/start inside its bound/);
		assert.equal(sent(fixture, "turn/start").length, 1);
		assert.equal(sent(fixture, "turn/interrupt").length, 0, "nothing is interrupted on a guessed id");
		assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-1" });
	});
});

test("a child that crashes mid-turn fails the run with its own exit", async () => {
	await withBackend("crash", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" });
		ended(outcome, "turn");
		assert.equal(outcome.run.exitCode, 3);
		assert.match(outcome.run.errorMessage ?? "", /exited/);
	});
});

test("a verified success whose child then exits uncleanly is demoted, keeping its thread and verified selection", async () => {
	await withBackend("ok", async (fixture) => {
		const outcome = await fixture.call({ role: "implement", effort: "high" }, { env: { FAKE_CODEX_EXIT_CODE: "2" } });
		ended(outcome, "cleanup");
		assert.equal(failed(outcome.run), true);
		assert.equal(outcome.run.exitCode, 2);
		assert.ok(outcome.run.errorMessage?.startsWith(CLEANUP_UNCERTAIN));
		assert.equal(outcome.run.cleanupNotice, undefined, "an unclean exit is a failure, not something left behind");
		assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-1" });
		assert.deepEqual(outcome.run.selection, { model: "gpt-host-default", provider: "openai", effort: "high" });
	});
});

test("a cleanup that left a concern demotes a success, said once in one cleanup notice", async () => {
	await withBackend("ok", async (fixture) => {
		const facilities = { ...productionFacilities(), table: async () => undefined };
		const outcome = await fixture.call({ role: "implement", effort: "high" }, { deps: { cleanup: { ...TEST_CLEANUP, facilities } } });
		ended(outcome, "cleanup");
		assert.equal(outcome.run.cleanupNotice, `${CLEANUP_ATTENTION}: discovery-unavailable`);
		assert.equal(outcome.run.errorMessage, `${CLEANUP_UNCERTAIN} (the cleanup after it left: discovery-unavailable)`);
		const said = outcome.events.filter((event) => JSON.stringify(event).includes(CLEANUP_ATTENTION));
		assert.deepEqual(said, [], "the notice is the run's own field, not repeated in an event");
	});
});

/* ------------------------------------------------------------------------------------------------------------------
 * Cancellation
 * ---------------------------------------------------------------------------------------------------------------- */

test("a run cancelled before it starts reads, locates and starts nothing", async () => {
	await withBackend("ok", async (fixture) => {
		const controller = new AbortController();
		controller.abort();
		let reads = 0;
		const outcome = await fixture.call({ role: "implement" }, { signal: controller.signal, deps: { readContract: (name) => (reads += 1, readContract(name)) } });
		assert.equal(outcome.shutdowns, undefined);
		assert.equal(outcome.run.aborted, true);
		assert.equal(outcome.run.stopReason, "aborted");
		assert.equal(outcome.run.errorMessage, RUN_CANCELLED);
		assert.equal(reads, 0);
		assert.deepEqual(fixture.launches, []);
		assert.equal(outcome.report.stage, "aborted-before-start");
		assert.deepEqual(fixture.log(), []);
	});
});

test("a run cancelled as its child starts is refused by the transport before a spawn, and stops nothing twice", async () => {
	await withBackend("ok", async (fixture) => {
		const controller = new AbortController();
		const outcome = await fixture.call({ role: "implement" }, { signal: controller.signal, onStart: () => controller.abort() });
		assert.equal(outcome.shutdowns, undefined, "no child was handed over, so none is stopped from here");
		assert.equal(outcome.run.aborted, true);
		assert.equal(outcome.run.errorMessage, RUN_ABORTED);
		assert.equal(outcome.report.stage, "startup");
		assert.deepEqual(fixture.log(), [], "nothing was spawned");
	});
});

test("a run cancelled once its thread is verified starts no turn and stops its child once", async () => {
	await withBackend("ok", async (fixture) => {
		const controller = new AbortController();
		const outcome = await fixture.call({ role: "implement" }, { signal: controller.signal, onEvent: (event) => event.type === "init" && controller.abort() });
		ended(outcome, "aborted");
		assert.equal(outcome.run.aborted, true);
		assert.equal(outcome.run.errorMessage, RUN_ABORTED);
		assert.equal(sent(fixture, "turn/start").length, 0);
	});
});

test("a run cancelled mid-turn interrupts its known turn, then stops its child once within its bounds", async () => {
	await withBackend("forever", async (fixture) => {
		const controller = new AbortController();
		const outcome = await fixture.call({ role: "implement" }, { signal: controller.signal, onTurn: () => controller.abort() });
		ended(outcome, "aborted");
		assert.equal(outcome.run.aborted, true);
		assert.deepEqual(sent(fixture, "turn/interrupt").map((message) => message.params), [{ threadId: "thr-1", turnId: "turn-1" }]);
		assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-1" });
	});
});

for (const when of ["sent", "answered"] as const) {
	test(`a run cancelled ${when === "sent" ? "while its readback is in flight" : "after its readback verified"} fails as aborted, stops its child once and publishes no checkpoint`, async () => {
		await withBackend("ok", async (fixture) => {
			const controller = new AbortController();
			const outcome = await fixture.call({ role: "implement", effort: "high" }, { signal: controller.signal, onRead: (at) => at === when && controller.abort() });
			ended(outcome, "aborted");
			assert.equal(failed(outcome.run), true, "a cancelled run is not a success, whatever it carries");
			assert.equal(outcome.run.aborted, true);
			assert.equal(outcome.run.errorMessage, RUN_ABORTED);
			assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-1" });
			assert.equal(sent(fixture, "turn/start").length, 1);
			assert.equal(sent(fixture, "thread/read").length, 1, "the readback is never retried");
			assert.equal(outcome.run.checkpoint, undefined);
			assert.equal(outcome.run.session?.checkpoint, undefined);
			// A selection the readback verified is kept as diagnostic data on the cancelled run, never as a success. Whether
			// an in-flight readback is answered before the transport closes is the child's race, so that case takes either.
			const verified = { model: "gpt-host-default", provider: "openai", effort: "high" };
			if (when === "answered") assert.deepEqual(outcome.run.selection, verified);
			else assert.ok(outcome.run.selection === undefined || JSON.stringify(outcome.run.selection) === JSON.stringify(verified));
		});
	});
}

/* ------------------------------------------------------------------------------------------------------------------
 * Continuation: resume and fork from a checkpoint and its usage baseline
 * ---------------------------------------------------------------------------------------------------------------- */

const usage = (input: number, cached: number, output: number, reasoning: number): CodexUsageBaseline => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output });
/** The fake's own seed: what a persisted thread's total already is when a fake process loads it. */
const SEED = usage(5_000, 2_000, 200, 50);
/** The one response a loaded thread's turn reports in the fake. */
const LAST = usage(400, 300, 20, 5);
const RECORDED: ResolvedSelection = { model: "gpt-5", provider: "openai" };
const resume = (at = "turn-seed-2", baseline: CodexUsageBaseline = SEED): SessionIntent => ({ kind: "resume", ref: { backend: "codex", sessionId: "thr-old", checkpoint: at, baseline } });
const fork = (at = "turn-seed-2", baseline: CodexUsageBaseline = SEED): SessionIntent => ({ kind: "fork", from: { backend: "codex", sessionId: "thr-old", checkpoint: at, baseline } });
const plus = (a: CodexUsageBaseline, b: CodexUsageBaseline): CodexUsageBaseline => ({ inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens, outputTokens: a.outputTokens + b.outputTokens, reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens, totalTokens: a.totalTokens + b.totalTokens });

test("a resume loads the recorded thread on its recorded selection, checks its tip, and settles on its own turn with the call's usage and a new baseline", async () => {
	await withBackend("resume-ok", async (fixture) => {
		// Every usage update is sent twice: the same total, re-sent, is not counted twice.
		const outcome = await fixture.call({ role: "implement" }, { intent: resume(), recorded: { ...RECORDED, effort: "high" }, env: { FAKE_CODEX_REEMIT: "1" } });
		ended(outcome, "stop");
		const { run } = outcome;
		assert.equal(run.text, "loaded answer");
		assert.deepEqual(methods(fixture), ["initialize", "initialized", "thread/resume", "thread/turns/list", "turn/start", "thread/read"]);
		assert.deepEqual(sent(fixture, "thread/resume")[0].params, { threadId: "thr-old", model: "gpt-5", modelProvider: "openai", sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: INSTRUCTIONS("implement"), excludeTurns: true });
		assert.deepEqual(sent(fixture, "thread/turns/list")[0].params, { threadId: "thr-old", limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
		assert.deepEqual(sent(fixture, "turn/start")[0].params, { threadId: "thr-old", input: [{ type: "text", text: "do the task" }], effort: "high" }, "the recorded effort goes on turn/start only");
		assert.deepEqual(run.session, { backend: "codex", sessionId: "thr-old", checkpoint: "turn-1", baseline: { ...plus(SEED, LAST), cacheWriteInputTokens: 0 } });
		assert.deepEqual(run.selection, { model: "gpt-5", provider: "openai", effort: "high" });
		// The call's own share: the thread's total less the baseline, not the total the history seeded.
		assert.deepEqual([run.tokensIn, run.tokensOut, run.cacheRead, run.cacheWrite], [400, 20, 300, 0]);
		// The context is the latest response's input, never the thread's total.
		assert.deepEqual([run.contextTokens, run.contextWindow], [400, 200_000]);
	});
});

const RESUME_REFUSALS: [string, string, SessionIntent, Record<string, string>, string | RegExp][] = [
	["a thread moved past its checkpoint", "resume-moved", resume(), {}, RESUME_MOVED],
	["a checkpoint turn that is not completed", "turns-interrupted", resume("turn-cold"), {}, RESUME_UNSETTLED],
	["a thread that ended cold after its checkpoint", "turns-interrupted", resume(), {}, RESUME_MOVED],
	["another provider than the recorded one", "resume-mismatch", resume(), {}, /^the codex child started its thread on provider azure, not the provider openai this call named, so no turn was started$/],
	["an answer naming another thread", "resume-ok", resume(), { FAKE_CODEX_BAD: "resume-id" }, /its thread\/resume answer names another thread/],
];

for (const [what, scenario, intent, env, message] of RESUME_REFUSALS) {
	test(`a resume of ${what} is refused before any turn and settles on nothing`, async () => {
		await withBackend(scenario, async (fixture) => {
			const outcome = await fixture.call({ role: "implement" }, { intent, recorded: RECORDED, env });
			ended(outcome, "thread");
			if (typeof message === "string") {
				assert.equal(outcome.run.errorMessage, message);
				// A thread no longer at its checkpoint is not continued another way: the refusal says what to do instead.
				assert.match(message, /; start a new run without continue that carries the earlier report as context \(a plan call takes fresh true\)$/);
			} else assert.match(outcome.run.errorMessage ?? "", message);
			assert.equal(sent(fixture, "turn/start").length, 0, "no turn was started");
			assert.equal(outcome.run.session?.checkpoint, undefined);
			assert.deepEqual([outcome.run.tokensIn, outcome.run.tokensOut], [0, 0]);
		});
	});
}

test("a fork checks its new thread and starting tip, measures from the source's baseline, and settles on its own turn", async () => {
	await withBackend("fork-ok", async (fixture) => {
		// The fork's copied turns are named anew, as nothing says a native fork keeps the source's turn ids.
		const outcome = await fixture.call({ role: "ask" }, { intent: fork(), recorded: RECORDED, env: { FAKE_CODEX_FORK_RENAME: "1" } });
		ended(outcome, "stop");
		assert.deepEqual(methods(fixture), ["initialize", "initialized", "thread/fork", "thread/turns/list", "turn/start", "thread/read"]);
		assert.deepEqual(sent(fixture, "thread/fork")[0].params, { threadId: "thr-old", lastTurnId: "turn-seed-2", model: "gpt-5", modelProvider: "openai", sandbox: "read-only", approvalPolicy: "never", developerInstructions: INSTRUCTIONS("ask"), excludeTurns: true });
		assert.deepEqual(sent(fixture, "thread/turns/list")[0].params.threadId, "thr-fork-1", "the tip read is the new thread's, never the source's");
		assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-fork-1", checkpoint: "turn-1", baseline: { ...plus(SEED, LAST), cacheWriteInputTokens: 0 } });
		assert.deepEqual([outcome.run.tokensIn, outcome.run.tokensOut, outcome.run.cacheRead], [400, 20, 300]);
	});
});

test("a fork that fails after its starting tip keeps the new thread at that tip, not the source's checkpoint, and no baseline", async () => {
	await withBackend("fork-ok", async (fixture) => {
		const outcome = await fixture.call({ role: "ask" }, { intent: fork(), recorded: RECORDED, env: { FAKE_CODEX_FORK_RENAME: "1", FAKE_CODEX_READ: JSON.stringify({ modelProvider: "azure" }) } });
		ended(outcome, "verify");
		assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-fork-1", checkpoint: "fork-turn-seed-2" });
	});
});

const FORK_REFUSALS: [string, string, SessionIntent, string, Record<string, unknown> | undefined][] = [
	["an answer naming the source thread", "fork-same-id", fork(), FORK_SAME_THREAD, undefined],
	["a new thread with no turns", "fork-tip-missing", fork(), FORK_NO_TIP, { backend: "codex", sessionId: "thr-fork-1" }],
	["a new thread whose tip is not completed", "turns-interrupted", fork("turn-cold"), FORK_TIP_UNSETTLED, { backend: "codex", sessionId: "thr-fork-1" }],
];

for (const [what, scenario, intent, message, session] of FORK_REFUSALS) {
	test(`a fork with ${what} is refused before any turn, naming at most the verified new thread alone`, async () => {
		await withBackend(scenario, async (fixture) => {
			const outcome = await fixture.call({ role: "implement" }, { intent, recorded: RECORDED });
			ended(outcome, "thread");
			assert.equal(outcome.run.errorMessage, message);
			assert.equal(sent(fixture, "turn/start").length, 0);
			assert.deepEqual(outcome.run.session, session);
		});
	});
}

/* ------------------------------------------------------------------------------------------------------------------
 * Usage against a baseline
 * ---------------------------------------------------------------------------------------------------------------- */

test("a thread total below the baseline in any core count fails the run after its turn, with no usage, checkpoint or baseline", async () => {
	await withBackend("resume-ok", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" }, { intent: resume("turn-seed-2", { ...SEED, outputTokens: 999_999 }), recorded: RECORDED });
		ended(outcome, "verify");
		assert.equal(outcome.run.errorMessage, USAGE_BASELINE_INCONSISTENT);
		assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-old" });
		assert.deepEqual([outcome.run.tokensIn, outcome.run.tokensOut, outcome.run.cacheRead], [0, 0, 0], "neither the display nor the outcome showed a count it could not attribute");
		assert.equal(sent(fixture, "turn/start").length, 1);
	});
});

test("a recorded cache write the total fell below is unobserved, shown as 0, and fails nothing", async () => {
	await withBackend("resume-ok", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" }, { intent: resume("turn-seed-2", { ...SEED, cacheWriteInputTokens: 50 }), recorded: RECORDED });
		ended(outcome, "stop");
		assert.equal(outcome.run.cacheWrite, 0);
		assert.equal(outcome.run.session?.backend === "codex" && outcome.run.session.baseline?.cacheWriteInputTokens, 0, "the new baseline is the total as read");
	});
});

const total = (over: Partial<CodexUsageBaseline> = {}) => ({ ...plus(SEED, LAST), cacheWriteInputTokens: 0, ...over });
const CALL_USAGE: [string, ReturnType<typeof total>, CodexUsageBaseline | undefined, ReturnType<typeof callUsage>][] = [
	["a fresh thread: the raw total, cache write included", total({ cacheWriteInputTokens: 7 }), undefined, { ...total(), cacheWriteInputTokens: 7 }],
	["a baseline with no cache write: none observed", total({ cacheWriteInputTokens: 7 }), SEED, { ...LAST }],
	["a baseline cache write within the total: the difference", total({ cacheWriteInputTokens: 7 }), { ...SEED, cacheWriteInputTokens: 3 }, { ...LAST, cacheWriteInputTokens: 4 }],
	["a baseline cache write above the total: none observed", total({ cacheWriteInputTokens: 2 }), { ...SEED, cacheWriteInputTokens: 3 }, { ...LAST }],
	["the same total as the baseline: all zero", total(), plus(SEED, LAST), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }],
	["an input below the baseline", total(), { ...SEED, inputTokens: 9_999 }, undefined],
	["a reasoning count below the baseline", total(), { ...SEED, reasoningOutputTokens: 999 }, undefined],
	["a total count below the baseline", total(), { ...SEED, totalTokens: 99_999 }, undefined],
];

for (const [what, current, baseline, expected] of CALL_USAGE) {
	test(`a call's usage, ${what}`, () => assert.deepEqual(callUsage(current, baseline), expected));
}

/** One thread/tokenUsage/updated as the transport hands it to the feed. */
const update = (turnId: string, tokenTotal: Record<string, number>, last: Record<string, number>, window: number | null) => ({ method: "thread/tokenUsage/updated", params: { threadId: "thr-1", turnId, tokenUsage: { total: tokenTotal, last, modelContextWindow: window } } });

test("the live display shows the call's share of each update, the same counts for a re-sent total, and clears its context when a half is zero or absent", () => {
	const run = newCodexRun(codexRole({ role: "implement" }, undefined, {}));
	let progress = 0;
	const feed = codexFeed(run, { progress: () => (progress += 1), event: () => {} }, SEED);
	feed.thread("thr-1");
	feed.turn("turn-1");
	const show = () => [run.tokensIn, run.tokensOut, run.cacheRead, run.cacheWrite, run.contextTokens, run.contextWindow];
	feed.onNotification(update("turn-1", plus(SEED, LAST) as never, LAST as never, 200_000));
	assert.deepEqual(show(), [400, 20, 300, 0, 400, 200_000]);
	feed.onNotification(update("turn-1", plus(SEED, LAST) as never, LAST as never, 200_000));
	assert.deepEqual(show(), [400, 20, 300, 0, 400, 200_000], "a re-sent total is not added again");
	feed.onNotification(update("turn-1", plus(SEED, LAST) as never, LAST as never, 0));
	assert.deepEqual(show(), [400, 20, 300, 0, undefined, undefined], "a zero window clears the share rather than keeping the older one");
	feed.onNotification(update("turn-1", plus(SEED, LAST) as never, LAST as never, 200_000));
	feed.onNotification(update("turn-1", plus(SEED, LAST) as never, { ...LAST, inputTokens: 0, cachedInputTokens: 0 } as never, 200_000));
	assert.deepEqual(show().slice(4), [undefined, undefined], "and so does a zero context");
	const before = progress;
	feed.onNotification(update("turn-1", { ...SEED, outputTokens: SEED.outputTokens - 1, totalTokens: SEED.totalTokens - 1 } as never, SEED as never, 200_000));
	feed.onNotification(update("turn-1", { ...plus(SEED, LAST), inputTokens: 1 } as never, LAST as never, 200_000));
	assert.equal(progress, before, "a total below the baseline is neither shown nor said");
	assert.deepEqual(show().slice(0, 4), [400, 20, 300, 0]);
	feed.end();
});

test("the final usage clears a context the display showed when the final one has no window, and publishes no cost", () => {
	const run = newCodexRun(codexRole({ role: "implement" }, undefined, {}));
	Object.assign(run, { contextTokens: 900, contextWindow: 200_000, costUsd: 1 });
	const evidence = { threadId: "thr-1", turnId: "turn-1", started: true, usage: { total: { ...plus(SEED, LAST), cacheWriteInputTokens: 0 }, last: { ...LAST, cacheWriteInputTokens: 0 }, modelContextWindow: null }, usageUpdates: 1, usageAfterCompletion: 0, retryableErrors: 0, terminalErrors: 0, reroutes: [], rerouteCount: 0, denials: [], denialCount: 0, items: { started: 0, completed: 0 }, notifications: 1 };
	finishCodexRun(run, { kind: "ended", verdict: { ok: false, stage: "turn", message: "x", aborted: false }, thread: "thr-1", baseline: SEED, evidence, unverified: false }, 1);
	assert.deepEqual([run.tokensIn, run.contextTokens, run.contextWindow, run.costUsd], [400, undefined, undefined, undefined]);
});

/* ------------------------------------------------------------------------------------------------------------------
 * Steers
 * ---------------------------------------------------------------------------------------------------------------- */

const STEER_CASES: [string, string[], string, number][] = [
	["accepted once", ["accept"], "Note: of the 1 message sent to this codex run while it ran, 1 taken into its turn's input, which does not show the model read it. None was sent twice.", 1],
	["refused, and the next accepted", ["reject", "accept"], "Note: of the 2 messages sent to this codex run while it ran, 1 taken into its turn's input, which does not show the model read it; 1 refused by the codex child. None was sent twice.", 2],
	["unanswered inside its bound, and the next accepted", ["silent", "accept"], "Note: of the 2 messages sent to this codex run while it ran, 1 taken into its turn's input, which does not show the model read it; 1 sent with no answer, so whether the child took it is unknown. None was sent twice.", 2],
];

for (const [what, script, note, steers] of STEER_CASES) {
	test(`a steer pushed before the turn is admitted waits, then goes to that turn once: ${what}`, async () => {
		await withBackend("steer-script", async (fixture) => {
			const texts = script.map((_, at) => `steer ${at + 1}`);
			const outcome = await fixture.call({ role: "implement" }, { steers: texts, env: { FAKE_CODEX_STEERS: script.join(",") }, deps: { bounds: { ...TEST_BOUNDS, requestMs: 1_000 } } });
			ended(outcome, "stop");
			assert.equal(outcome.run.text.split("\n\n")[0], "steered answer");
			assert.equal(outcome.run.text.split("\n\n").at(-1), note);
			const steered = sent(fixture, "turn/steer").map((message) => message.params);
			assert.equal(steered.length, steers, "each steer was sent once and none was retried");
			assert.deepEqual(steered, texts.map((text) => ({ threadId: "thr-1", expectedTurnId: "turn-1", input: [{ type: "text", text }] })));
			const order = methods(fixture);
			assert.ok(order.indexOf("turn/steer") > order.indexOf("turn/start"), "nothing is steered before the turn is named");
		});
	});
}

test("steers still queued when the run stops taking input are dropped, noted once, and never sent", async () => {
	await withBackend("ok", async (fixture) => {
		const outcome = await fixture.call({ role: "implement" }, { steers: ["one", "two"], expectedCodexHome: path.join(fixture.root, "other-home") });
		ended(outcome, "startup");
		assert.equal(outcome.run.text, "Note: of the 2 messages sent to this codex run while it ran, 2 still queued when the run stopped taking input, and never sent. None was sent twice.");
		assert.equal(sent(fixture, "turn/steer").length, 0);
		assert.equal(outcome.input.push("three"), false, "a closed input takes nothing more");
	});
	await withBackend("ok", async (fixture) => {
		const controller = new AbortController();
		controller.abort();
		const outcome = await fixture.call({ role: "implement" }, { steers: ["one"], signal: controller.signal });
		assert.equal(outcome.run.errorMessage, RUN_CANCELLED);
		assert.match(outcome.run.text, /1 still queued when the run stopped taking input, and never sent/);
		assert.equal(outcome.input.open, false);
	});
});

/* ------------------------------------------------------------------------------------------------------------------
 * Composition boundaries
 * ---------------------------------------------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------------------------------------------------
 * Questions: the run's own callback, on a fresh thread and on one Codex restored the tool on
 * ---------------------------------------------------------------------------------------------------------------- */

const toolResult = (id: number, success: boolean, text: string) => ({ id, result: { success, contentItems: [{ type: "inputText", text }] } });
const replies = (fixture: Fixture) => requests(fixture).filter((message) => message.method === undefined);

test("a fresh run with a callback opts in, registers the one tool, runs its contract alone, and settles on its turn once the answer came", async () => {
	await withBackend("question", async (fixture) => {
		const asked: { question: string; signal: AbortSignal }[] = [];
		const outcome = await fixture.call(
			{ role: "implement" },
			{
				onQuestion: async (question, signal) => {
					asked.push({ question, signal });
					return "call it fooHelper";
				},
			},
		);
		ended(outcome, "stop");
		assert.match(outcome.run.text, /^answer received: call it fooHelper\n\nNote: the codex child reported no effort/, "the answer the child got, then the usual note on a host-default effort");
		assert.deepEqual(asked.map((entry) => entry.question), ["Which name should the helper take?"]);
		assert.equal(asked[0]!.signal.aborted, false);
		assert.deepEqual(sent(fixture, "initialize")[0].params.capabilities, { experimentalApi: true });
		assert.deepEqual(sent(fixture, "thread/start")[0].params, { sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: INSTRUCTIONS("implement"), dynamicTools: [{ ...CODEX_QUESTION_TOOL_SPEC }] });
		assert.deepEqual(replies(fixture), [toolResult(21, true, "call it fooHelper")]);
		assert.deepEqual(methods(fixture), ["initialize", "initialized", "thread/start", "turn/start", "reply", "thread/read"], "the answer is a reply on the wire, then the turn's own end and the readback");
		assert.deepEqual([outcome.run.tokensIn, outcome.run.tokensOut], [700, 40]);
	});
});

for (const kind of ["new", "resume", "fork"] as const) {
	test(`a ${kind} call without a callable question bridge refuses before any contract, lookup, version read or start`, async () => {
		let touched = 0;
		const touch = () => { touched += 1; throw new Error("reached"); };
		const reports: CodexCallReport[] = [];
		const backend = createCodexBackend({ readContract: touch, launch: touch, start: touch, clientInfo: touch, onCall: (report) => reports.push(report) });
		const intent: SessionIntent = kind === "new" ? { kind } : kind === "resume" ? resume() : fork();
		for (const callback of [undefined, null, false, "not a callback", {}]) {
			const input = backend.control();
			assert.equal(input.push("queued"), true);
			await assert.rejects(backend.run({ role: codexRole({ role: "implement" }, undefined, {}), prompt: "x", cwd: repoRoot, session: backend.session(intent), input, signal: undefined, onQuestion: callback as never, onProgress: () => {} }), { message: CODEX_QUESTION_REQUIRED });
			assert.equal(input.open, false, "a refused call closes its input without launching a child");
			assert.equal(input.push("late"), false);
			assert.deepEqual(reports.at(-1), { stage: "admission", launchCalled: false, startCalled: false, startResolved: false, shutdowns: 0 });
		}
		assert.equal(touched, 0);
	});
}

test("an already cancelled callback-less call remains cancellation and touches no startup dependency", async () => {
	let touched = 0;
	const touch = () => { touched += 1; throw new Error("reached"); };
	const backend = createCodexBackend({ readContract: touch, launch: touch, start: touch, clientInfo: touch });
	const controller = new AbortController();
	controller.abort();
	const input = backend.control();
	const run = await backend.run({ role: codexRole({ role: "implement" }, undefined, {}), prompt: "x", cwd: repoRoot, signal: controller.signal, input, onProgress: () => {} });
	assert.equal(run.aborted, true);
	assert.equal(run.errorMessage, RUN_CANCELLED);
	assert.equal(run.session, undefined);
	assert.equal(input.open, false);
	assert.equal(touched, 0);
});

test("a fork registers nothing on its thread, runs only its shared contract, and has the restored tool's question answered", async () => {
	await withBackend("question-inherited", async (fixture) => {
		const outcome = await fixture.call({ role: "ask" }, { intent: fork(), recorded: RECORDED, onQuestion: async () => "forked answer" });
		ended(outcome, "stop");
		assert.equal(outcome.run.text, "answer received: forked answer");
		assert.deepEqual(sent(fixture, "initialize")[0].params.capabilities, { experimentalApi: true });
		assert.deepEqual(sent(fixture, "thread/fork")[0].params, { threadId: "thr-old", lastTurnId: "turn-seed-2", model: "gpt-5", modelProvider: "openai", sandbox: "read-only", approvalPolicy: "never", developerInstructions: INSTRUCTIONS("ask"), excludeTurns: true });
		assert.deepEqual(replies(fixture), [toolResult(21, true, "forked answer")]);
		assert.deepEqual([outcome.run.tokensIn, outcome.run.tokensOut, outcome.run.cacheRead], [400, 20, 300]);
	});
});

test("a resume reads only its shared contract, registers nothing, and answers through the restored tool with baseline accounting unchanged", async () => {
	await withBackend("question-inherited", async (fixture) => {
		const reads: string[] = [];
		const outcome = await fixture.call({ role: "implement" }, { intent: resume(), recorded: RECORDED, onQuestion: async () => "resumed answer", deps: { readContract: (name) => { reads.push(name); return readContract(name); } } });
		ended(outcome, "stop");
		assert.deepEqual(reads, ["implement.md"]);
		assert.equal(outcome.run.text, "answer received: resumed answer");
		assert.deepEqual(sent(fixture, "initialize")[0].params.capabilities, { experimentalApi: true });
		assert.deepEqual(sent(fixture, "thread/resume")[0].params, { threadId: "thr-old", model: "gpt-5", modelProvider: "openai", sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: INSTRUCTIONS("implement"), excludeTurns: true });
		assert.deepEqual(replies(fixture), [toolResult(21, true, "resumed answer")]);
		assert.deepEqual(outcome.run.session, { backend: "codex", sessionId: "thr-old", checkpoint: "turn-1", baseline: { ...plus(SEED, LAST), cacheWriteInputTokens: 0 } });
		assert.deepEqual([outcome.run.tokensIn, outcome.run.tokensOut, outcome.run.cacheRead], [400, 20, 300]);
	});
});

test("a run cancelled while its question waits aborts the question's signal, answers it once, and stops its child once", async () => {
	await withBackend("question-cancel", async (fixture) => {
		const controller = new AbortController();
		let signal: AbortSignal | undefined;
		const outcome = await fixture.call(
			{ role: "implement" },
			{
				signal: controller.signal,
				onQuestion: (_question, own) =>
					new Promise<string>((_resolve, reject) => {
						signal = own;
						own.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
						controller.abort();
					}),
			},
		);
		ended(outcome, "aborted");
		assert.equal(outcome.run.errorMessage, RUN_ABORTED);
		assert.equal(signal?.aborted, true);
		assert.deepEqual(replies(fixture), [toolResult(21, false, CODEX_QUESTION_UNANSWERED)]);
		assert.equal(sent(fixture, "turn/interrupt").length, 1);
	});
});

test("a continuation of another backend's session, or of a thread with no checkpoint and baseline, is refused before any contract, lookup or start", async () => {
	let touched = 0;
	const touch = () => {
		touched += 1;
		throw new Error("reached");
	};
	const backend = createCodexBackend({ readContract: touch, launch: touch, start: touch, clientInfo: touch });
	const bare = { backend: "codex" as const, sessionId: "thr-1", checkpoint: "cp" };
	assert.throws(() => backend.session({ kind: "resume", ref: bare }), { message: CODEX_NO_CHECKPOINT });
	assert.throws(() => backend.session({ kind: "fork", from: { backend: "codex", sessionId: "thr-1" } }), { message: CODEX_NO_CHECKPOINT });
	assert.throws(() => backend.session({ kind: "resume", ref: { backend: "claude", sessionId: "thr-1", checkpoint: "cp" } }), { message: CODEX_FOREIGN_SESSION });
	assert.throws(() => backend.session({ kind: "fork", from: { backend: "pi", sessionId: "thr-1", sessionFile: "/x.jsonl", checkpoint: "cp" } }), { message: CODEX_FOREIGN_SESSION });
	// A session the mapping did not make — here one with no baseline — is refused by the run before anything is touched.
	await assert.rejects(
		backend.run({ role: codexRole({ role: "implement" }, undefined, {}), prompt: "x", cwd: repoRoot, session: { kind: "resume", id: "thr-1", at: "cp" } as never, signal: undefined, onProgress: () => {} }),
		{ message: CODEX_SESSION_INVALID },
	);
	assert.equal(touched, 0);
	const control = backend.control();
	assert.equal(control.open, true, "the input is open from admission");
	assert.equal(control.push(""), false, "an empty steer is not taken");
	control.end();
	assert.equal(control.open, false);
	assert.equal(control.push("late"), false, "a closed input takes nothing");
	assert.equal(backend.name, "codex");
	// The host's erased view takes it as it is: the role and session shapes fit the shared boundary.
	assert.equal(hostBackend(backend).name, "codex");
});

test("an unreadable contract is refused before any lookup, and a launch failure is the launch's own sentence, before any start", async () => {
	let starts = 0;
	const start = async (): Promise<CodexChild> => {
		starts += 1;
		throw new Error("reached");
	};
	const unreadable = createCodexBackend({ readContract: () => { throw new Error("gone"); }, start });
	const request = { role: codexRole({ role: "implement" }, undefined, {}), prompt: "x", cwd: repoRoot, signal: undefined, onQuestion: unexpectedQuestion, onProgress: () => {} };
	await assert.rejects(unreadable.run(request), (error: Error) => error.message === CONTRACT_UNREADABLE && (error.cause as Error).message === "gone");
	// The real launch, reached lazily, over an environment whose PATH names one empty directory: no codex is found there.
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-codex-empty-"));
	try {
		const unlaunched = createCodexBackend({ readContract, env: { PATH: empty, CODEX_HOME: path.join(empty, "home") }, start });
		await assert.rejects(unlaunched.run(request), /no executable codex on PATH/);
	} finally {
		fs.rmSync(empty, { recursive: true, force: true });
	}
	assert.equal(starts, 0);
});

test("the client version is this package's own, with a fixed fallback rather than a failure", () => {
	assert.deepEqual(codexClientInfo(), { name: "pi-fusion", version: PACKAGE_VERSION, title: "Pi-Fusion" });
	assert.equal(codexClientInfo(path.join(os.tmpdir(), "pi-fusion-no-such-manifest.json")).version, CODEX_CLIENT_VERSION_UNKNOWN);
});

test("constructing a backend reads, locates and starts nothing, and the real contracts it names are all there", () => {
	createCodexBackend();
	for (const name of CODEX_CONTRACT_FILES) assert.ok(fs.statSync(path.join(repoRoot, "contracts", name)).isFile(), name);
});

const importsOf = (file: string): string[] => ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles.map((reference) => reference.fileName);

test("this suite launches only the fake by its own path: it takes the app-server's arguments and types alone from the launch module", () => {
	const file = fileURLToPath(import.meta.url);
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
	const taken = source.statements
		.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith("/codex-launch.ts"))
		.flatMap((statement) => {
			const bindings = statement.importClause?.namedBindings;
			return bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text) : ["<not named>"];
		});
	assert.deepEqual(taken, ["CODEX_APP_SERVER_ARGS"]);
	assert.ok(importsOf(file).every((name) => !name.includes("@openai")));
});
