import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { UsageTotals } from "./budget.ts";
import type { ChangedFile } from "./changes.ts";
import type { ChildEvent, RunOrigin } from "./fusion.ts";

export const MAX_RUNS = 30;
export const MAX_LOG_PER_RUN = 100;
export const MAX_TASKS_PER_RUN = 100;
export const TEXT_CAP_BYTES = 32_768;
export const FAILURE_CAP_BYTES = 4_096;
export const PROMPT_CAP_BYTES = 262_144;
export const CALL_CAP_BYTES = 16_384;
export const TASK_PROMPT_CAP_BYTES = 32_768;
const AGENT_TOOLS = new Set(["Agent", "Task"]);
/** The states a run can be restored in: a record that never reached one of them is not a run this session can show. */
const ENDED_STATUSES = new Set<string>(["done", "failed", "aborted", "cancelled"]);
const ORIGINS = new Set<string>(["tool", "review", "auto-review"]);
/** Report sections the contracts ask for only when the host must act on them. */
export const REPORT_FLAGS = ["Escalation", "Review", "Open questions"];
export const MAX_STRING_CHARS = 400;
export const MAX_AGENTS_PER_TASK = 200;
export const MAX_DENIED_TOOLS = 50;
export const MAX_MODELS = 20;
export const MAX_FILES = 500;
export const MAX_THINKING_BLOCKS = 5;
export const THINKING_CAP_BYTES = 16_384;

export type RunStatus = "running" | "waiting" | "done" | "failed" | "aborted" | "cancelled";
export type TaskStatus = "running" | "completed" | "failed" | "stopped";

export interface ModelUsageView {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

/** The live counters of a child run. `ChildRun` satisfies this, and the store copies the fields it needs. */
export interface RunProgress {
	activity?: string;
	toolCalls: number;
	tokensIn: number;
	tokensOut: number;
	cacheRead?: number;
	cacheWrite?: number;
	costUsd?: number;
	models?: ModelUsageView[];
	numTurns?: number;
	apiMs?: number;
	modelId?: string;
	contextTokens?: number;
	contextWindow?: number;
	thinking?: string[];
	workflowTokens?: number;
	sessionId?: string;
	deniedTools?: string[];
}

export interface RunSummary {
	id: string;
	handle?: string;
	/** True for a run that went on after the host's tool call returned. */
	background?: boolean;
	role: string;
	model: string;
	title?: string;
	/** The Pi tool that started the run, the id of that tool call, and the Pi session it was made in. */
	tool?: string;
	toolCallId?: string;
	hostSessionId?: string;
	/** What started the run: the claude tool, or a review the user or this extension asked for. */
	origin?: RunOrigin;
	/** For a review run, the handle of the run it reviews. */
	reviews?: string;
	/** The handle of the latest review run of this run. */
	reviewedBy?: string;
	status: RunStatus;
	/** The open question of a waiting run. */
	question?: string;
	startedAt: number;
	endedAt?: number;
	updatedAt: number;
	/** The last time the child itself reported something, so the browser can tell a quiet run from a stalled one. */
	lastEventAt?: number;
	activity?: string;
	toolCalls: number;
	agentToolCalls: number;
	tokensIn: number;
	tokensOut: number;
	workflowTokens?: number;
	sessionId?: string;
	deniedTools?: string[];
	/** Tool results the child or its subagents got back with is_error set. */
	toolErrors: number;
	/** The SDK's cost estimate for the whole run, subagents and workflow agents included. */
	costUsd?: number;
	/** The prompt size of the main loop's latest model call, and the window it has to fit in. */
	contextTokens?: number;
	contextWindow?: number;
	/** Which of `REPORT_FLAGS` the report has as a heading. */
	reportFlags?: string[];
	/** How many files the run changed, when the working directory is a git work tree. */
	filesChanged?: number;
	/** True for a run of an earlier Pi process, read back from the on-disk history. */
	restored?: true;
}

export interface TaskView {
	id: string;
	toolUseId?: string;
	type?: string;
	name: string;
	subagentType?: string;
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	tokens?: number;
	toolUses?: number;
	lastTool?: string;
	summary?: string;
	phase?: string;
	agents?: Array<{ label: string; state: string }>;
	agentToolCalls: number;
	/** The prompt the child gave the Agent tool call that started this task. */
	prompt?: string;
}

export interface LogEntry {
	/** Counts up from 0 for each run and survives the cap, so the browser can add only the entries it has not seen. */
	seq: number;
	at: number;
	kind: "run" | "tool" | "agent" | "task" | "turn";
	text: string;
	/** Set on a tool call; `api/runs/<run>/calls/<toolUseId>` returns its input and result. */
	toolUseId?: string;
	/** A tool call's state: waiting for its result, or back with or without an error. */
	call?: "pending" | "ok" | "error";
}

/** One tool call's input and, once it is back, its result, each capped in bytes. */
export interface CallView {
	toolUseId: string;
	name: string;
	input: string;
	inputTruncated: boolean;
	result?: string;
	resultTruncated: boolean;
	isError: boolean;
}

/** The Claude Code session a run started in: a new one, a resume of `id`, or a fork of `from`, optionally at a message. */
export interface RunSession {
	kind: "new" | "resume" | "fork";
	id: string;
	from?: string;
	at?: string;
}

export interface RunStart {
	id: string;
	handle?: string;
	/** True for a run that went on after the host's tool call returned. */
	background?: boolean;
	role: string;
	model: string;
	title?: string;
	tool?: string;
	toolCallId?: string;
	hostSessionId?: string;
	origin?: RunOrigin;
	/** For a review run, the handle of the run it reviews. */
	reviews?: string;
	prompt?: string;
	contract?: string;
	session?: RunSession;
}

/** A run of an earlier Pi process, as the on-disk history kept it: enough to list it and read its report. */
export interface RestoredRun {
	id: string;
	handle?: string;
	background?: boolean;
	role: string;
	model: string;
	title?: string;
	tool?: string;
	toolCallId?: string;
	hostSessionId?: string;
	origin?: string;
	reviews?: string;
	reviewedBy?: string;
	/** The state the run ended in: one that was still going when its Pi process ended is restored by nobody. */
	state: string;
	startedAt: number;
	endedAt?: number;
	prompt?: string;
	contract?: string;
	session?: RunSession;
	sessionId?: string;
	report?: string;
	failure?: string;
	files?: ReadonlyArray<ChangedFile>;
	filesTotal?: number;
	usage?: { costUsd?: number; tokensIn?: number; tokensOut?: number; workflowTokens?: number; toolCalls?: number };
}

export interface RunDetail extends RunSummary {
	files?: ChangedFile[];
	filesTruncated: boolean;
	cacheRead: number;
	cacheWrite: number;
	numTurns?: number;
	apiMs?: number;
	modelId?: string;
	models: ModelUsageView[];
	thinking: string[];
	prompt: string;
	promptTruncated: boolean;
	contract?: string;
	session?: RunSession;
	tasks: TaskView[];
	log: LogEntry[];
	text: string;
	textTruncated: boolean;
	failure?: string;
	failureTruncated: boolean;
}

interface StoredRun {
	id: string;
	handle?: string;
	/** True for a run that went on after the host's tool call returned. */
	background?: boolean;
	role: string;
	model: string;
	title?: string;
	tool?: string;
	toolCallId?: string;
	hostSessionId?: string;
	origin?: RunOrigin;
	reviews?: string;
	reviewedBy?: string;
	status: RunStatus;
	question?: string;
	startedAt: number;
	endedAt?: number;
	updatedAt: number;
	lastEventAt?: number;
	activity?: string;
	toolCalls: number;
	agentToolCalls: number;
	toolErrors: number;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd?: number;
	models: ModelUsageView[];
	numTurns?: number;
	apiMs?: number;
	modelId?: string;
	contextTokens?: number;
	contextWindow?: number;
	thinking: string[];
	reportFlags?: string[];
	files?: ChangedFile[];
	filesTotal?: number;
	workflowTokens?: number;
	sessionId?: string;
	deniedTools?: string[];
	restored?: true;
	calls: Map<string, CallView>;
	agentPrompts: Map<string, string>;
	prompt: string;
	promptTruncated: boolean;
	contract?: string;
	session?: RunSession;
	tasks: Map<string, TaskView>;
	log: LogEntry[];
	logSeq: number;
	text: string;
	textTruncated: boolean;
	failure?: string;
	failureTruncated: boolean;
}

export function cap(value: string, max = MAX_STRING_CHARS): string {
	if (value.length <= max) return value;
	const cut = value.slice(0, max);
	const last = cut.charCodeAt(max - 1);
	// Never end on the high half of a surrogate pair: that char is not text any more.
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function capBytes(value: string, max: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= max) return { text: value, truncated: false };
	let end = max;
	// Walk back off the continuation bytes of a code point the cut fell inside of, so nothing decodes to U+FFFD.
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toolNames(names: readonly string[]): string[] {
	return [...new Set(names.map((name) => cap(String(name))))].slice(0, MAX_DENIED_TOOLS);
}

function agentsOf(agents: ReadonlyArray<{ label: string; state: string }>): Array<{ label: string; state: string }> {
	return agents.slice(0, MAX_AGENTS_PER_TASK).map((agent) => ({ label: cap(String(agent?.label ?? "")), state: cap(String(agent?.state ?? "")) }));
}

function summaryOf(run: StoredRun): RunSummary {
	const summary: RunSummary = {
		id: run.id,
		role: run.role,
		model: run.model,
		status: run.status,
		startedAt: run.startedAt,
		updatedAt: run.updatedAt,
		toolCalls: run.toolCalls,
		agentToolCalls: run.agentToolCalls,
		toolErrors: run.toolErrors,
		tokensIn: run.tokensIn,
		tokensOut: run.tokensOut,
	};
	if (run.handle !== undefined) summary.handle = run.handle;
	if (run.background) summary.background = true;
	if (run.question !== undefined) summary.question = run.question;
	if (run.title !== undefined) summary.title = run.title;
	if (run.tool !== undefined) summary.tool = run.tool;
	if (run.toolCallId !== undefined) summary.toolCallId = run.toolCallId;
	if (run.hostSessionId !== undefined) summary.hostSessionId = run.hostSessionId;
	if (run.origin !== undefined) summary.origin = run.origin;
	if (run.reviews !== undefined) summary.reviews = run.reviews;
	if (run.reviewedBy !== undefined) summary.reviewedBy = run.reviewedBy;
	if (run.endedAt !== undefined) summary.endedAt = run.endedAt;
	if (run.lastEventAt !== undefined) summary.lastEventAt = run.lastEventAt;
	if (run.activity !== undefined) summary.activity = run.activity;
	if (run.workflowTokens !== undefined) summary.workflowTokens = run.workflowTokens;
	if (run.sessionId !== undefined) summary.sessionId = run.sessionId;
	if (run.deniedTools !== undefined) summary.deniedTools = [...run.deniedTools];
	if (run.costUsd !== undefined) summary.costUsd = run.costUsd;
	if (run.contextTokens !== undefined) summary.contextTokens = run.contextTokens;
	if (run.contextWindow !== undefined) summary.contextWindow = run.contextWindow;
	if (run.reportFlags !== undefined) summary.reportFlags = [...run.reportFlags];
	if (run.filesTotal !== undefined) summary.filesChanged = run.filesTotal;
	if (run.restored) summary.restored = true;
	return summary;
}

function taskOf(task: TaskView): TaskView {
	const view: TaskView = {
		id: task.id,
		name: task.name,
		status: task.status,
		startedAt: task.startedAt,
		agentToolCalls: task.agentToolCalls,
	};
	if (task.toolUseId !== undefined) view.toolUseId = task.toolUseId;
	if (task.type !== undefined) view.type = task.type;
	if (task.subagentType !== undefined) view.subagentType = task.subagentType;
	if (task.endedAt !== undefined) view.endedAt = task.endedAt;
	if (task.tokens !== undefined) view.tokens = task.tokens;
	if (task.toolUses !== undefined) view.toolUses = task.toolUses;
	if (task.lastTool !== undefined) view.lastTool = task.lastTool;
	if (task.summary !== undefined) view.summary = task.summary;
	if (task.phase !== undefined) view.phase = task.phase;
	if (task.agents !== undefined) view.agents = task.agents.map((agent) => ({ label: agent.label, state: agent.state }));
	if (task.prompt !== undefined) view.prompt = task.prompt;
	return view;
}

function fileOf(file: ChangedFile): ChangedFile {
	const copy: ChangedFile = { path: cap(String(file.path), 1_000), status: cap(String(file.status), 2) };
	const added = num(file.added);
	const removed = num(file.removed);
	if (added !== undefined) copy.added = added;
	if (removed !== undefined) copy.removed = removed;
	return copy;
}

function reportFlagsOf(text: string): string[] {
	const headings = new Set<string>();
	for (const match of text.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) headings.add(match[1]!.trim().toLowerCase());
	return REPORT_FLAGS.filter((flag) => headings.has(flag.toLowerCase()));
}

function modelsOf(models: readonly ModelUsageView[]): ModelUsageView[] {
	return models.slice(0, MAX_MODELS).map((model) => ({
		model: cap(String(model?.model ?? "")),
		inputTokens: num(model?.inputTokens) ?? 0,
		outputTokens: num(model?.outputTokens) ?? 0,
		cacheRead: num(model?.cacheRead) ?? 0,
		cacheWrite: num(model?.cacheWrite) ?? 0,
		costUsd: num(model?.costUsd) ?? 0,
	}));
}

function entryOf(entry: LogEntry): LogEntry {
	const copy: LogEntry = { seq: entry.seq, at: entry.at, kind: entry.kind, text: entry.text };
	if (entry.toolUseId !== undefined) copy.toolUseId = entry.toolUseId;
	if (entry.call !== undefined) copy.call = entry.call;
	return copy;
}

function inputText(input: unknown): string {
	if (input === undefined) return "";
	if (typeof input === "string") return input;
	try {
		return JSON.stringify(input, null, 2) ?? "";
	} catch {
		return String(input);
	}
}

function promptOf(input: unknown): string | undefined {
	const prompt = input && typeof input === "object" ? (input as Record<string, unknown>).prompt : undefined;
	return typeof prompt === "string" ? capBytes(prompt, TASK_PROMPT_CAP_BYTES).text : undefined;
}

function sessionOf(session: RunSession): RunSession {
	const copy: RunSession = { kind: session.kind, id: cap(String(session.id)) };
	if (session.from !== undefined) copy.from = cap(String(session.from));
	if (session.at !== undefined) copy.at = cap(String(session.at));
	return copy;
}

/**
 * Every delegated run of this Pi session, in memory and bounded: the browser reads it, nothing writes back. It holds
 * the prompt each child was given and what the child reported through `ChildRun` and `ChildEvent`. The failure message
 * can carry the last lines of the child's stderr, as Pi's tool result does.
 */
export class RunStore {
	private readonly runs = new Map<string, StoredRun>();
	private readonly clock: () => number;

	constructor(now: () => number = Date.now) {
		this.clock = now;
	}

	start(input: RunStart): void {
		const id = cap(String(input.id));
		const at = this.clock();
		const run: StoredRun = {
			id,
			role: cap(String(input.role)),
			model: cap(String(input.model)),
			status: "running",
			startedAt: at,
			updatedAt: at,
			toolCalls: 0,
			agentToolCalls: 0,
			toolErrors: 0,
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheWrite: 0,
			models: [],
			thinking: [],
			calls: new Map(),
			agentPrompts: new Map(),
			prompt: "",
			promptTruncated: false,
			tasks: new Map(),
			log: [],
			logSeq: 0,
			text: "",
			textTruncated: false,
			failureTruncated: false,
		};
		if (input.handle !== undefined) run.handle = cap(String(input.handle));
		if (input.background === true) run.background = true;
		if (input.title !== undefined) run.title = cap(String(input.title));
		if (input.tool !== undefined) run.tool = cap(String(input.tool));
		if (input.toolCallId !== undefined) run.toolCallId = cap(String(input.toolCallId));
		if (input.hostSessionId !== undefined) run.hostSessionId = cap(String(input.hostSessionId));
		if (input.origin !== undefined) run.origin = input.origin;
		if (input.reviews !== undefined) run.reviews = cap(String(input.reviews));
		if (input.prompt !== undefined) {
			const prompt = capBytes(String(input.prompt), PROMPT_CAP_BYTES);
			run.prompt = prompt.text;
			run.promptTruncated = prompt.truncated;
		}
		if (input.contract !== undefined) run.contract = cap(String(input.contract));
		if (input.session !== undefined) run.session = sessionOf(input.session);
		this.runs.set(id, run);
		this.evict();
	}

	/**
	 * Adds a run of an earlier Pi process, read back from the on-disk history, and says whether it went in. It is
	 * never live: a record that was still running or waiting when its process ended is refused, and so is an id this
	 * session already holds, because what this session knows about a run is newer than what the file does.
	 */
	restore(input: RestoredRun): boolean {
		const status = cap(String(input.state));
		if (!ENDED_STATUSES.has(status)) return false;
		const id = cap(String(input.id));
		if (this.runs.has(id)) return false;
		const startedAt = num(input.startedAt) ?? this.clock();
		const endedAt = num(input.endedAt);
		const usage = input.usage ?? {};
		const text = capBytes(String(input.report ?? ""), TEXT_CAP_BYTES);
		const run: StoredRun = {
			id,
			role: cap(String(input.role)),
			model: cap(String(input.model)),
			status: status as RunStatus,
			restored: true,
			startedAt,
			updatedAt: endedAt ?? startedAt,
			toolCalls: num(usage.toolCalls) ?? 0,
			agentToolCalls: 0,
			toolErrors: 0,
			tokensIn: num(usage.tokensIn) ?? 0,
			tokensOut: num(usage.tokensOut) ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			models: [],
			thinking: [],
			calls: new Map(),
			agentPrompts: new Map(),
			prompt: "",
			promptTruncated: false,
			tasks: new Map(),
			log: [],
			logSeq: 0,
			text: text.text,
			textTruncated: text.truncated,
			failureTruncated: false,
		};
		if (endedAt !== undefined) run.endedAt = endedAt;
		if (input.handle !== undefined) run.handle = cap(String(input.handle));
		if (input.background === true) run.background = true;
		if (input.title !== undefined) run.title = cap(String(input.title));
		if (input.tool !== undefined) run.tool = cap(String(input.tool));
		if (input.toolCallId !== undefined) run.toolCallId = cap(String(input.toolCallId));
		if (input.hostSessionId !== undefined) run.hostSessionId = cap(String(input.hostSessionId));
		if (input.origin !== undefined && ORIGINS.has(input.origin)) run.origin = input.origin as RunOrigin;
		if (input.reviews !== undefined) run.reviews = cap(String(input.reviews));
		if (input.reviewedBy !== undefined) run.reviewedBy = cap(String(input.reviewedBy));
		if (input.prompt !== undefined) {
			const prompt = capBytes(String(input.prompt), PROMPT_CAP_BYTES);
			run.prompt = prompt.text;
			run.promptTruncated = prompt.truncated;
		}
		if (input.contract !== undefined) run.contract = cap(String(input.contract));
		if (input.session !== undefined) run.session = sessionOf(input.session);
		if (input.sessionId !== undefined) run.sessionId = cap(String(input.sessionId));
		if (input.failure !== undefined) {
			const failure = capBytes(String(input.failure), FAILURE_CAP_BYTES);
			run.failure = failure.text;
			run.failureTruncated = failure.truncated;
		}
		if (input.files !== undefined) {
			run.files = input.files.slice(0, MAX_FILES).map(fileOf);
			run.filesTotal = num(input.filesTotal) ?? input.files.length;
		} else {
			const filesTotal = num(input.filesTotal);
			if (filesTotal !== undefined) run.filesTotal = filesTotal;
		}
		const costUsd = num(usage.costUsd);
		if (costUsd !== undefined) run.costUsd = costUsd;
		const workflowTokens = num(usage.workflowTokens);
		if (workflowTokens !== undefined) run.workflowTokens = workflowTokens;
		const flags = reportFlagsOf(run.text);
		if (flags.length) run.reportFlags = flags;
		this.runs.set(id, run);
		this.evict();
		return true;
	}

	progress(id: string, snapshot: RunProgress): void {
		const run = this.runs.get(cap(String(id)));
		if (!run) return;
		this.apply(run, snapshot);
		this.mark(run);
	}

	event(id: string, event: ChildEvent): void {
		const run = this.runs.get(cap(String(id)));
		if (!run) return;
		const at = this.clock();
		if (event.type === "init") {
			run.sessionId = cap(String(event.sessionId));
			this.record(run, at, "run", `session ${run.sessionId}`);
		} else if (event.type === "tool_call") {
			const name = cap(String(event.name));
			const brief = cap(String(event.brief ?? ""));
			const entry = this.record(run, at, "tool", brief ? `${name} ${brief}` : name);
			this.call(run, entry, event.id, name, event.input);
			const prompt = event.id !== undefined && AGENT_TOOLS.has(name) ? promptOf(event.input) : undefined;
			if (prompt !== undefined) {
				const toolUseId = cap(String(event.id));
				run.agentPrompts.set(toolUseId, prompt);
				const task = this.byToolUse(run, toolUseId);
				if (task) task.prompt = prompt;
			}
		} else if (event.type === "agent_tool_call") {
			run.agentToolCalls++;
			const parentToolUseId = cap(String(event.parentToolUseId));
			const task = this.byToolUse(run, parentToolUseId);
			if (task) task.agentToolCalls++;
			const name = cap(String(event.name));
			const entry = this.record(run, at, "agent", `${name} in ${task ? task.name : parentToolUseId}`);
			this.call(run, entry, event.id, name, event.input);
		} else if (event.type === "tool_result") {
			const toolUseId = cap(String(event.toolUseId));
			const isError = event.isError === true;
			if (isError) run.toolErrors++;
			const call = run.calls.get(toolUseId);
			if (call) {
				const result = capBytes(String(event.text ?? ""), CALL_CAP_BYTES);
				call.result = result.text;
				call.resultTruncated = result.truncated;
				call.isError = isError;
			}
			const entry = run.log.find((candidate) => candidate.toolUseId === toolUseId);
			if (entry) entry.call = isError ? "error" : "ok";
		} else if (event.type === "task_started") {
			const taskId = cap(String(event.taskId));
			const name = cap(String(event.name || taskId));
			const task = this.task(run, taskId, name, at);
			if (task) {
				task.name = name;
				if (event.toolUseId !== undefined) task.toolUseId = cap(String(event.toolUseId));
				if (event.taskType !== undefined) task.type = cap(String(event.taskType));
				if (event.subagentType !== undefined) task.subagentType = cap(String(event.subagentType));
				const prompt = task.toolUseId === undefined ? undefined : run.agentPrompts.get(task.toolUseId);
				if (prompt !== undefined) task.prompt = prompt;
			}
			this.record(run, at, "task", `${name} started`);
		} else if (event.type === "task_progress") {
			const taskId = cap(String(event.taskId));
			const task = this.task(run, taskId, cap(String(event.description || taskId)), at);
			if (task) {
				const tokens = num(event.tokens);
				if (tokens !== undefined) task.tokens = tokens;
				const toolUses = num(event.toolUses);
				if (toolUses !== undefined) task.toolUses = toolUses;
				if (event.lastTool !== undefined) task.lastTool = cap(String(event.lastTool));
				if (event.summary !== undefined) task.summary = cap(String(event.summary));
				if (event.phase !== undefined) task.phase = cap(String(event.phase));
				if (Array.isArray(event.agents)) task.agents = agentsOf(event.agents);
			}
		} else if (event.type === "task_ended") {
			const taskId = cap(String(event.taskId));
			const task = this.task(run, taskId, taskId, at);
			const summary = event.summary === undefined ? undefined : cap(String(event.summary));
			if (task) {
				task.status = event.status;
				task.endedAt = at;
				if (summary !== undefined) task.summary = summary;
				const tokens = num(event.tokens);
				if (tokens !== undefined) task.tokens = tokens;
			}
			const name = task ? task.name : taskId;
			this.record(run, at, "task", summary ? `${name} ${event.status}: ${summary}` : `${name} ${event.status}`);
		} else if (event.type === "turn_result") {
			const message = event.message === undefined ? "" : cap(String(event.message));
			this.record(run, at, "turn", event.ok ? "turn ended" : message ? `turn failed: ${message}` : "turn failed");
		}
		this.mark(run);
	}

	/** Names the review run a source run got. A second review replaces the first, as the run's own link does. */
	reviewed(id: string, handle: string): void {
		const run = this.runs.get(cap(String(id)));
		if (!run) return;
		run.reviewedBy = cap(String(handle));
		run.updatedAt = this.clock();
	}

	/** A question opens or, with undefined, is answered. A foreground run that asks goes on in the background. */
	question(id: string, text: string | undefined): void {
		const run = this.runs.get(cap(String(id)));
		if (!run) return;
		const at = this.clock();
		if (text === undefined) {
			delete run.question;
			run.status = "running";
			this.record(run, at, "run", "answered");
		} else {
			run.question = capBytes(String(text), FAILURE_CAP_BYTES).text;
			run.status = "waiting";
			run.background = true;
			this.record(run, at, "run", `question: ${run.question}`);
		}
		this.mark(run);
	}

	finish(
		id: string,
		outcome: { status: Exclude<RunStatus, "running" | "waiting">; text?: string; failure?: string; snapshot?: RunProgress; files?: readonly ChangedFile[] },
	): void {
		const run = this.runs.get(cap(String(id)));
		if (!run) return;
		const at = this.clock();
		run.status = outcome.status;
		run.endedAt = at;
		delete run.question;
		if (outcome.snapshot) this.apply(run, outcome.snapshot);
		const text = capBytes(String(outcome.text ?? ""), TEXT_CAP_BYTES);
		run.text = text.text;
		run.textTruncated = text.truncated;
		const flags = reportFlagsOf(run.text);
		if (flags.length) run.reportFlags = flags;
		if (Array.isArray(outcome.files)) {
			run.filesTotal = outcome.files.length;
			run.files = outcome.files.slice(0, MAX_FILES).map(fileOf);
		}
		if (outcome.failure !== undefined) {
			const failure = capBytes(String(outcome.failure), FAILURE_CAP_BYTES);
			run.failure = failure.text;
			run.failureTruncated = failure.truncated;
		}
		let stopped = 0;
		for (const task of run.tasks.values()) {
			if (task.status !== "running") continue;
			task.status = "stopped";
			task.endedAt = at;
			stopped++;
		}
		if (stopped > 0) this.record(run, at, "task", `${stopped} task${stopped === 1 ? "" : "s"} stopped with the run`);
		this.record(run, at, "run", run.failure ? `${outcome.status}: ${run.failure}` : outcome.status);
		this.mark(run);
	}

	summaries(): RunSummary[] {
		return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).map(summaryOf);
	}

	detail(id: string): RunDetail | undefined {
		const run = this.runs.get(cap(String(id)));
		if (!run) return undefined;
		const detail: RunDetail = {
			...summaryOf(run),
			filesTruncated: run.files !== undefined && run.filesTotal !== undefined && run.files.length < run.filesTotal,
			cacheRead: run.cacheRead,
			cacheWrite: run.cacheWrite,
			models: run.models.map((model) => ({ ...model })),
			thinking: [...run.thinking],
			prompt: run.prompt,
			promptTruncated: run.promptTruncated,
			tasks: [...run.tasks.values()].map(taskOf),
			log: run.log.map(entryOf),
			text: run.text,
			textTruncated: run.textTruncated,
			failureTruncated: run.failureTruncated,
		};
		if (run.failure !== undefined) detail.failure = run.failure;
		if (run.contract !== undefined) detail.contract = run.contract;
		if (run.session !== undefined) detail.session = sessionOf(run.session);
		if (run.numTurns !== undefined) detail.numTurns = run.numTurns;
		if (run.apiMs !== undefined) detail.apiMs = run.apiMs;
		if (run.modelId !== undefined) detail.modelId = run.modelId;
		if (run.files !== undefined) detail.files = run.files.map((file) => ({ ...file }));
		return detail;
	}

	/** A tool call's input and result, for as long as its log entry is kept. */
	callDetail(runId: string, toolUseId: string): CallView | undefined {
		const call = this.runs.get(cap(String(runId)))?.calls.get(cap(String(toolUseId)));
		if (!call) return undefined;
		const view: CallView = { toolUseId: call.toolUseId, name: call.name, input: call.input, inputTruncated: call.inputTruncated, resultTruncated: call.resultTruncated, isError: call.isError };
		if (call.result !== undefined) view.result = call.result;
		return view;
	}

	private call(run: StoredRun, entry: LogEntry, id: string | undefined, name: string, input: unknown): void {
		if (id === undefined) return;
		const toolUseId = cap(String(id));
		const text = capBytes(inputText(input), CALL_CAP_BYTES);
		entry.toolUseId = toolUseId;
		entry.call = "pending";
		run.calls.set(toolUseId, { toolUseId, name, input: text.text, inputTruncated: text.truncated, resultTruncated: false, isError: false });
	}

	private apply(run: StoredRun, snapshot: RunProgress): void {
		if (snapshot.activity !== undefined) run.activity = cap(String(snapshot.activity));
		const toolCalls = num(snapshot.toolCalls);
		if (toolCalls !== undefined) run.toolCalls = toolCalls;
		const tokensIn = num(snapshot.tokensIn);
		if (tokensIn !== undefined) run.tokensIn = tokensIn;
		const tokensOut = num(snapshot.tokensOut);
		if (tokensOut !== undefined) run.tokensOut = tokensOut;
		const cacheRead = num(snapshot.cacheRead);
		if (cacheRead !== undefined) run.cacheRead = cacheRead;
		const cacheWrite = num(snapshot.cacheWrite);
		if (cacheWrite !== undefined) run.cacheWrite = cacheWrite;
		const costUsd = num(snapshot.costUsd);
		if (costUsd !== undefined) run.costUsd = costUsd;
		const numTurns = num(snapshot.numTurns);
		if (numTurns !== undefined) run.numTurns = numTurns;
		const apiMs = num(snapshot.apiMs);
		if (apiMs !== undefined) run.apiMs = apiMs;
		const contextTokens = num(snapshot.contextTokens);
		if (contextTokens !== undefined) run.contextTokens = contextTokens;
		const contextWindow = num(snapshot.contextWindow);
		if (contextWindow !== undefined) run.contextWindow = contextWindow;
		if (snapshot.modelId !== undefined) run.modelId = cap(String(snapshot.modelId));
		if (Array.isArray(snapshot.models)) run.models = modelsOf(snapshot.models);
		if (Array.isArray(snapshot.thinking)) run.thinking = snapshot.thinking.slice(-MAX_THINKING_BLOCKS).map((text) => capBytes(String(text), THINKING_CAP_BYTES).text);
		const workflowTokens = num(snapshot.workflowTokens);
		if (workflowTokens !== undefined) run.workflowTokens = workflowTokens;
		if (snapshot.sessionId !== undefined) run.sessionId = cap(String(snapshot.sessionId));
		if (Array.isArray(snapshot.deniedTools)) run.deniedTools = toolNames(snapshot.deniedTools);
	}

	private task(run: StoredRun, id: string, name: string, at: number): TaskView | undefined {
		const existing = run.tasks.get(id);
		if (existing) return existing;
		if (run.tasks.size >= MAX_TASKS_PER_RUN) return undefined;
		const task: TaskView = { id, name, status: "running", startedAt: at, agentToolCalls: 0 };
		run.tasks.set(id, task);
		return task;
	}

	private byToolUse(run: StoredRun, toolUseId: string): TaskView | undefined {
		for (const task of run.tasks.values()) if (task.toolUseId === toolUseId) return task;
		return undefined;
	}

	private record(run: StoredRun, at: number, kind: LogEntry["kind"], text: string): LogEntry {
		const entry: LogEntry = { seq: run.logSeq++, at, kind, text: cap(text) };
		run.log.push(entry);
		if (run.log.length > MAX_LOG_PER_RUN) {
			for (const dropped of run.log.splice(0, run.log.length - MAX_LOG_PER_RUN)) {
				if (dropped.toolUseId === undefined) continue;
				run.calls.delete(dropped.toolUseId);
				run.agentPrompts.delete(dropped.toolUseId);
			}
		}
		return entry;
	}

	private mark(run: StoredRun): void {
		run.updatedAt = this.clock();
		run.lastEventAt = run.updatedAt;
	}

	private evict(): void {
		for (const [id, run] of this.runs) {
			if (this.runs.size <= MAX_RUNS) return;
			if (run.status !== "running" && run.status !== "waiting") this.runs.delete(id);
		}
	}
}

const CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
const SECURITY_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": CSP,
};
const HTML_TYPE = "text/html; charset=utf-8";
const JS_TYPE = "text/javascript; charset=utf-8";
const CSS_TYPE = "text/css; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";
const MAX_URL_CHARS = 2048;
const REQUEST_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 5_000;
const TOKEN_BYTES = 24;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DETAIL_PREFIX = "api/runs/";
const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dashboard");

interface Reply {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}

interface Assets {
	html: Buffer;
	js: Buffer;
	css: Buffer;
}

export interface Dashboard {
	url: string;
	port: number;
	close(): Promise<void>;
}

/** What the page shows about this Pi session's spend: the totals so far and the thresholds the user configured. */
export type UsageView = UsageTotals & { warnUsd: number[]; limitUsd?: number };

function reply(status: number, type: string, body: Buffer, extra?: Record<string, string>): Reply {
	return { status, headers: { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": String(body.byteLength), ...extra }, body };
}

function plain(status: number, message: string, extra?: Record<string, string>): Reply {
	return reply(status, TEXT_TYPE, Buffer.from(`${message}\n`, "utf8"), extra);
}

function notFound(): Reply {
	return plain(404, "Not found");
}

function jsonReply(value: unknown): Reply {
	return reply(200, JSON_TYPE, Buffer.from(JSON.stringify(value), "utf8"));
}

function readAsset(name: string): Buffer {
	try {
		return fs.readFileSync(path.join(ASSET_DIR, name));
	} catch {
		throw new Error(`dashboard asset missing: ${name}`);
	}
}

function sameToken(candidate: string, token: string): boolean {
	const given = Buffer.from(candidate, "utf8");
	const want = Buffer.from(token, "utf8");
	return given.byteLength === want.byteLength && timingSafeEqual(given, want);
}

/**
 * Serves `store` read-only over HTTP on 127.0.0.1. The random token in the URL is the only credential, so the URL is
 * the secret: it is never put in a response body or logged. The assets are read once here and never at request time.
 */
export function startDashboard(store: RunStore, opts: { cwd: string; port?: number; usage?: () => UsageView }): Promise<Dashboard> {
	return new Promise<Dashboard>((resolve, reject) => {
		let assets: Assets;
		try {
			assets = { html: readAsset("index.html"), js: readAsset("app.js"), css: readAsset("app.css") };
		} catch (error) {
			reject(error);
			return;
		}
		const token = randomBytes(TOKEN_BYTES).toString("base64url");
		const cwd = String(opts.cwd);
		const usage = opts.usage;
		let port = 0;

		const route = (method: string, url: string, host: string | undefined, origin: string | undefined): Reply => {
			if (method !== "GET" && method !== "HEAD") return plain(405, "Method not allowed", { Allow: "GET, HEAD" });
			if (url.length > MAX_URL_CHARS) return plain(414, "URI too long");
			if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return plain(400, "Bad request");
			if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return plain(403, "Forbidden");
			const segments = (url.split("?", 1)[0] ?? "").split("/");
			if (!sameToken(segments[1] ?? "", token)) return notFound();
			if (segments.length === 2) return plain(301, "Moved", { Location: `/${token}/` });
			const rest = segments.slice(2).join("/");
			if (rest === "" || rest === "index.html") return reply(200, HTML_TYPE, assets.html);
			if (rest === "app.js") return reply(200, JS_TYPE, assets.js);
			if (rest === "app.css") return reply(200, CSS_TYPE, assets.css);
			if (rest === "api/runs") return jsonReply({ cwd, runs: store.summaries(), ...(usage ? { usage: usage() } : {}) });
			if (rest.startsWith(DETAIL_PREFIX)) {
				const parts = rest.slice(DETAIL_PREFIX.length).split("/");
				const id = parts[0] ?? "";
				if (!RUN_ID.test(id)) return notFound();
				if (parts.length === 1) {
					const detail = store.detail(id);
					return detail ? jsonReply(detail) : notFound();
				}
				if (parts.length === 3 && parts[1] === "calls" && TOOL_USE_ID.test(parts[2] ?? "")) {
					const call = store.callDetail(id, parts[2]!);
					return call ? jsonReply(call) : notFound();
				}
				return notFound();
			}
			return notFound();
		};

		const server = createServer((req, res) => {
			let answer: Reply;
			try {
				answer = route(req.method ?? "", req.url ?? "", req.headers.host, req.headers.origin);
			} catch {
				answer = plain(500, "Internal error");
			}
			try {
				res.writeHead(answer.status, answer.headers);
				if (req.method === "HEAD") res.end();
				else res.end(answer.body);
			} catch {
				res.destroy();
			}
		});
		server.requestTimeout = REQUEST_TIMEOUT_MS;
		server.headersTimeout = HEADERS_TIMEOUT_MS;
		server.on("connection", (socket) => socket.unref());
		server.unref();

		let closing: Promise<void> | undefined;
		const close = (): Promise<void> => {
			closing ??= new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			});
			return closing;
		};

		const fail = (error: Error): void => {
			void close();
			reject(error);
		};
		server.once("error", fail);
		server.listen(opts.port ?? 0, "127.0.0.1", () => {
			server.removeListener("error", fail);
			// A later accept error must not become an unhandled event and take the Pi session down with it.
			server.on("error", () => {});
			const address = server.address();
			port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ url: `http://127.0.0.1:${port}/${token}/`, port, close });
		});
	});
}
