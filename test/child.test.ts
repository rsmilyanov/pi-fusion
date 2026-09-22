import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type ChildEvent, type ChildRun, type Role, childOptions, claudeExecutable, failed, failureMessage, questionAnswers, questionText, runChild } from "../extensions/fusion.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaude = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.PI_FUSION_CLAUDE_BIN = fakeClaude;

const ultracodeRole: Role = {
	name: "ultracode",
	model: "fable",
	effort: "ultracode",
	permissionMode: "bypassPermissions",
	contract: "ultracode.md",
};
const implementRole: Role = {
	name: "implement",
	model: "opus",
	effort: "high",
	tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
	permissionMode: "bypassPermissions",
	contract: "implement.md",
};

function run(
	scenario: string,
	opts: {
		role?: Role;
		signal?: AbortSignal;
		killGraceMs?: number;
		onProgress?: (run: ChildRun) => void;
		onEvent?: (event: ChildEvent) => void;
	} = {},
): Promise<ChildRun> {
	process.env.FAKE_CLAUDE_SCENARIO = scenario;
	return runChild({
		role: opts.role ?? ultracodeRole,
		prompt: "do the thing",
		cwd: repoRoot,
		signal: opts.signal,
		onProgress: opts.onProgress ?? (() => {}),
		onEvent: opts.onEvent,
		killGraceMs: opts.killGraceMs,
	});
}

const distinct = (seen: string[]) => seen.filter((item, index) => item !== seen[index - 1]);

/** The throttle may render a partial delta before the trailing call, so check order, not the exact sequence. */
function assertInOrder(seen: string[], expected: string[]) {
	let from = 0;
	for (const item of expected) {
		const index = seen.indexOf(item, from);
		assert.ok(index !== -1, `expected ${JSON.stringify(item)} after position ${from} in ${JSON.stringify(seen)}`);
		from = index + 1;
	}
	assert.equal(seen[seen.length - 1], expected[expected.length - 1]);
}

test("the last result wins and usage is summed over turns", async () => {
	const seen: string[] = [];
	const child = await run("ok", { onProgress: (run) => seen.push(run.activity ?? "") });
	assert.equal(failed(child), false);
	assert.equal(child.text, "## Changed\nfoo.ts");
	assert.equal(child.toolCalls, 2);
	assert.equal(child.tokensIn, 26);
	assert.equal(child.tokensOut, 8);
	assert.equal(child.workflowTokens, 250);
	assert.equal(child.sessionId, "sess-1");
	assert.equal(child.checkpoint, "asst-3");
	assert.equal(child.abandonedTasks, undefined);
	assert.equal(child.stopReason, "stop");
	assert.equal(child.exitCode, 0);
	assert.equal(child.signal, null);
	assert.deepEqual(child.deniedTools, undefined);
	assert.deepEqual(distinct(seen), [
		"waiting for model",
		"Workflow",
		"Workflow probe",
		"workflow Probe · 1/3 agents done",
		"Bash npm test",
	]);
});

test("a workflow run reports its tasks as events", async () => {
	const events: ChildEvent[] = [];
	const child = await run("ok", { onEvent: (event) => events.push(event) });
	assert.equal(failed(child), false);
	assert.deepEqual(events, [
		{ type: "init", sessionId: "sess-1" },
		{ type: "tool_call", name: "Workflow", brief: "", id: "tu-1", input: { script: "export const meta = {}" } },
		{ type: "task_started", taskId: "wf-1", taskType: "local_workflow", name: "probe" },
		{
			type: "task_progress",
			taskId: "wf-1",
			description: "Probe: a",
			tokens: 100,
			phase: "Probe",
			agents: [
				{ label: "a", state: "done" },
				{ label: "b", state: "start" },
			],
		},
		{ type: "turn_result", ok: true },
		{ type: "task_ended", taskId: "wf-1", status: "completed", tokens: 250 },
		{ type: "tool_call", name: "Bash", brief: "npm test", id: "tu-2", input: { command: "npm test" } },
		{ type: "turn_result", ok: true },
	]);
});

test("a run adds up its cache, turns and API time and keeps the latest cost, models, context and thinking", async () => {
	const child = await run("ok");
	assert.equal(child.tokensIn, 10 + 2 + 1 + 4 + 7 + 2);
	assert.equal(child.cacheRead, 2 + 7);
	assert.equal(child.cacheWrite, 1 + 2);
	assert.equal(child.costUsd, 0.25);
	assert.equal(child.numTurns, 2);
	assert.equal(child.apiMs, 1500);
	assert.equal(child.modelId, "claude-fable-5-1");
	assert.equal(child.contextTokens, 1206);
	assert.equal(child.contextWindow, 1_000_000, "the window Claude Code reports for the main model wins over the default");
	assert.deepEqual(child.thinking, ["Run the tests next."]);
	assert.deepEqual(child.models, [
		{ model: "claude-fable-5-1", inputTokens: 14, outputTokens: 8, cacheRead: 9, cacheWrite: 3, costUsd: 0.2, contextWindow: 1_000_000 },
		{ model: "claude-opus-5", inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.05, contextWindow: 1_000_000 },
	]);
});

test("before a result reports it, the context window comes from the model id", async () => {
	const child = await run("read");
	assert.equal(child.modelId, "claude-fable-5-1");
	assert.equal(child.contextWindow, 200_000);
	assert.equal(child.costUsd, undefined);
});

test("an agent's tool calls are reported as events and stay out of the root run", async () => {
	const events: ChildEvent[] = [];
	const child = await run("agent", { onEvent: (event) => events.push(event) });
	assert.deepEqual(events, [
		{ type: "init", sessionId: "sess-1" },
		{ type: "tool_call", name: "Agent", brief: "probe files", id: "tu-1", input: { description: "probe files", prompt: "look" } },
		{ type: "task_started", taskId: "ag-1", toolUseId: "tu-1", taskType: "local_agent", name: "probe files" },
		{ type: "agent_tool_call", parentToolUseId: "tu-1", name: "Read", id: "tu-sub-1", input: { file_path: "a.ts" } },
		{ type: "tool_result", toolUseId: "tu-sub-1", text: "no such file", isError: true },
		{ type: "task_progress", taskId: "ag-1", description: "probe files", lastTool: "Read", tokens: 50, toolUses: 1 },
		{ type: "task_ended", taskId: "ag-1", status: "completed", summary: "found it", tokens: 80 },
		{ type: "tool_result", toolUseId: "tu-1", text: "found it", isError: false },
		{ type: "turn_result", ok: true },
	]);
	assert.equal(failed(child), false);
	assert.equal(child.toolCalls, 1);
	assert.equal(child.checkpoint, "asst-1");
	assert.equal(child.text, "done");
});

test("a failed turn reports its error message as an event", async () => {
	const events: ChildEvent[] = [];
	const child = await run("error", { onEvent: (event) => events.push(event) });
	assert.equal(failed(child), true);
	assert.deepEqual(events, [
		{ type: "init", sessionId: "sess-1" },
		{ type: "turn_result", ok: false, message: "boom" },
	]);
});

test("an event listener that throws does not change the run", async () => {
	const child = await run("read", {
		onEvent: () => {
			throw new Error("listener blew up");
		},
	});
	assert.equal(failed(child), false);
	assert.equal(child.text, "done");
	assert.equal(child.toolCalls, 1);
});

test("a child that exits with a background task still running fails instead of returning the turn's text", async () => {
	const child = await run("wind-down");
	assert.equal(failed(child), true);
	assert.equal(child.exitCode, 0);
	assert.equal(child.stopReason, "stop");
	assert.deepEqual(child.abandonedTasks, ["workflow probe"]);
	assert.equal(child.text, "Workflow running; waiting for the completion notification.");
	const message = failureMessage(child);
	assert.match(message, /^ultracode exited with workflow probe still running: /);
	assert.match(message, /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0/);
});

test("an ambient task, such as a watcher, never counts as abandoned", async () => {
	const child = await run("ambient-task");
	assert.equal(failed(child), false);
	assert.equal(child.abandonedTasks, undefined);
	assert.equal(child.text, "done");
});

test("background_tasks_changed replaces the pending set and skips ambient tasks", async () => {
	const cleared = await run("tasks-cleared");
	assert.equal(failed(cleared), false);
	assert.equal(cleared.abandonedTasks, undefined);

	const late = await run("tasks-changed");
	assert.equal(failed(late), true);
	assert.deepEqual(late.abandonedTasks, ["workflow late probe"]);
	assert.match(failureMessage(late), /^ultracode exited with workflow late probe still running/);
});

test("partial messages show thinking, text and tool calls as activity", async () => {
	const seen: string[] = [];
	const child = await run("stream", { onProgress: (run) => seen.push(run.activity ?? "") });
	assert.equal(failed(child), false);
	assert.equal(child.toolCalls, 1);
	assertInOrder(distinct(seen), [
		"waiting for model",
		"thinking · Planning the change",
		"writing · Running tests",
		"calling Bash",
		"Bash npm test",
		"waiting for model",
	]);
	assert.ok(!seen.some((activity) => activity.includes("Subagent noise")), JSON.stringify(seen));
});

test("a burst of deltas is rendered a few times, not once per delta", async () => {
	const seen: string[] = [];
	const child = await run("burst", { onProgress: (run) => seen.push(run.activity ?? "") });
	assert.equal(failed(child), false);
	const writing = seen.filter((activity) => activity.startsWith("writing · "));
	assert.ok(writing.length >= 1 && writing.length <= 3, `expected 1 to 3 writing updates, got ${writing.length}`);
	assert.match(writing[writing.length - 1]!, /^writing · …\S.* word199$/);
});

test("a repeated tool_use block is counted once", async () => {
	const child = await run("dup-tool-use");
	assert.equal(failed(child), false);
	assert.equal(child.toolCalls, 1);
});

test("an error result fails with the error text", async () => {
	const child = await run("error");
	assert.equal(failed(child), true);
	const message = failureMessage(child);
	assert.match(message, /model error/);
	assert.match(message, /boom/);
});

test("an empty error result reports its subtype", async () => {
	const child = await run("max-turns");
	assert.equal(failed(child), true);
	assert.match(failureMessage(child), /error_max_turns/);
});

test("an API error on a success result fails with its text", async () => {
	const child = await run("api-error");
	assert.equal(failed(child), true);
	assert.match(failureMessage(child), /model error: rate limited/);
});


test("permission denials are recorded without failing the run", async () => {
	const child = await run("denied");
	assert.equal(failed(child), false);
	assert.deepEqual(child.deniedTools, ["Workflow"]);
});

test("silent child fails with no response", async () => {
	const child = await run("silent");
	assert.equal(failed(child), true);
	assert.match(failureMessage(child), /no response/);
});

test("non-zero exit reports code and the stderr lines that are not warnings", async () => {
	const child = await run("exit1");
	assert.equal(failed(child), true);
	const message = failureMessage(child);
	assert.match(message, /exited 1/);
	assert.match(message, /Not logged in/);
	assert.ok(!message.includes("something minor"), message);
});

test("a child that exits before the handshake completes still reports its stderr", async () => {
	const child = await run("no-init-exit1");
	assert.equal(failed(child), true);
	assert.equal(child.sessionId, undefined);
	assert.match(failureMessage(child), /exited 1: Not logged in/);
});

test("child killed by signal reports the signal", async () => {
	const child = await run("selfkill");
	assert.equal(failed(child), true);
	assert.match(failureMessage(child), /SIGKILL/);
});

test("a missing executable reports the spawn failure", async () => {
	const saved = process.env.PI_FUSION_CLAUDE_BIN;
	try {
		process.env.PI_FUSION_CLAUDE_BIN = "/nonexistent/claude";
		const child = await run("ok");
		assert.equal(failed(child), true);
		assert.equal(child.exitCode, null);
		const message = failureMessage(child);
		assert.match(message, /did not start/);
		assert.match(message, /nonexistent/);
	} finally {
		process.env.PI_FUSION_CLAUDE_BIN = saved;
	}
});

test("hanging child is aborted by signal", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 100);
	try {
		const child = await run("hang", { signal: controller.signal });
		assert.equal(failed(child), true);
		assert.equal(child.aborted, true);
		assert.equal(child.stopReason, "aborted");
		assert.match(failureMessage(child), /aborted/);
		assert.ok(child.ms < 5000, `expected the abort to kill the child within 5s, took ${child.ms}ms`);
	} finally {
		clearTimeout(timer);
	}
});

test("an abort after an intermediate result still fails and keeps the partial text", async () => {
	const controller = new AbortController();
	const child = await run("result-then-hang-exit0", {
		signal: controller.signal,
		onProgress: (run) => {
			if (run.text === "partial") controller.abort();
		},
	});
	assert.equal(failed(child), true);
	assert.equal(child.aborted, true);
	assert.equal(child.stopReason, "aborted");
	assert.equal(child.exitCode, 0);
	assert.equal(child.signal, null);
	assert.equal(child.text, "partial");
	assert.match(failureMessage(child), /aborted/);
});

test("child ignoring SIGTERM is escalated to SIGKILL", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 200);
	try {
		const child = await run("hang-ignore-term", { signal: controller.signal, killGraceMs: 200 });
		assert.equal(failed(child), true);
		assert.equal(child.signal, "SIGKILL");
		assert.ok(child.ms < 5000, `expected escalation within 5s, took ${child.ms}ms`);
	} finally {
		clearTimeout(timer);
	}
});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const waitFor = async (condition: () => boolean, ms: number): Promise<boolean> => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return condition();
};

test("aborting kills a detached grandchild that ignores SIGTERM", async () => {
	const pidFile = path.join(os.tmpdir(), `pi-fusion-grandchild-${process.pid}.pid`);
	fs.rmSync(pidFile, { force: true });
	process.env.FAKE_CLAUDE_GRANDCHILD_PID_FILE = pidFile;
	const controller = new AbortController();
	let grandchild = 0;
	try {
		const pending = run("hang-grandchild", { role: implementRole, signal: controller.signal, killGraceMs: 200 });
		assert.ok(await waitFor(() => fs.existsSync(pidFile), 5_000), "fake claude did not start its grandchild");
		grandchild = Number(fs.readFileSync(pidFile, "utf8"));
		assert.ok(grandchild > 0 && alive(grandchild));
		controller.abort();
		const child = await pending;
		assert.equal(child.aborted, true);
		assert.equal(failureMessage(child), "implement aborted while Read a.ts");
		assert.ok(await waitFor(() => !alive(grandchild), 3_000), `grandchild ${grandchild} survived the abort`);
	} finally {
		if (grandchild && alive(grandchild)) process.kill(grandchild, "SIGKILL");
		fs.rmSync(pidFile, { force: true });
		delete process.env.FAKE_CLAUDE_GRANDCHILD_PID_FILE;
	}
});

test("a large non-ascii report survives chunk boundaries", async () => {
	const child = await run("unicode");
	assert.equal(failed(child), false);
	assert.equal(child.text, `x${"é".repeat(100_000)}`);
	assert.ok(!child.text.includes("�"), "report contains replacement characters");
});

test("childOptions maps a role to SDK options", () => {
	const saved = process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE;
	try {
		delete process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE;
		const ultracode = childOptions(ultracodeRole, undefined, "t");
		assert.equal(ultracode.model, "fable");
		assert.equal(ultracode.effort, undefined);
		assert.deepEqual(ultracode.extraArgs, { effort: "ultracode" });
		assert.equal(ultracode.tools, undefined);
		assert.equal(ultracode.strictMcpConfig, undefined);
		assert.equal(ultracode.permissionMode, "bypassPermissions");
		assert.equal(ultracode.allowDangerouslySkipPermissions, true);
		assert.equal(ultracode.permissionPrompts, "none");
		assert.equal(ultracode.includePartialMessages, true);
		assert.equal(ultracode.settings, undefined);
		assert.equal(ultracode.sessionId, undefined);
		assert.equal(ultracode.resume, undefined);
		const systemPrompt = ultracode.systemPrompt as { type: string; preset: string; append: string };
		assert.equal(systemPrompt.type, "preset");
		assert.equal(systemPrompt.preset, "claude_code");
		assert.equal(systemPrompt.append, fs.readFileSync(path.join(repoRoot, "contracts", "ultracode.md"), "utf8"));

		process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE = "large";
		assert.deepEqual(childOptions(ultracodeRole, undefined, "t").settings, { workflowSizeGuideline: "large" });
		assert.equal(childOptions(implementRole, undefined, "t").settings, undefined);

		const tools = childOptions(implementRole, undefined, "t");
		assert.equal(tools.effort, "high");
		assert.equal(tools.extraArgs, undefined);
		assert.deepEqual(tools.tools, ["Read", "Bash", "Edit", "Write", "Grep", "Glob"]);
		assert.equal(tools.strictMcpConfig, true);

		const acceptEdits = childOptions({ ...ultracodeRole, permissionMode: "acceptEdits" }, undefined, "t");
		assert.equal(acceptEdits.allowDangerouslySkipPermissions, false);

		const fresh = childOptions(implementRole, { kind: "new", id: "id-1" }, "t");
		assert.equal(fresh.sessionId, "id-1");
		assert.equal(fresh.resume, undefined);
		assert.equal(fresh.forkSession, undefined);
		const resumed = childOptions(implementRole, { kind: "resume", id: "id-1" }, "t");
		assert.equal(resumed.sessionId, undefined);
		assert.equal(resumed.resume, "id-1");
		assert.equal(resumed.forkSession, undefined);
		assert.equal(resumed.resumeSessionAt, undefined);
		const forked = childOptions(implementRole, { kind: "fork", id: "id-2", from: "id-1" }, "t");
		assert.equal(forked.sessionId, "id-2");
		assert.equal(forked.resume, "id-1");
		assert.equal(forked.forkSession, true);
		assert.equal(forked.resumeSessionAt, undefined);
		assert.equal(childOptions(implementRole, { kind: "resume", id: "id-1", at: "c-1" }, "t").resumeSessionAt, "c-1");
		assert.equal(childOptions(implementRole, { kind: "fork", id: "id-2", from: "id-1", at: "c-1" }, "t").resumeSessionAt, "c-1");
	} finally {
		if (saved === undefined) delete process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE;
		else process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE = saved;
	}
});

test("claudeExecutable honours PI_FUSION_CLAUDE_BIN", () => {
	try {
		process.env.PI_FUSION_CLAUDE_BIN = "/x/fake.mjs";
		assert.deepEqual(claudeExecutable(), { pathToClaudeCodeExecutable: "/x/fake.mjs", executable: "node" });

		process.env.PI_FUSION_CLAUDE_BIN = "/usr/local/bin/claude";
		assert.deepEqual(claudeExecutable(), { pathToClaudeCodeExecutable: "/usr/local/bin/claude" });

		delete process.env.PI_FUSION_CLAUDE_BIN;
		assert.deepEqual(claudeExecutable(), {});
	} finally {
		process.env.PI_FUSION_CLAUDE_BIN = fakeClaude;
	}
});

test("AskUserQuestion's questions become one question, and the answer splits into one line per question only when the lines match", () => {
	const one = [{ question: "Which store?", options: [{ label: "sqlite", description: "one file" }, { label: "postgres" }] }];
	assert.equal(questionText(one), "Which store?\n- sqlite: one file\n- postgres");
	assert.deepEqual(questionAnswers(one, " sqlite \n"), { "Which store?": "sqlite" });
	const two = [{ question: "A?" }, { question: "B?", multiSelect: true }];
	assert.equal(questionText(two), "1. A?\n\n2. B?\n(one or more, separated by commas)\n\nAnswer each question on its own line, in order.");
	assert.deepEqual(questionAnswers(two, "1. yes\n2. x, y"), { "A?": "yes", "B?": "x, y" });
	assert.deepEqual(questionAnswers(two, "yes to both"), { "A?": "yes to both", "B?": "yes to both" });
});
