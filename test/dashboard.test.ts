import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import {
	type Dashboard,
	CALL_CAP_BYTES,
	FAILURE_CAP_BYTES,
	type LogEntry,
	PROMPT_CAP_BYTES,
	MAX_AGENTS_PER_TASK,
	MAX_DENIED_TOOLS,
	MAX_FILES,
	MAX_LOG_PER_RUN,
	MAX_MODELS,
	MAX_RUNS,
	MAX_THINKING_BLOCKS,
	MAX_STRING_CHARS,
	MAX_TASKS_PER_RUN,
	type RunDetail,
	type RunStatus,
	RunStore,
	type RunSummary,
	startDashboard,
	TEXT_CAP_BYTES,
	THINKING_CAP_BYTES,
} from "../extensions/dashboard.ts";

const START = 1_000;

function makeStore(): { store: RunStore; tick: (ms?: number) => number } {
	let clock = START;
	return { store: new RunStore(() => clock), tick: (ms = 1) => (clock += ms) };
}

function started(): { store: RunStore; tick: (ms?: number) => number } {
	const made = makeStore();
	made.store.start({ id: "run-1", role: "opus", model: "opus-4" });
	return made;
}

const bare = (entry: LogEntry | undefined) => {
	assert.ok(entry, "no log entry");
	const { seq: _seq, ...rest } = entry;
	return rest;
};

const detailOf = (store: RunStore, id = "run-1") => {
	const detail = store.detail(id);
	assert.ok(detail, `no detail for ${id}`);
	return detail;
};

test("a started run is running with its role, model and title and zero counters", () => {
	const { store } = makeStore();
	store.start({ id: "run-1", role: "fable-implement", model: "fable", title: "add the thing" });
	assert.deepEqual(store.summaries(), [
		{
			id: "run-1",
			role: "fable-implement",
			model: "fable",
			title: "add the thing",
			status: "running",
			startedAt: START,
			updatedAt: START,
			toolCalls: 0,
			agentToolCalls: 0,
			toolErrors: 0,
			tokensIn: 0,
			tokensOut: 0,
		},
	]);
});

test("a run started with a handle shows it in the summary and the detail", () => {
	const { store } = makeStore();
	store.start({ id: "id-1", handle: "run-3", role: "implement", model: "opus" });
	assert.equal(store.summaries()[0]!.handle, "run-3");
	assert.equal(detailOf(store, "id-1").handle, "run-3");
});

test("a question makes the run waiting and background with the question shown, and the answer makes it running again", () => {
	const { store } = started();
	store.question("run-1", "Which name?");
	assert.equal(store.summaries()[0]!.status, "waiting");
	assert.equal(store.summaries()[0]!.question, "Which name?");
	assert.equal(store.summaries()[0]!.background, true);
	assert.equal(detailOf(store).log.at(-1)!.text, "question: Which name?");
	store.question("run-1", undefined);
	assert.equal(store.summaries()[0]!.status, "running");
	assert.equal(store.summaries()[0]!.question, undefined);
	store.question("run-1", "Again?");
	store.finish("run-1", { status: "cancelled" });
	assert.equal(store.summaries()[0]!.question, undefined, "an ended run has no open question");
});

test("progress copies the snapshot and moves updatedAt and lastEventAt, reads do not", () => {
	const { store, tick } = started();
	tick(5);
	store.progress("run-1", {
		activity: "Bash npm test",
		toolCalls: 3,
		tokensIn: 17,
		tokensOut: 8,
		workflowTokens: 250,
		sessionId: "sess-1",
		deniedTools: ["Write", "Write", "Edit"],
	});
	const summary = store.summaries()[0]!;
	assert.equal(summary.activity, "Bash npm test");
	assert.equal(summary.toolCalls, 3);
	assert.equal(summary.tokensIn, 17);
	assert.equal(summary.tokensOut, 8);
	assert.equal(summary.workflowTokens, 250);
	assert.equal(summary.sessionId, "sess-1");
	assert.deepEqual(summary.deniedTools, ["Write", "Edit"]);
	assert.equal(summary.updatedAt, START + 5);
	assert.equal(summary.lastEventAt, START + 5);
	tick(10);
	const later = store.summaries()[0]!;
	assert.equal(later.updatedAt, START + 5);
	assert.equal(later.lastEventAt, START + 5);
	assert.equal(detailOf(store).lastEventAt, START + 5);
});

test("finish records each terminal status with its text, failure and end time", () => {
	for (const status of ["done", "failed", "aborted"] as const) {
		const { store, tick } = started();
		tick(20);
		store.finish("run-1", {
			status,
			text: "## Changed\nfoo.ts",
			failure: status === "done" ? undefined : `opus ${status}`,
			snapshot: { toolCalls: 4, tokensIn: 100, tokensOut: 20 },
		});
		const detail = detailOf(store);
		assert.equal(detail.status, status);
		assert.equal(detail.endedAt, START + 20);
		assert.equal(detail.updatedAt, START + 20);
		assert.equal(detail.lastEventAt, START + 20);
		assert.equal(detail.text, "## Changed\nfoo.ts");
		assert.equal(detail.textTruncated, false);
		assert.equal(detail.failureTruncated, false);
		assert.equal(detail.toolCalls, 4);
		assert.equal(detail.failure, status === "done" ? undefined : `opus ${status}`);
		assert.deepEqual(bare(detail.log.at(-1)), { at: START + 20, kind: "run", text: status === "done" ? "done" : `${status}: opus ${status}` });
	}
});

test("finish stops the tasks still running and leaves the ended ones exactly as they were", () => {
	for (const status of ["done", "failed", "aborted"] as const) {
		const { store, tick } = started();
		for (const id of ["a", "b", "c", "d"]) store.event("run-1", { type: "task_started", taskId: id, name: id.toUpperCase() });
		tick();
		store.event("run-1", { type: "task_ended", taskId: "b", status: "completed", summary: "found it", tokens: 200 });
		tick();
		store.event("run-1", { type: "task_ended", taskId: "c", status: "failed", summary: "no" });
		tick();
		store.event("run-1", { type: "task_ended", taskId: "d", status: "stopped" });
		const before = detailOf(store);
		const ended = before.tasks.filter((task) => task.id !== "a");
		tick();
		store.finish("run-1", { status, text: "out", failure: status === "done" ? undefined : "bad" });

		const detail = detailOf(store);
		const tasks = new Map(detail.tasks.map((task) => [task.id, task]));
		assert.equal(tasks.get("a")!.status, "stopped", `a task still running when the run ${status} must be stopped with it`);
		assert.equal(tasks.get("a")!.endedAt, detail.endedAt, "a stopped task ends when the run ends");
		assert.equal(detail.endedAt, START + 4, "the run ends at the finish time");
		for (const task of ended) assert.deepEqual(tasks.get(task.id), task, `the ${task.status} task ${task.id} must survive the finish untouched`);
		assert.equal(detail.log.length, before.log.length + 2, "finish adds the stop line and the run line and nothing else");
		assert.deepEqual(
			detail.log.slice(-2).map(bare),
			[
				{ at: START + 4, kind: "task", text: "1 task stopped with the run" },
				{ at: START + 4, kind: "run", text: status === "done" ? "done" : `${status}: bad` },
			],
			"the stop line comes before the run's own last word",
		);
	}
});

test("two tasks still running are stopped by one plural log line", () => {
	const { store, tick } = started();
	for (const id of ["a", "b", "c"]) store.event("run-1", { type: "task_started", taskId: id, name: id.toUpperCase() });
	tick();
	store.event("run-1", { type: "task_ended", taskId: "c", status: "completed" });
	tick();
	store.finish("run-1", { status: "aborted", failure: "stopped" });
	const detail = detailOf(store);
	assert.deepEqual(
		detail.tasks.map((task) => [task.id, task.status, task.endedAt]),
		[
			["a", "stopped", START + 2],
			["b", "stopped", START + 2],
			["c", "completed", START + 1],
		],
	);
	assert.deepEqual(bare(detail.log.at(-2)), { at: START + 2, kind: "task", text: "2 tasks stopped with the run" });
});

test("a run whose tasks have all ended gets no stop line", () => {
	const { store, tick } = started();
	store.event("run-1", { type: "task_started", taskId: "a", name: "A" });
	tick();
	store.event("run-1", { type: "task_ended", taskId: "a", status: "completed", summary: "found it" });
	const before = detailOf(store);
	tick();
	store.finish("run-1", { status: "done", text: "out" });
	const detail = detailOf(store);
	assert.deepEqual(detail.tasks, before.tasks, "an already ended task is not touched again");
	assert.equal(detail.log.length, before.log.length + 1, "finish adds only the run's own last word");
	assert.deepEqual(bare(detail.log.at(-1)), { at: START + 2, kind: "run", text: "done" });
	assert.ok(!detail.log.some((entry) => entry.text.includes("stopped with the run")), "nothing was running, so nothing was stopped");
});

test("a task joins its subagent tool calls by tool use id and leaves the run's own tool calls alone", () => {
	const { store, tick } = started();
	store.event("run-1", { type: "init", sessionId: "sess-1" });
	store.event("run-1", { type: "task_started", taskId: "task-1", toolUseId: "toolu_1", taskType: "workflow", name: "Probe", subagentType: "explore" });
	tick();
	store.event("run-1", { type: "agent_tool_call", parentToolUseId: "toolu_1", name: "Read" });
	store.event("run-1", { type: "agent_tool_call", parentToolUseId: "toolu_1", name: "Grep" });
	store.event("run-1", { type: "agent_tool_call", parentToolUseId: "toolu_other", name: "Bash" });
	store.event("run-1", {
		type: "task_progress",
		taskId: "task-1",
		summary: "reading the store",
		lastTool: "Grep",
		tokens: 120,
		toolUses: 2,
		phase: "Probe",
		agents: [
			{ label: "explore", state: "done" },
			{ label: "verify", state: "running" },
		],
	});
	store.progress("run-1", { toolCalls: 2, tokensIn: 5, tokensOut: 1 });
	tick();
	store.event("run-1", { type: "task_ended", taskId: "task-1", status: "completed", summary: "found it", tokens: 200 });

	const detail = detailOf(store);
	assert.equal(detail.sessionId, "sess-1");
	assert.equal(detail.toolCalls, 2);
	assert.equal(detail.agentToolCalls, 3);
	assert.deepEqual(detail.tasks, [
		{
			id: "task-1",
			toolUseId: "toolu_1",
			type: "workflow",
			name: "Probe",
			subagentType: "explore",
			status: "completed",
			startedAt: START,
			endedAt: START + 2,
			tokens: 200,
			toolUses: 2,
			lastTool: "Grep",
			summary: "found it",
			phase: "Probe",
			agents: [
				{ label: "explore", state: "done" },
				{ label: "verify", state: "running" },
			],
			agentToolCalls: 2,
		},
	]);
	assert.deepEqual(
		detail.log.map((entry) => [entry.kind, entry.text]),
		[
			["run", "session sess-1"],
			["task", "Probe started"],
			["agent", "Read in Probe"],
			["agent", "Grep in Probe"],
			["agent", "Bash in toolu_other"],
			["task", "Probe completed: found it"],
		],
	);
});

test("tool calls are logged and task progress is not", () => {
	const { store } = started();
	store.event("run-1", { type: "tool_call", name: "Bash", brief: "npm test" });
	store.event("run-1", { type: "task_started", taskId: "task-1", name: "Probe" });
	store.event("run-1", { type: "task_progress", taskId: "task-1", summary: "still going", tokens: 10 });
	store.event("run-1", { type: "task_progress", taskId: "task-1", summary: "nearly done", tokens: 20 });
	store.event("run-1", { type: "turn_result", ok: false, message: "boom" });
	store.event("run-1", { type: "turn_result", ok: true });
	const detail = detailOf(store);
	assert.deepEqual(
		detail.log.map((entry) => [entry.kind, entry.text]),
		[
			["tool", "Bash npm test"],
			["task", "Probe started"],
			["turn", "turn failed: boom"],
			["turn", "turn ended"],
		],
	);
	assert.equal(detail.tasks[0]?.summary, "nearly done");
	assert.equal(detail.tasks[0]?.tokens, 20);
});

test("progress copies cost, cache, context, model usage and thinking, and caps them", () => {
	const { store } = started();
	store.progress("run-1", {
		toolCalls: 1,
		tokensIn: 1_300,
		tokensOut: 20,
		cacheRead: 1_000,
		cacheWrite: 200,
		costUsd: 0.25,
		numTurns: 3,
		apiMs: 1_500,
		modelId: "claude-fable-5-1[1m]",
		contextTokens: 1_206,
		contextWindow: 1_000_000,
		models: Array.from({ length: MAX_MODELS + 3 }, (_unused, i) => ({ model: `m-${i}`, inputTokens: i, outputTokens: 1, cacheRead: 2, cacheWrite: 3, costUsd: 0.01 })),
		thinking: ["a", "b", "c", "d", "e", "f", "é".repeat(THINKING_CAP_BYTES)],
	});
	const detail = detailOf(store);
	assert.equal(detail.cacheRead, 1_000);
	assert.equal(detail.cacheWrite, 200);
	assert.equal(detail.costUsd, 0.25);
	assert.equal(detail.numTurns, 3);
	assert.equal(detail.apiMs, 1_500);
	assert.equal(detail.modelId, "claude-fable-5-1[1m]");
	assert.equal(detail.contextTokens, 1_206);
	assert.equal(detail.contextWindow, 1_000_000);
	assert.equal(detail.models.length, MAX_MODELS);
	assert.deepEqual(detail.models[1], { model: "m-1", inputTokens: 1, outputTokens: 1, cacheRead: 2, cacheWrite: 3, costUsd: 0.01 });
	assert.equal(detail.thinking.length, MAX_THINKING_BLOCKS);
	assert.equal(detail.thinking[0], "c");
	assert.ok(Buffer.byteLength(detail.thinking.at(-1)!, "utf8") <= THINKING_CAP_BYTES);
	const summary = store.summaries()[0]!;
	assert.equal(summary.costUsd, 0.25);
	assert.equal(summary.contextTokens, 1_206);
	assert.ok(!("thinking" in summary) && !("models" in summary), "the run list stays small");
});

test("a tool call keeps its input and result and marks its log entry", () => {
	const { store } = started();
	store.event("run-1", { type: "tool_call", name: "Bash", brief: "npm test", id: "tu-1", input: { command: "npm test" } });
	assert.deepEqual(bare(detailOf(store).log.at(-1)), { at: START, kind: "tool", text: "Bash npm test", toolUseId: "tu-1", call: "pending" });
	assert.deepEqual(store.callDetail("run-1", "tu-1"), {
		toolUseId: "tu-1",
		name: "Bash",
		input: '{\n  "command": "npm test"\n}',
		inputTruncated: false,
		resultTruncated: false,
		isError: false,
	});
	store.event("run-1", { type: "tool_result", toolUseId: "tu-1", text: "1 failing", isError: true });
	const detail = detailOf(store);
	assert.equal(detail.log.at(-1)!.call, "error");
	assert.equal(detail.toolErrors, 1);
	assert.equal(store.summaries()[0]!.toolErrors, 1);
	const call = store.callDetail("run-1", "tu-1")!;
	assert.equal(call.result, "1 failing");
	assert.equal(call.isError, true);

	store.event("run-1", { type: "tool_call", name: "Write", brief: "big", id: "tu-2", input: { content: "é".repeat(CALL_CAP_BYTES) } });
	store.event("run-1", { type: "tool_result", toolUseId: "tu-2", text: "x".repeat(CALL_CAP_BYTES + 1), isError: false });
	const big = store.callDetail("run-1", "tu-2")!;
	assert.equal(big.inputTruncated, true);
	assert.equal(big.resultTruncated, true);
	assert.ok(Buffer.byteLength(big.input, "utf8") <= CALL_CAP_BYTES && !big.input.includes("\uFFFD"));
	assert.equal(detailOf(store).log.at(-1)!.call, "ok");
	assert.equal(store.callDetail("run-1", "nope"), undefined);
	assert.equal(store.callDetail("nope", "tu-1"), undefined);
});

test("a call is forgotten with its log entry, and an Agent call's prompt goes to its task", () => {
	const { store } = started();
	store.event("run-1", { type: "tool_call", name: "Agent", brief: "probe", id: "tu-a", input: { description: "probe", prompt: "look at the store" } });
	store.event("run-1", { type: "task_started", taskId: "task-1", toolUseId: "tu-a", name: "probe" });
	store.event("run-1", { type: "agent_tool_call", parentToolUseId: "tu-a", name: "Read", id: "tu-sub", input: { file_path: "a.ts" } });
	store.event("run-1", { type: "tool_result", toolUseId: "tu-sub", text: "nope", isError: true });
	const detail = detailOf(store);
	assert.equal(detail.tasks[0]!.prompt, "look at the store");
	assert.equal(detail.toolErrors, 1);
	assert.equal(store.callDetail("run-1", "tu-sub")!.name, "Read");
	for (let i = 0; i < MAX_LOG_PER_RUN; i++) store.event("run-1", { type: "tool_call", name: "Bash", brief: `step ${i}`, id: `tu-${i}`, input: {} });
	assert.equal(store.callDetail("run-1", "tu-a"), undefined, "a call leaves with its log entry");
	assert.equal(store.callDetail("run-1", "tu-sub"), undefined);
	assert.ok(store.callDetail("run-1", `tu-${MAX_LOG_PER_RUN - 1}`));
	assert.equal(detailOf(store).tasks[0]!.prompt, "look at the store", "the task keeps its prompt");
});

test("the log keeps the newest entries in order", () => {
	const { store } = started();
	for (let i = 0; i < MAX_LOG_PER_RUN + 25; i++) store.event("run-1", { type: "tool_call", name: "Bash", brief: `step ${i}` });
	const { log } = detailOf(store);
	assert.equal(log.length, MAX_LOG_PER_RUN);
	assert.equal(log[0]!.text, `Bash step ${25}`);
	assert.equal(log[0]!.seq, 25);
	assert.equal(log.at(-1)!.seq, MAX_LOG_PER_RUN + 24);
	assert.equal(log.at(-1)!.text, `Bash step ${MAX_LOG_PER_RUN + 24}`);
});

test("the task list stops growing at the cap and the run keeps counting agent tool calls", () => {
	const { store } = started();
	for (let i = 0; i < MAX_TASKS_PER_RUN + 10; i++) {
		store.event("run-1", { type: "task_started", taskId: `task-${i}`, toolUseId: `toolu_${i}`, name: `Task ${i}` });
		store.event("run-1", { type: "agent_tool_call", parentToolUseId: `toolu_${i}`, name: "Read" });
		store.event("run-1", { type: "task_progress", taskId: `task-${i}`, tokens: i });
		store.event("run-1", { type: "task_ended", taskId: `task-${i}`, status: "completed" });
	}
	const detail = detailOf(store);
	assert.equal(detail.tasks.length, MAX_TASKS_PER_RUN);
	assert.equal(detail.tasks.at(-1)!.id, `task-${MAX_TASKS_PER_RUN - 1}`);
	assert.equal(detail.agentToolCalls, MAX_TASKS_PER_RUN + 10);
});

test("text and failure are capped in bytes at a code point boundary", () => {
	const { store } = started();
	const text = `x${"é".repeat(TEXT_CAP_BYTES)}`;
	const failure = `x${"é".repeat(FAILURE_CAP_BYTES)}`;
	store.finish("run-1", { status: "failed", text, failure });
	const detail = detailOf(store);
	assert.equal(detail.textTruncated, true);
	assert.equal(detail.failureTruncated, true);
	assert.ok(Buffer.byteLength(detail.text, "utf8") <= TEXT_CAP_BYTES);
	assert.ok(Buffer.byteLength(detail.failure!, "utf8") <= FAILURE_CAP_BYTES);
	assert.ok(Buffer.byteLength(detail.text, "utf8") > TEXT_CAP_BYTES - 4);
	assert.ok(Buffer.byteLength(detail.failure!, "utf8") > FAILURE_CAP_BYTES - 4);
	assert.equal(detail.text, `x${"é".repeat((TEXT_CAP_BYTES - 2) / 2)}`);
	assert.equal(detail.failure, `x${"é".repeat((FAILURE_CAP_BYTES - 2) / 2)}`);
	assert.ok(!detail.text.includes("�"));
	assert.ok(!detail.failure!.includes("�"));
	assert.ok(text.startsWith(detail.text));
});

test("a run keeps its prompt, contract and session, and caps the prompt in bytes", () => {
	const { store } = makeStore();
	store.start({
		id: "run-1",
		role: "fable",
		model: "fable",
		prompt: "goal and plan",
		contract: "contracts/plan.md",
		session: { kind: "fork", id: "sess-new", from: "sess-old", at: "msg-1" },
	});
	const detail = detailOf(store);
	assert.equal(detail.prompt, "goal and plan");
	assert.equal(detail.promptTruncated, false);
	assert.equal(detail.contract, "contracts/plan.md");
	assert.deepEqual(detail.session, { kind: "fork", id: "sess-new", from: "sess-old", at: "msg-1" });
	assert.ok(!("prompt" in store.summaries()[0]!), "the run list stays small: the prompt is in the detail only");

	store.start({ id: "run-2", role: "opus", model: "opus", prompt: `x${"é".repeat(PROMPT_CAP_BYTES)}` });
	const long = detailOf(store, "run-2");
	assert.equal(long.promptTruncated, true);
	assert.ok(Buffer.byteLength(long.prompt, "utf8") <= PROMPT_CAP_BYTES);
	assert.ok(!long.prompt.includes("\uFFFD"));
	assert.equal(long.session, undefined);
});

test("a report's Escalation, Review and Open questions headings become flags", () => {
	const { store } = makeStore();
	store.start({ id: "run-1", role: "opus", model: "opus" });
	store.finish("run-1", { status: "done", text: "## Changed\na.ts\n\n## Escalation\nneeds a decision\n\n### open QUESTIONS ##\n- which?\n\n## Reviewed\nno" });
	assert.deepEqual(store.summaries()[0]!.reportFlags, ["Escalation", "Open questions"]);
	store.start({ id: "run-2", role: "opus", model: "opus" });
	store.finish("run-2", { status: "done", text: "Escalation is not a heading here.\n## Review\nfixed one" });
	assert.deepEqual(detailOf(store, "run-2").reportFlags, ["Review"]);
	store.start({ id: "run-3", role: "opus", model: "opus" });
	store.finish("run-3", { status: "done", text: "## Changed\na.ts" });
	assert.ok(!("reportFlags" in detailOf(store, "run-3")));
});

test("finish keeps the changed files, caps the list and counts them all", () => {
	const { store } = makeStore();
	store.start({ id: "run-1", role: "opus", model: "opus" });
	store.finish("run-1", { status: "done", files: [{ path: "a.ts", status: "M", added: 2, removed: 1 }, { path: "b.png", status: "A" }] });
	const detail = detailOf(store);
	assert.deepEqual(detail.files, [{ path: "a.ts", status: "M", added: 2, removed: 1 }, { path: "b.png", status: "A" }]);
	assert.equal(detail.filesTruncated, false);
	assert.equal(store.summaries()[0]!.filesChanged, 2);
	assert.ok(!("files" in store.summaries()[0]!));

	store.start({ id: "run-2", role: "opus", model: "opus" });
	store.finish("run-2", { status: "done", files: Array.from({ length: MAX_FILES + 5 }, (_unused, i) => ({ path: `f${i}.ts`, status: "M" })) });
	const many = detailOf(store, "run-2");
	assert.equal(many.files!.length, MAX_FILES);
	assert.equal(many.filesTruncated, true);
	assert.equal(many.filesChanged, MAX_FILES + 5);

	store.start({ id: "run-3", role: "opus", model: "opus" });
	store.finish("run-3", { status: "done" });
	assert.equal(detailOf(store, "run-3").files, undefined, "no snapshot, no list");
});

test("a run keeps the Pi tool, tool call and Pi session that started it", () => {
	const { store } = makeStore();
	store.start({ id: "run-1", role: "opus", model: "opus", tool: "claude", toolCallId: "call-7", hostSessionId: "host-1" });
	const summary = store.summaries()[0]!;
	assert.equal(summary.tool, "claude");
	assert.equal(summary.toolCallId, "call-7");
	assert.equal(summary.hostSessionId, "host-1");
	assert.equal(detailOf(store).hostSessionId, "host-1");
});

test("a run records what started it and the run it reviews, and a link names the review it got", () => {
	const { store } = makeStore();
	store.start({ id: "id-1", handle: "run-1", role: "implement", model: "opus", tool: "claude", origin: "tool" });
	store.start({ id: "id-2", handle: "run-2", role: "ask", model: "opus", tool: "fusion auto-review", origin: "auto-review", reviews: "run-1" });
	store.reviewed("id-1", "run-2");
	const summaries = new Map(store.summaries().map((summary) => [summary.id, summary]));
	assert.equal(summaries.get("id-2")!.origin, "auto-review");
	assert.equal(summaries.get("id-2")!.reviews, "run-1");
	assert.equal(summaries.get("id-2")!.reviewedBy, undefined);
	assert.equal(summaries.get("id-1")!.origin, "tool");
	assert.equal(summaries.get("id-1")!.reviews, undefined);
	assert.equal(summaries.get("id-1")!.reviewedBy, "run-2");
	assert.equal(detailOf(store, "id-1").reviewedBy, "run-2");
	store.reviewed("id-1", "run-3");
	assert.equal(detailOf(store, "id-1").reviewedBy, "run-3", "a second review replaces the first");
	store.reviewed("nope", "run-4");
	assert.equal(store.detail("nope"), undefined);
	assert.equal(store.summaries().length, 2);
});

test("text at the cap is kept whole", () => {
	const { store } = started();
	const text = "é".repeat(TEXT_CAP_BYTES / 2);
	store.finish("run-1", { status: "done", text });
	const detail = detailOf(store);
	assert.equal(detail.text, text);
	assert.equal(detail.textTruncated, false);
	assert.equal(detail.failure, undefined);
	assert.equal(detail.failureTruncated, false);
});

test("the oldest finished runs are evicted past the cap and running ones never are", () => {
	const { store, tick } = makeStore();
	store.start({ id: "keep-running", role: "opus", model: "opus-4" });
	for (let i = 0; i < MAX_RUNS + 5; i++) {
		tick();
		store.start({ id: `run-${i}`, role: "opus", model: "opus-4" });
		store.finish(`run-${i}`, { status: "done" });
	}
	const ids = store.summaries().map((summary) => summary.id);
	assert.equal(ids.length, MAX_RUNS);
	assert.ok(ids.includes("keep-running"));
	assert.ok(!ids.includes("run-0"));
	assert.ok(!ids.includes(`run-${5}`));
	assert.ok(ids.includes(`run-${MAX_RUNS + 4}`));
	assert.equal(store.detail("run-0"), undefined);
});

test("a run that stays running is never evicted, even past the cap", () => {
	const { store, tick } = makeStore();
	for (let i = 0; i < MAX_RUNS + 5; i++) {
		tick();
		store.start({ id: `run-${i}`, role: "opus", model: "opus-4" });
	}
	assert.equal(store.summaries().length, MAX_RUNS + 5);
});

test("unknown ids are ignored", () => {
	const { store } = started();
	store.progress("nope", { toolCalls: 9, tokensIn: 9, tokensOut: 9 });
	store.event("nope", { type: "tool_call", name: "Bash", brief: "rm -rf" });
	store.finish("nope", { status: "failed", text: "gone", failure: "gone" });
	assert.equal(store.detail("nope"), undefined);
	assert.equal(store.summaries().length, 1);
	assert.deepEqual(detailOf(store).log, []);
});

const restored = {
	id: "held-1",
	handle: "run-1",
	role: "ultracode",
	model: "fable",
	title: "pi-fusion run-1 ultracode · host host-1",
	tool: "claude",
	toolCallId: "call-1",
	hostSessionId: "host-1",
	origin: "tool",
	reviews: "run-0",
	reviewedBy: "run-2",
	background: true,
	state: "done",
	startedAt: 5_000,
	endedAt: 9_000,
	prompt: "add the retry",
	contract: "contracts/ultracode.md",
	session: { kind: "new" as const, id: "sess-1" },
	sessionId: "sess-1",
	report: "## Changed\nfoo.ts\n\n## Escalation\nit needs a decision",
	files: [{ path: "foo.ts", status: "M", added: 2, removed: 1 }],
	filesTotal: 3,
	usage: { costUsd: 0.25, tokensIn: 40, tokensOut: 9, workflowTokens: 250, toolCalls: 7 },
};

test("a restored run keeps what the history kept of it and says it came from an earlier Pi process", () => {
	const { store } = makeStore();
	assert.equal(store.restore(restored), true);
	const detail = detailOf(store, "held-1");
	assert.equal(detail.restored, true);
	assert.equal(detail.handle, "run-1");
	assert.equal(detail.role, "ultracode");
	assert.equal(detail.model, "fable");
	assert.equal(detail.status, "done");
	assert.equal(detail.startedAt, 5_000);
	assert.equal(detail.endedAt, 9_000);
	assert.equal(detail.updatedAt, 9_000, "a restored run has not been updated since it ended");
	assert.equal(detail.text, restored.report);
	assert.deepEqual(detail.reportFlags, ["Escalation"]);
	assert.deepEqual(detail.files, [{ path: "foo.ts", status: "M", added: 2, removed: 1 }]);
	assert.equal(detail.filesChanged, 3);
	assert.equal(detail.filesTruncated, true, "the record kept three files and carried one");
	assert.equal(detail.prompt, "add the retry");
	assert.equal(detail.contract, "contracts/ultracode.md");
	assert.deepEqual(detail.session, { kind: "new", id: "sess-1" });
	assert.equal(detail.sessionId, "sess-1");
	assert.equal(detail.background, true);
	assert.equal(detail.tool, "claude");
	assert.equal(detail.toolCallId, "call-1");
	assert.equal(detail.hostSessionId, "host-1");
	assert.equal(detail.origin, "tool");
	assert.equal(detail.reviews, "run-0");
	assert.equal(detail.reviewedBy, "run-2");
	assert.equal(detail.costUsd, 0.25);
	assert.equal(detail.tokensIn, 40);
	assert.equal(detail.tokensOut, 9);
	assert.equal(detail.workflowTokens, 250);
	assert.equal(detail.toolCalls, 7);
	assert.deepEqual(detail.log, [], "nobody watched the run, so it has no log");
	assert.deepEqual(detail.tasks, []);
	assert.equal(store.summaries()[0]!.restored, true);
});

test("a restored failure carries its failure text and no report flags", () => {
	const { store } = makeStore();
	assert.equal(store.restore({ ...restored, state: "aborted", report: undefined, failure: "aborted when the earlier Pi process ended" }), true);
	const detail = detailOf(store, "held-1");
	assert.equal(detail.status, "aborted");
	assert.equal(detail.failure, "aborted when the earlier Pi process ended");
	assert.equal(detail.text, "");
	assert.equal(detail.reportFlags, undefined);
});

test("a run that was still going when its Pi process ended is restored by nobody", () => {
	const { store } = makeStore();
	for (const state of ["running", "waiting", "gone"]) {
		assert.equal(store.restore({ ...restored, state }), false, `${state} is no state to restore`);
	}
	assert.deepEqual(store.summaries(), []);
	assert.equal(store.detail("held-1"), undefined);
});

test("a restore leaves a run this session already holds alone", () => {
	const { store } = makeStore();
	store.start({ id: "held-1", role: "opus", model: "opus-4" });
	store.finish("held-1", { status: "failed", text: "the live one" });
	assert.equal(store.restore(restored), false);
	const detail = detailOf(store, "held-1");
	assert.equal(detail.role, "opus");
	assert.equal(detail.text, "the live one");
	assert.equal(detail.restored, undefined);
});

test("restored runs count towards the cap as the finished runs they are", () => {
	const { store, tick } = makeStore();
	store.start({ id: "keep-running", role: "opus", model: "opus-4" });
	for (let i = 0; i < MAX_RUNS + 5; i++) {
		tick();
		assert.equal(store.restore({ ...restored, id: `held-${i}`, startedAt: START + i }), true);
	}
	const ids = store.summaries().map((summary) => summary.id);
	assert.equal(ids.length, MAX_RUNS);
	assert.ok(ids.includes("keep-running"), "a live run outlives the restored ones");
	assert.ok(!ids.includes("held-0"));
	assert.ok(ids.includes(`held-${MAX_RUNS + 4}`));
});

test("summaries are newest first", () => {
	const { store, tick } = makeStore();
	store.start({ id: "old", role: "opus", model: "opus-4" });
	tick(10);
	store.start({ id: "mid", role: "fable", model: "fable" });
	tick(10);
	store.start({ id: "new", role: "opus", model: "opus-4" });
	assert.deepEqual(
		store.summaries().map((summary) => summary.id),
		["new", "mid", "old"],
	);
});

test("returned views are copies with only the contracted keys", () => {
	const { store, tick } = started();
	store.progress("run-1", { activity: "thinking", toolCalls: 1, tokensIn: 2, tokensOut: 3, workflowTokens: 4, sessionId: "sess-1", deniedTools: ["Write"] });
	store.event("run-1", { type: "task_started", taskId: "task-1", toolUseId: "toolu_1", taskType: "workflow", name: "Probe", subagentType: "explore" });
	store.event("run-1", { type: "task_progress", taskId: "task-1", summary: "going", lastTool: "Read", tokens: 5, toolUses: 6, phase: "Probe", agents: [{ label: "a", state: "done" }] });
	tick();
	store.event("run-1", { type: "task_ended", taskId: "task-1", status: "failed", summary: "no" });
	store.finish("run-1", { status: "failed", text: "out", failure: "bad" });

	const detail = detailOf(store);
	assert.deepEqual(Object.keys(detail).sort(), [
		"activity",
		"agentToolCalls",
		"cacheRead",
		"cacheWrite",
		"deniedTools",
		"endedAt",
		"failure",
		"failureTruncated",
		"filesTruncated",
		"id",
		"lastEventAt",
		"log",
		"model",
		"models",
		"prompt",
		"promptTruncated",
		"role",
		"sessionId",
		"startedAt",
		"status",
		"tasks",
		"text",
		"textTruncated",
		"thinking",
		"tokensIn",
		"tokensOut",
		"toolCalls",
		"toolErrors",
		"updatedAt",
		"workflowTokens",
	]);
	assert.deepEqual(Object.keys(detail.tasks[0]!).sort(), [
		"agentToolCalls",
		"agents",
		"endedAt",
		"id",
		"lastTool",
		"name",
		"phase",
		"startedAt",
		"status",
		"subagentType",
		"summary",
		"tokens",
		"toolUseId",
		"toolUses",
		"type",
	]);
	assert.deepEqual(Object.keys(detail.log[0]!).sort(), ["at", "kind", "seq", "text"]);
	assert.deepEqual(Object.keys(store.summaries()[0]!).sort(), [
		"activity",
		"agentToolCalls",
		"deniedTools",
		"endedAt",
		"id",
		"lastEventAt",
		"model",
		"role",
		"sessionId",
		"startedAt",
		"status",
		"tokensIn",
		"tokensOut",
		"toolCalls",
		"toolErrors",
		"updatedAt",
		"workflowTokens",
	]);

	detail.text = "mutated";
	detail.tasks[0]!.name = "mutated";
	detail.tasks[0]!.agents![0]!.label = "mutated";
	detail.tasks.push({ ...detail.tasks[0]! });
	detail.log[0]!.text = "mutated";
	detail.log.length = 0;
	detail.deniedTools!.push("Bash");
	const again = detailOf(store);
	assert.equal(again.text, "out");
	assert.equal(again.tasks.length, 1);
	assert.equal(again.tasks[0]!.name, "Probe");
	assert.deepEqual(again.tasks[0]!.agents, [{ label: "a", state: "done" }]);
	assert.equal(again.log.length, 3);
	assert.equal(again.log[0]!.text, "Probe started");
	assert.deepEqual(again.deniedTools, ["Write"]);

	const summary = store.summaries()[0]!;
	summary.role = "mutated";
	summary.deniedTools!.length = 0;
	assert.equal(store.summaries()[0]!.role, "opus");
	assert.deepEqual(store.summaries()[0]!.deniedTools, ["Write"]);
});

test("long strings, agent lists and denied tools are capped", () => {
	const { store } = started();
	const long = "y".repeat(MAX_STRING_CHARS + 50);
	store.progress("run-1", {
		activity: long,
		toolCalls: 1,
		tokensIn: 1,
		tokensOut: 1,
		sessionId: long,
		deniedTools: Array.from({ length: MAX_DENIED_TOOLS + 20 }, (_unused, i) => `Tool${i}`),
	});
	store.event("run-1", { type: "task_started", taskId: long, name: long, toolUseId: long, taskType: long, subagentType: long });
	store.event("run-1", {
		type: "task_progress",
		taskId: long,
		summary: long,
		lastTool: long,
		phase: long,
		agents: Array.from({ length: MAX_AGENTS_PER_TASK + 30 }, () => ({ label: long, state: long })),
	});
	store.event("run-1", { type: "tool_call", name: long, brief: long });
	const detail = detailOf(store);
	assert.equal(detail.activity!.length, MAX_STRING_CHARS);
	assert.equal(detail.sessionId!.length, MAX_STRING_CHARS);
	assert.equal(detail.deniedTools!.length, MAX_DENIED_TOOLS);
	const task = detail.tasks[0]!;
	for (const value of [task.id, task.name, task.toolUseId, task.type, task.subagentType, task.summary, task.lastTool, task.phase]) {
		assert.equal(value!.length, MAX_STRING_CHARS);
	}
	assert.equal(task.agents!.length, MAX_AGENTS_PER_TASK);
	assert.equal(task.agents![0]!.label.length, MAX_STRING_CHARS);
	assert.equal(task.agents![0]!.state.length, MAX_STRING_CHARS);
	for (const entry of detail.log) assert.equal(entry.text.length, MAX_STRING_CHARS);
});

test("a surrogate pair is never cut in half by the string cap", () => {
	const { store } = started();
	store.progress("run-1", { activity: "😀".repeat(MAX_STRING_CHARS), toolCalls: 0, tokensIn: 0, tokensOut: 0 });
	const activity = store.summaries()[0]!.activity!;
	assert.equal(activity.length, MAX_STRING_CHARS);
	assert.equal([...activity].length, MAX_STRING_CHARS / 2);
	assert.ok(!activity.includes("�"));
});

test("a run keeps its status through later progress and events", () => {
	const { store, tick } = started();
	store.finish("run-1", { status: "done", text: "out" });
	tick();
	store.progress("run-1", { toolCalls: 7, tokensIn: 1, tokensOut: 1 });
	const summary = store.summaries()[0]!;
	const status: RunStatus = summary.status;
	assert.equal(status, "done");
	assert.equal(summary.toolCalls, 7);
	assert.equal(summary.lastEventAt, START + 1);
});

const CWD = "/tmp/pi-fusion-dashboard";
const CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions", "dashboard");

const asset = (name: string): string => fs.readFileSync(path.join(ASSET_DIR, name), "utf8");

interface Answer {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

interface Ask {
	path: string;
	method?: string;
	/** `null` sends no Host header at all; the default is the loopback host the server expects. */
	host?: string | null;
	origin?: string;
	agent?: http.Agent;
}

function ask(port: number, options: Ask): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {};
		if (options.host !== null) headers.host = options.host ?? `127.0.0.1:${port}`;
		if (options.origin !== undefined) headers.origin = options.origin;
		const request = http.request(
			{ host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET", setHost: false, headers, agent: options.agent ?? false },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }),
				);
			},
		);
		request.on("error", reject);
		request.end();
	});
}

function seeded(): RunStore {
	let clock = START;
	const store = new RunStore(() => clock);
	store.start({ id: "run-old", role: "fable", model: "fable", title: "consolidate" });
	store.event("run-old", { type: "init", sessionId: "sess-old" });
	store.finish("run-old", { status: "done", text: "done report", snapshot: { toolCalls: 2, tokensIn: 10, tokensOut: 3 } });
	clock += 1_000;
	store.start({ id: "run-new", role: "opus", model: "opus-4" });
	store.progress("run-new", { activity: "Bash npm test", toolCalls: 1, tokensIn: 5, tokensOut: 1 });
	return store;
}

async function serve(store: RunStore, body: (dashboard: Dashboard) => Promise<void>): Promise<void> {
	const dashboard = await startDashboard(store, { cwd: CWD });
	try {
		await body(dashboard);
	} finally {
		await dashboard.close();
	}
}

const tokenOf = (dashboard: Dashboard): string => dashboard.url.split("/")[3] ?? "";

function assertSecure(answer: Answer, what: string): void {
	assert.equal(answer.headers["cache-control"], "no-store", `${what} must not be cached`);
	assert.equal(answer.headers["x-content-type-options"], "nosniff", `${what} must not be content sniffed`);
	assert.equal(answer.headers["referrer-policy"], "no-referrer", `${what} must not leak the token through a referrer`);
	assert.equal(answer.headers["x-frame-options"], "DENY", `${what} must not be framed by another page`);
	assert.equal(answer.headers["content-security-policy"], CSP, `${what} must carry the locked down CSP`);
	assert.equal(answer.headers["access-control-allow-origin"], undefined, `${what} must not be readable by another origin`);
	assert.match(String(answer.headers["content-type"]), /; charset=utf-8$/, `${what} must declare utf-8`);
}

test("the dashboard url names the bound port and carries a fresh token", async () => {
	await serve(seeded(), async (first) => {
		await serve(seeded(), async (second) => {
			const shape = /^http:\/\/127\.0\.0\.1:(\d+)\/([A-Za-z0-9_-]{32})\/$/;
			const one = shape.exec(first.url);
			const two = shape.exec(second.url);
			assert.ok(one, "the url must be a loopback url with a 32 character token and a trailing slash");
			assert.ok(two, "the second url must have the same shape");
			assert.equal(Number(one[1]), first.port, "the url must name the port the server is listening on");
			assert.ok(first.port > 0, "port 0 must resolve to a real port");
			assert.notEqual(one[2], two[2], "each dashboard must get its own capability token");
		});
	});
});

test("the page, its script and its stylesheet are served with their bytes and content types", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const cases = [
			["", "index.html", "text/html; charset=utf-8"],
			["index.html", "index.html", "text/html; charset=utf-8"],
			["app.js", "app.js", "text/javascript; charset=utf-8"],
			["app.css", "app.css", "text/css; charset=utf-8"],
		] as const;
		for (const [target, name, type] of cases) {
			const answer = await ask(dashboard.port, { path: `/${token}/${target}` });
			assert.equal(answer.status, 200, `${name} must be served`);
			assert.equal(answer.headers["content-type"], type, `${name} must declare its own type`);
			assert.equal(answer.body, asset(name), `${name} must be served byte for byte from the extension directory`);
			assert.equal(answer.headers["content-length"], String(Buffer.byteLength(asset(name), "utf8")), `${name} must report its length`);
			assertSecure(answer, name);
		}
		const bare = await ask(dashboard.port, { path: `/${token}` });
		assert.equal(bare.status, 301, "the token path without a trailing slash must redirect, or the page's relative urls resolve above it");
		assert.equal(bare.headers.location, `/${token}/`, "the redirect must point at the token directory");
		assert.ok(!bare.body.includes(token), "the redirect body must not repeat the capability token");
		assert.equal(bare.headers["content-type"], "text/plain; charset=utf-8", "the redirect carries a plain body");
		assertSecure(bare, "the redirect");
	});
});

test("the slashless token path redirects so the page's relative script and stylesheet resolve under the token", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const query = await ask(dashboard.port, { path: `/${token}?x=1` });
		assert.equal(query.status, 301, "a query string must not stop the redirect");
		assert.equal(query.headers.location, `/${token}/`, "the redirect must drop the query string");

		const get = await ask(dashboard.port, { path: `/${token}` });
		const head = await ask(dashboard.port, { path: `/${token}`, method: "HEAD" });
		assert.equal(head.status, 301, "HEAD must answer like GET");
		assert.equal(head.body, "", "HEAD must not send a body");
		for (const header of ["location", "content-type", "content-length"]) {
			assert.equal(head.headers[header], get.headers[header], `HEAD must report the ${header} GET would send`);
		}

		const reference = await ask(dashboard.port, { path: `/${token}/nope` });
		const wrong = await ask(dashboard.port, { path: `/${(token[0] === "z" ? "y" : "z") + token.slice(1)}` });
		assert.equal(wrong.status, 404, "a wrong token must never be redirected");
		assert.equal(wrong.headers.location, undefined, "a wrong token must not be told where the page lives");
		assert.equal(wrong.body, reference.body, "a wrong token must look like any other 404");

		const location = String(get.headers.location);
		const types: Record<string, string> = { "app.js": "text/javascript; charset=utf-8", "app.css": "text/css; charset=utf-8" };
		for (const [name, type] of Object.entries(types)) {
			const resolved = new URL(name, `http://127.0.0.1:${dashboard.port}${location}`).pathname;
			const answer = await ask(dashboard.port, { path: resolved });
			assert.equal(answer.status, 200, `${name} must load from the redirected page`);
			assert.equal(answer.headers["content-type"], type, `${name} must keep its type`);
			const above = new URL(name, `http://127.0.0.1:${dashboard.port}/${token}`).pathname;
			assert.equal(above, `/${name}`, `${name} resolves above the token without the redirect`);
			assert.equal((await ask(dashboard.port, { path: above })).status, 404, `${name} above the token is not served`);
		}
	});
});

test("api/runs returns the working directory and the runs newest first and ignores a query string", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const answer = await ask(dashboard.port, { path: `/${token}/api/runs` });
		assert.equal(answer.status, 200, "the run list must be served");
		assert.equal(answer.headers["content-type"], "application/json; charset=utf-8", "the run list is JSON");
		const payload = JSON.parse(answer.body) as { cwd: string; runs: RunSummary[] };
		assert.equal(payload.cwd, CWD, "the page shows the session's working directory");
		assert.deepEqual(
			payload.runs.map((run) => run.id),
			["run-new", "run-old"],
			"runs must arrive newest first",
		);
		assert.equal(payload.runs[0]?.activity, "Bash npm test", "a summary carries the live activity");
		assert.equal(payload.runs[1]?.status, "done", "a finished run keeps its terminal status");
		assert.equal((payload.runs[0] as unknown as Record<string, unknown>).text, undefined, "a summary must not carry the report text");
		const query = await ask(dashboard.port, { path: `/${token}/api/runs?since=1&x=y` });
		assert.equal(query.status, 200, "a query string must not change the route");
		assert.equal(query.body, answer.body, "a query string must not change the payload");
	});
});

test("api/runs carries the session usage only when the dashboard was given one", async () => {
	await serve(seeded(), async (dashboard) => {
		const payload = JSON.parse((await ask(dashboard.port, { path: `/${tokenOf(dashboard)}/api/runs` })).body) as Record<string, unknown>;
		assert.equal(payload.usage, undefined, "without a usage function the payload is what it always was");
	});
	let calls = 1;
	const usage = () => ({ costUsd: 0.5 * calls, tokensIn: 10, tokensOut: 2, workflowTokens: 3, calls, warnUsd: [1, 2], limitUsd: 5 });
	const dashboard = await startDashboard(seeded(), { cwd: CWD, usage });
	try {
		const first = JSON.parse((await ask(dashboard.port, { path: `/${tokenOf(dashboard)}/api/runs` })).body) as { usage: ReturnType<typeof usage>; runs: RunSummary[] };
		assert.deepEqual(first.usage, { costUsd: 0.5, tokensIn: 10, tokensOut: 2, workflowTokens: 3, calls: 1, warnUsd: [1, 2], limitUsd: 5 });
		assert.equal(first.runs.length, 2, "the usage rides along with the run list the page already polls");
		calls = 3;
		const later = JSON.parse((await ask(dashboard.port, { path: `/${tokenOf(dashboard)}/api/runs` })).body) as { usage: ReturnType<typeof usage> };
		assert.equal(later.usage.costUsd, 1.5, "every poll reads the totals again");
	} finally {
		await dashboard.close();
	}
});

test("api/runs/<id>/calls/<tool use id> returns one call and anything else is a plain 404", async () => {
	const store = new RunStore(() => START);
	store.start({ id: "run-1", role: "opus", model: "opus" });
	store.event("run-1", { type: "tool_call", name: "Bash", brief: "ls", id: "toolu_01A", input: { command: "ls" } });
	await serve(store, async (dashboard) => {
		const token = tokenOf(dashboard);
		const answer = await ask(dashboard.port, { path: `/${token}/api/runs/run-1/calls/toolu_01A` });
		assert.equal(answer.status, 200);
		assert.equal(answer.headers["content-type"], "application/json; charset=utf-8");
		assert.equal(JSON.parse(answer.body).name, "Bash");
		for (const bad of ["run-1/calls/nope", "run-1/calls/", "run-1/calls/a/b", "run-1/other/toolu_01A", "nope/calls/toolu_01A", "run-1/calls/..%2F"]) {
			assert.equal((await ask(dashboard.port, { path: `/${token}/api/runs/${bad}` })).status, 404, bad);
		}
	});
});

test("api/runs/<id> returns one run's detail and unknown or malformed ids are plain 404s", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const answer = await ask(dashboard.port, { path: `/${token}/api/runs/run-old` });
		assert.equal(answer.status, 200, "a known run must have a detail");
		const detail = JSON.parse(answer.body) as RunDetail;
		assert.equal(detail.id, "run-old", "the detail must be the run that was asked for");
		assert.equal(detail.text, "done report", "the detail carries the run's report");
		assert.deepEqual(
			detail.log.map((entry) => entry.text),
			["session sess-old", "done"],
			"the detail carries the run's log",
		);
		const missing = await ask(dashboard.port, { path: `/${token}/api/runs/nope` });
		assert.equal(missing.status, 404, "an unknown run id must be a 404");
		assertSecure(missing, "a 404");
		for (const id of ["x".repeat(65), "run.1", "run%2Fold", "run%2fold", "", "run-old/extra", "run-old.json"]) {
			const bad = await ask(dashboard.port, { path: `/${token}/api/runs/${id}` });
			assert.equal(bad.status, 404, `the id ${JSON.stringify(id)} must never reach the store`);
			assert.equal(bad.body, missing.body, "a rejected id must look like any other 404");
		}
	});
});

test("every response carries the security headers and never the token", async () => {
	const store = seeded();
	store.summaries = () => {
		throw new Error("store boom");
	};
	await serve(store, async (dashboard) => {
		const token = tokenOf(dashboard);
		const cases: Array<[string, number, Ask]> = [
			["the page", 200, { path: `/${token}/` }],
			["a redirect", 301, { path: `/${token}` }],
			["a 404", 404, { path: `/${token}/nope` }],
			["a rejected method", 405, { path: `/${token}/`, method: "POST" }],
			["an overlong url", 414, { path: `/${token}/${"a".repeat(2_100)}` }],
			["a wrong Host", 400, { path: `/${token}/`, host: "evil.example:1" }],
			["a wrong Origin", 403, { path: `/${token}/`, origin: "http://evil.example" }],
			["a handler failure", 500, { path: `/${token}/api/runs` }],
			["a HEAD", 200, { path: `/${token}/app.css`, method: "HEAD" }],
		];
		for (const [what, status, options] of cases) {
			const answer = await ask(dashboard.port, options);
			assert.equal(answer.status, status, `${what} must answer ${status}`);
			assertSecure(answer, what);
			assert.ok(!answer.body.includes(token), `${what} must never repeat the capability token`);
			assert.ok(!answer.body.includes("store boom"), `${what} must not leak what went wrong inside the server`);
		}
	});
});

test("a request without the right token is a plain 404, whatever the token looks like", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const reference = await ask(dashboard.port, { path: `/${token}/nope` });
		assert.equal(reference.status, 404, "an unknown route under the right token is a 404");
		const sameLength = (token[0] === "z" ? "y" : "z") + token.slice(1);
		const escaped = `%${token.charCodeAt(0).toString(16).padStart(2, "0")}${token.slice(1)}`;
		const cases = [
			["a wrong token of the same length", `/${sameLength}/`],
			["a percent encoded token", `/${escaped}/`],
			["a shorter token", "/abc/"],
			["a longer token", `/${token}${token}/`],
			["an empty first segment", "//"],
			["the root", "/"],
			["the api without a token", "/api/runs"],
		] as const;
		for (const [what, target] of cases) {
			const answer = await ask(dashboard.port, { path: target });
			assert.equal(answer.status, 404, `${what} must not be served`);
			assert.equal(answer.body, reference.body, `${what} must look like any other 404, with no hint that the token was wrong`);
			assert.ok(!answer.body.includes(token), `${what} must not be answered with the real token`);
			assert.equal(answer.headers["content-type"], reference.headers["content-type"], `${what} must answer like any other 404`);
		}
	});
});

test("only GET and HEAD are allowed", async () => {
	await serve(seeded(), async (dashboard) => {
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
			const answer = await ask(dashboard.port, { path: `/${tokenOf(dashboard)}/api/runs`, method });
			assert.equal(answer.status, 405, `${method} must be refused: the dashboard only reads`);
			assert.equal(answer.headers.allow, "GET, HEAD", `${method} must be told what is allowed`);
		}
	});
});

test("a request target longer than 2048 characters is refused", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const long = await ask(dashboard.port, { path: `/${token}/${"a".repeat(2_100)}` });
		assert.equal(long.status, 414, "an overlong target must be refused before any routing");
		const short = await ask(dashboard.port, { path: `/${token}/${"a".repeat(2_000 - token.length)}` });
		assert.equal(short.status, 404, "a target under the limit is routed normally");
	});
});

test("the Host header must name this loopback server", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const loopback = await ask(dashboard.port, { path: `/${token}/`, host: `localhost:${dashboard.port}` });
		assert.equal(loopback.status, 200, "localhost with the right port is what a browser sends");
		const cases = [
			["another site", `evil.example:${dashboard.port}`],
			["the wrong port", `127.0.0.1:${dashboard.port + 1}`],
			["a different case", `LOCALHOST:${dashboard.port}`],
			["an IPv6 literal", `[::1]:${dashboard.port}`],
			["no port at all", "127.0.0.1"],
		] as const;
		for (const [what, host] of cases) {
			const answer = await ask(dashboard.port, { path: `/${token}/`, host });
			assert.equal(answer.status, 400, `a Host naming ${what} must be refused, so a rebound DNS name cannot reach the dashboard`);
			assertSecure(answer, `a Host naming ${what}`);
		}
		const none = await ask(dashboard.port, { path: `/${token}/`, host: null });
		assert.equal(none.status, 400, "a request with no Host is refused by the HTTP parser before the handler sees it");
	});
});

test("an Origin from another page is refused and the loopback origins are allowed", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		for (const origin of [`http://127.0.0.1:${dashboard.port}`, `http://localhost:${dashboard.port}`]) {
			const answer = await ask(dashboard.port, { path: `/${token}/api/runs`, origin });
			assert.equal(answer.status, 200, `the page's own origin ${origin} must be allowed`);
		}
		for (const origin of ["http://evil.example", "null", `https://127.0.0.1:${dashboard.port}`, `http://127.0.0.1:${dashboard.port + 1}`]) {
			const answer = await ask(dashboard.port, { path: `/${token}/api/runs`, origin });
			assert.equal(answer.status, 403, `the origin ${origin} must be refused, so no other page can read a run`);
			assertSecure(answer, `the origin ${origin}`);
		}
	});
});

test("path traversal after the token reads nothing from disk", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const reference = await ask(dashboard.port, { path: `/${token}/nope` });
		const targets = [
			"../package.json",
			"../../package.json",
			"%2e%2e/package.json",
			"..%2fpackage.json",
			"./app.js",
			"/etc/hosts",
			"dashboard/app.js",
			"app%2ejs",
			"api%2fruns",
		];
		for (const target of targets) {
			const answer = await ask(dashboard.port, { path: `/${token}/${target}` });
			assert.equal(answer.status, 404, `${target} must not be routed to the file system, and an escape must not decode into a route`);
			assert.equal(answer.body, reference.body, `${target} must answer like any other unknown route`);
			assert.ok(!answer.body.includes("pi-fusion"), `${target} must not return the content of a file`);
		}
	});
});

test("HEAD returns the headers and the length without a body", async () => {
	await serve(seeded(), async (dashboard) => {
		const token = tokenOf(dashboard);
		const get = await ask(dashboard.port, { path: `/${token}/app.js` });
		const head = await ask(dashboard.port, { path: `/${token}/app.js`, method: "HEAD" });
		assert.equal(head.status, 200, "HEAD must answer like GET");
		assert.equal(head.body, "", "HEAD must not send a body");
		assert.equal(head.headers["content-length"], String(Buffer.byteLength(get.body, "utf8")), "HEAD must report the length GET would send");
		assert.equal(head.headers["content-type"], get.headers["content-type"], "HEAD must report the type GET would send");
	});
});

test("close stops listening, hands back one promise and does not wait for open connections", async () => {
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
	const half = new net.Socket();
	const dashboard = await startDashboard(seeded(), { cwd: CWD });
	try {
		const token = tokenOf(dashboard);
		const polled = await ask(dashboard.port, { path: `/${token}/api/runs`, agent });
		assert.equal(polled.status, 200, "the browser's poll must succeed on a kept alive socket");
		assert.ok(
			Object.values(agent.freeSockets).some((sockets) => (sockets?.length ?? 0) > 0),
			"the poll must leave a socket open, or this test would prove nothing",
		);
		await new Promise<void>((resolve, reject) => {
			half.once("error", reject);
			half.connect(dashboard.port, "127.0.0.1", () => {
				half.write(`GET /${token}/ HTTP/1.1\r\nHost: 127.0.0.1:${dashboard.port}\r\n`, () => resolve());
			});
		});
		await setTimeout(50);
		const closing = dashboard.close();
		assert.equal(dashboard.close(), closing, "close must hand back the same promise every time");
		const outcome = await Promise.race([closing.then(() => "closed"), setTimeout(2_000, "hung", { ref: false })]);
		assert.equal(outcome, "closed", "close must destroy the open sockets instead of waiting for a poll or a half sent request");
		await dashboard.close();
		await assert.rejects(
			ask(dashboard.port, { path: `/${token}/` }),
			(error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED",
			"nothing may still be listening after close",
		);
	} finally {
		half.destroy();
		agent.destroy();
		await dashboard.close();
	}
});

test("a port that is already taken fails the start and leaves the running dashboard alone", async () => {
	await serve(seeded(), async (dashboard) => {
		await assert.rejects(
			startDashboard(seeded(), { cwd: CWD, port: dashboard.port }),
			(error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
			"a taken port must reject instead of leaving a half started server",
		);
		const answer = await ask(dashboard.port, { path: `/${tokenOf(dashboard)}/` });
		assert.equal(answer.status, 200, "the running dashboard must survive a failed second start");
	});
});

test("the page has no inline script, no inline style and no event handler attribute", () => {
	const html = asset("index.html");
	const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
	assert.equal(scripts.length, 1, "the page must load exactly one script");
	for (const script of scripts) {
		assert.match(script[1], /\ssrc="[^"]+"/, "every script must come from a file, which is all script-src 'self' allows");
		assert.equal(script[2].trim(), "", "an inline script would need a CSP hole to run");
	}
	assert.equal((html.match(/<script\s+src="app\.js"\s+defer><\/script>/g) ?? []).length, 1, "the page must load app.js deferred and nothing else");
	assert.equal((html.match(/<link\s+rel="stylesheet"\s+href="app\.css">/g) ?? []).length, 1, "the page must load app.css and no other stylesheet");
	assert.ok(!/\son[a-zA-Z]+\s*=/.test(html), "an inline event handler attribute would run code the CSP cannot cover");
	assert.ok(!/<style[\s>]/i.test(html), "an inline style element would need style-src 'unsafe-inline'");
	assert.ok(!/\sstyle\s*=/i.test(html), "an inline style attribute would need style-src 'unsafe-inline'");
	assert.ok(!html.includes("javascript:"), "a javascript: url would run code from an attribute");
	assert.ok(html.includes("Dashboard disconnected. Run /fusion dashboard again."), "the page carries the disconnected banner as static text");
});

test("the dashboard script cannot inject markup or run generated code", () => {
	const source = asset("app.js");
	for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
		assert.ok(!source.includes(forbidden), `app.js must not use ${forbidden}: a run's own output must never be parsed as markup or code`);
	}
	assert.ok(source.includes("api/runs"), "app.js must poll the relative api path, so the token stays in the page url");
	assert.ok(!/https?:\/\//.test(source), "app.js must not reach any absolute url");
	assert.doesNotThrow(() => new vm.Script(source, { filename: "app.js" }), "app.js must parse as a script");
});

test("the stylesheet fetches nothing", () => {
	const css = asset("app.css");
	for (const forbidden of ["url(", "@import", "expression("]) {
		assert.ok(!css.includes(forbidden), `app.css must not use ${forbidden}: the page must load nothing beyond its own three files`);
	}
});
