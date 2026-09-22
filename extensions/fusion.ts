import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createSdkMcpServer,
	type EffortLevel,
	type HookCallback,
	type Options,
	type PermissionMode,
	query,
	type SDKUserMessage,
	type Settings,
	type SpawnedProcess,
	type SpawnOptions,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { z } from "zod";
import { budgetConfig, budgetProblems, type CallUsage, Ledger } from "./budget.ts";
import { bodyLines, Card, CARD_FILES, CARD_QUESTION_CHARS, type CardDetails, cardDetails, type CardMode, type CardTheme, headerLine, plainText, resultText, type WidgetRun, widgetLines } from "./cards.ts";
import { type ChangedFile, changedFiles, type Snapshot, snapshot } from "./changes.ts";
import { type Dashboard, RunStore, startDashboard } from "./dashboard.ts";
import { contextShare, continueNote, handoffBlocked, handoffNote, handoffPrompt, handoffShare, planContextPct, planProblems, sharePercent } from "./handoff.ts";
import { History, type HistoryRecord, historyDir, historyEnabled } from "./history.ts";
import { reviewable, reviewPrompt } from "./review.ts";

const KILL_GRACE_MS = 5_000;
const EXIT_GRACE_MS = 2_000;
const CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "contracts");
const SESSION_ENTRY = "pi-fusion";
const ACTIVITY_CHARS = 60;
const WORKFLOW_LABEL_CHARS = 200;
const MAX_WORKFLOW_AGENTS = 200;
const DELTA_PROGRESS_MS = 250;
const THINKING_BLOCKS = 5;
const THINKING_CHARS = 8_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const LONG_CONTEXT_WINDOW = 1_000_000;
const TICK_MS = 1_000;
/** How often a running run's changed-file count is sampled: a git call per second per run is too many. */
const FILE_SAMPLE_MS = 10_000;
const QUESTION_SERVER = "pi-fusion";
export const QUESTION_TOOL = "ask_orchestrator";
/** The largest MCP tool-call timeout Claude Code accepts, in ms: a question has no time limit. */
const QUESTION_TIMEOUT_MS = 2_147_483_647;
/** A callback hook's timeout, in seconds, kept under Node's 2,147,483,647 ms timer limit. */
const HOOK_TIMEOUT_S = 2_147_483;

const env = (key: string, fallback: string): string => process.env[key]?.trim() || fallback;

const sleep = (ms: number): Promise<undefined> =>
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		timer.unref();
	});

/** A role run as a headless Claude Code session in the host's working directory. */
export interface Role {
	name: string;
	model: string;
	/** A Claude Code effort level, or `ultracode`: xhigh plus the standing Workflow opt-in. */
	effort: string;
	/**
	 * The built-in tools the child gets, and nothing else: no MCP servers. Undefined gives it Claude Code's
	 * full tool set and the user's MCP servers.
	 */
	tools?: string[];
	permissionMode: string;
	contract: string;
	/** The ask role's mode, which picks its contract. */
	mode?: AskMode;
}

export const ROLE_NAMES = ["plan", "implement", "ultracode", "ask"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

const ROLES: Record<RoleName, Role> = {
	plan: {
		name: "plan",
		model: env("PI_FUSION_PLAN_MODEL", "fable"),
		effort: "xhigh",
		tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
		permissionMode: "bypassPermissions",
		contract: "plan.md",
	},
	implement: {
		name: "implement",
		model: env("PI_FUSION_IMPLEMENT_MODEL", "opus"),
		effort: env("PI_FUSION_IMPLEMENT_EFFORT", "high"),
		tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
		permissionMode: "bypassPermissions",
		contract: "implement.md",
	},
	ultracode: {
		name: "ultracode",
		model: env("PI_FUSION_ULTRACODE_MODEL", "fable"),
		effort: "ultracode",
		permissionMode: env("PI_FUSION_ULTRACODE_PERMISSION_MODE", "bypassPermissions"),
		contract: "ultracode.md",
	},
	ask: {
		name: "ask",
		model: env("PI_FUSION_ASK_MODEL", "opus"),
		effort: env("PI_FUSION_ASK_EFFORT", "high"),
		tools: ["Read", "Bash", "Grep", "Glob", "WebSearch", "WebFetch"],
		permissionMode: "bypassPermissions",
		contract: "ask-answer.md",
	},
};

export const ASK_MODES = ["answer", "review"] as const;
export type AskMode = (typeof ASK_MODES)[number];
const ASK_CONTRACTS: Record<AskMode, string> = { answer: "ask-answer.md", review: "ask-review.md" };

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The claude parameters only some roles take. `ultracode` takes no effort, because any other level turns its workflows off. */
const ROLE_PARAMETERS: Record<"fresh" | "mode" | "model" | "effort", readonly RoleName[]> = {
	fresh: ["plan"],
	mode: ["ask"],
	model: ["implement", "ask"],
	effort: ["plan", "implement", "ask"],
};

export interface ClaudeParams {
	role?: string;
	task: string;
	context?: string;
	continue?: string;
	fresh?: boolean;
	background?: boolean;
	mode?: string;
	model?: string;
	effort?: string;
}

/** The role a claude call runs, with the call's model and effort. Throws on a role or parameter the call cannot use. */
export function roleFor(params: ClaudeParams & { role: string }): Role {
	if (!(ROLE_NAMES as readonly string[]).includes(params.role)) throw new Error(`unknown role ${params.role}; use one of ${ROLE_NAMES.join(", ")}`);
	const name = params.role as RoleName;
	for (const [parameter, roles] of Object.entries(ROLE_PARAMETERS)) {
		if (params[parameter as keyof ClaudeParams] !== undefined && !roles.includes(name)) throw new Error(`${parameter} is not allowed for role ${name}`);
	}
	if (params.effort !== undefined && !(EFFORTS as readonly string[]).includes(params.effort)) {
		throw new Error(`unknown effort ${params.effort}; use one of ${EFFORTS.join(", ")}`);
	}
	if (params.mode !== undefined && !(ASK_MODES as readonly string[]).includes(params.mode)) {
		throw new Error(`unknown mode ${params.mode}; use one of ${ASK_MODES.join(", ")}`);
	}
	const model = params.model?.trim();
	const mode = (params.mode ?? "answer") as AskMode;
	return {
		...ROLES[name],
		...(model ? { model } : {}),
		...(params.effort ? { effort: params.effort } : {}),
		...(name === "ask" ? { mode, contract: ASK_CONTRACTS[mode] } : {}),
	};
}

/**
 * The Claude Code session a child runs in. Every id is a UUID that `claude --resume` accepts. `at` is the uuid of
 * an assistant message in the session; a resume or fork at it continues from that message on a new branch of the
 * transcript, leaving anything after it in the file but out of context.
 */
export type ChildSession =
	| { kind: "new"; id: string }
	| { kind: "resume"; id: string; at?: string }
	| { kind: "fork"; id: string; from: string; at?: string };

/** What the host session records about a run: the last entry for a handle on the host's branch wins. */
export interface RunRecord {
	handle: string;
	role: RoleName;
	/** An ask run's mode, which a continue keeps unless it names another. */
	mode?: AskMode;
	sessionId?: string;
	hostSessionId?: string;
	/** The last assistant message of the last successful call on this host branch. */
	checkpoint?: string;
	/** The prompt size of that call's last model turn, and the window it filled, so a plan call can weigh continuing it. */
	contextTokens?: number;
	contextWindow?: number;
}

export interface RunRecords {
	runs: Map<string, RunRecord>;
	/** The handle of the plan run that a plan call without continue or fresh continues. */
	lastPlan?: string;
	highest: number;
}

const HANDLE = /^run-([1-9]\d*)$/;

/**
 * Entries written before handles existed carry only the plan session, under the consolidator keys. Generation g
 * reads as handle run-(g+1), so each fresh plan session keeps a handle of its own.
 */
function recordOf(data: Record<string, unknown>): RunRecord | undefined {
	const hostSessionId = typeof data.hostSessionId === "string" ? { hostSessionId: data.hostSessionId } : {};
	if (typeof data.run === "string") {
		if (!HANDLE.test(data.run) || !(ROLE_NAMES as readonly unknown[]).includes(data.role)) return undefined;
		return {
			handle: data.run,
			role: data.role as RoleName,
			...((ASK_MODES as readonly unknown[]).includes(data.mode) ? { mode: data.mode as AskMode } : {}),
			...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
			...hostSessionId,
			...(typeof data.checkpoint === "string" ? { checkpoint: data.checkpoint } : {}),
			...(typeof data.contextTokens === "number" ? { contextTokens: data.contextTokens } : {}),
			...(typeof data.contextWindow === "number" ? { contextWindow: data.contextWindow } : {}),
		};
	}
	if (typeof data.consolidatorGeneration !== "number") return undefined;
	return {
		handle: `run-${data.consolidatorGeneration + 1}`,
		role: "plan",
		...(typeof data.consolidatorSessionId === "string" ? { sessionId: data.consolidatorSessionId } : {}),
		...hostSessionId,
		...(typeof data.consolidatorCheckpoint === "string" ? { checkpoint: data.consolidatorCheckpoint } : {}),
	};
}

export function runRecords(branch: readonly unknown[]): RunRecords {
	const records: RunRecords = { runs: new Map(), highest: 0 };
	for (const entry of branch) {
		const candidate = entry as { type?: string; customType?: string; data?: Record<string, unknown> };
		if (candidate?.type !== "custom" || candidate.customType !== SESSION_ENTRY) continue;
		const record = recordOf(candidate.data ?? {});
		if (!record) continue;
		records.runs.set(record.handle, record);
		records.highest = Math.max(records.highest, handleNumber(record.handle));
		if (record.role === "plan") records.lastPlan = record.handle;
	}
	return records;
}

/**
 * A recorded session continues in the host session that recorded it, from the recorded checkpoint, so a host that
 * went back with /tree takes the run back with it. Any other host session, which is what a fork of that host is,
 * gets its own fork of it from that checkpoint, so the two hosts stop sharing its context from there on.
 */
export function nextSession(record: RunRecord | undefined, hostSessionId: string): ChildSession {
	if (!record?.sessionId) return { kind: "new", id: randomUUID() };
	const at = record.checkpoint ? { at: record.checkpoint } : {};
	if (record.hostSessionId !== hostSessionId) return { kind: "fork", id: randomUUID(), from: record.sessionId, ...at };
	return { kind: "resume", id: record.sessionId, ...at };
}

/** A plan call that started a fresh run rather than continue one whose context had grown past the cap. */
export interface Handoff {
	from: string;
	share: number;
}

/** The run a claude call starts or continues. Throws on a handle, role or parameter the call cannot use. */
export function claudeCall(
	params: ClaudeParams,
	records: RunRecords,
	planPct: number = planContextPct(),
): { role: Role; handle: string; record?: RunRecord; handoff?: Handoff } {
	if (params.continue !== undefined) {
		if (params.fresh !== undefined) throw new Error("fresh is not allowed with continue");
		const record = records.runs.get(params.continue);
		if (!record) {
			const known = [...records.runs.keys()];
			throw new Error(`unknown run ${params.continue}; the runs on this branch are ${known.length ? known.join(", ") : "none"}`);
		}
		if (params.role !== undefined && params.role !== record.role) throw new Error(`${record.handle} has role ${record.role}; omit role or use ${record.role}`);
		const mode = params.mode ?? record.mode;
		return { role: roleFor({ ...params, role: record.role, ...(mode ? { mode } : {}) }), handle: record.handle, record };
	}
	if (params.role === undefined) throw new Error("role is required unless continue is set");
	const role = roleFor({ ...params, role: params.role });
	const last = params.role === "plan" && params.fresh !== true && records.lastPlan ? records.runs.get(records.lastPlan) : undefined;
	const next = `run-${records.highest + 1}`;
	if (!last) return { role, handle: next };
	const share = handoffShare(last, planPct);
	if (share === undefined) return { role, handle: last.handle, record: last };
	return { role, handle: next, handoff: { from: last.handle, share } };
}

/** One model's share of a run, from the SDK result's `modelUsage`: the main loop, subagents and workflow agents. */
export interface ModelCost {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	contextWindow?: number;
}

export interface ChildRun {
	role: Role;
	text: string;
	toolCalls: number;
	activity?: string;
	tokensIn: number;
	tokensOut: number;
	/** The main loop's cache reads and writes; `tokensIn` already counts them. */
	cacheRead: number;
	cacheWrite: number;
	/** The SDK's running estimate for the whole query, subagents and workflow agents included. */
	costUsd?: number;
	models?: ModelCost[];
	numTurns?: number;
	apiMs?: number;
	/** The model id Claude Code reported at init, for example `claude-fable-5-1[1m]`. */
	modelId?: string;
	/** The prompt size of the main loop's latest model call: its input plus cache reads and writes. */
	contextTokens?: number;
	contextWindow?: number;
	/** The main loop's latest thinking blocks, oldest first. */
	thinking?: string[];
	workflowTokens?: number;
	deniedTools?: string[];
	/** Background tasks the child still had running when it exited on its own. */
	abandonedTasks?: string[];
	sessionId?: string;
	/** The uuid of the child's last top-level assistant message, where a later call can resume or fork. */
	checkpoint?: string;
	ms: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
}

/** Unset, the SDK runs the Claude Code binary it bundles. A `.js`, `.mjs` or `.cjs` path runs under node. */
export function claudeExecutable(): Pick<Options, "pathToClaudeCodeExecutable" | "executable"> {
	const bin = process.env.PI_FUSION_CLAUDE_BIN?.trim();
	if (!bin) return {};
	if (/\.(js|mjs|cjs)$/i.test(bin)) return { pathToClaudeCodeExecutable: bin, executable: "node" };
	return { pathToClaudeCodeExecutable: bin };
}

/** The SDK's typed effort levels stop at max; `ultracode` is only a CLI flag value. */
function effortOptions(effort: string): Pick<Options, "effort" | "extraArgs"> {
	return effort === "ultracode" ? { extraArgs: { effort } } : { effort: effort as EffortLevel };
}

export function childOptions(role: Role, session: ChildSession | undefined, title: string): Options {
	const options: Options = {
		model: role.model,
		...effortOptions(role.effort),
		permissionMode: role.permissionMode as PermissionMode,
		allowDangerouslySkipPermissions: role.permissionMode === "bypassPermissions",
		permissionPrompts: "none",
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: fs.readFileSync(path.join(CONTRACTS_DIR, role.contract), "utf8"),
		},
		includePartialMessages: true,
		title,
	};
	if (role.tools) {
		options.tools = role.tools;
		options.strictMcpConfig = true;
	}
	const size = process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE?.trim();
	if (role.effort === "ultracode" && size) options.settings = { workflowSizeGuideline: size as Settings["workflowSizeGuideline"] };
	if (session?.kind === "new") options.sessionId = session.id;
	else if (session?.kind === "resume") options.resume = session.id;
	else if (session?.kind === "fork") {
		options.resume = session.from;
		options.forkSession = true;
		options.sessionId = session.id;
	}
	if (session?.kind !== "new" && session?.at) options.resumeSessionAt = session.at;
	return options;
}

function briefArg(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const value = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.description ?? "";
	const text = String(value).split("\n")[0];
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function activityTail(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.replace(/\*\*/g, "").trim())
		.filter(Boolean);
	const line = lines[lines.length - 1] ?? "";
	return line.length > ACTIVITY_CHARS ? `…${line.slice(-ACTIVITY_CHARS)}` : line;
}

/** Streams deltas to the status line at most once per window, with a trailing call so the last delta is shown. */
function throttled(ms: number, fn: () => void): { call(): void; cancel(): void } {
	let last = 0;
	let timer: NodeJS.Timeout | undefined;
	const fire = () => {
		timer = undefined;
		last = Date.now();
		fn();
	};
	return {
		call() {
			if (timer) return;
			const wait = ms - (Date.now() - last);
			if (wait <= 0) fire();
			else {
				timer = setTimeout(fire, wait);
				timer.unref();
			}
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

class StreamedBlocks {
	private blocks = new Map<string | number, string>();

	reset(): void {
		this.blocks.clear();
	}

	append(kind: "thinking" | "writing", index: string | number, delta: string): string {
		const text = `${this.blocks.get(index) ?? ""}${delta}`;
		this.blocks.set(index, text);
		const tail = activityTail(text);
		return tail ? `${kind} · ${tail}` : kind;
	}
}

function descendantsOf(root: number): { pids: number[]; groups: number[] } {
	let table: string;
	try {
		table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 5_000 });
	} catch {
		return { pids: [], groups: [] };
	}
	const children = new Map<number, number[]>();
	const groupOf = new Map<number, number>();
	for (const line of table.split("\n")) {
		const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
		if (!pid || !ppid) continue;
		groupOf.set(pid, pgid ?? 0);
		children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	}
	const pids: number[] = [];
	const queue = [root];
	while (queue.length) {
		for (const child of children.get(queue.shift()!) ?? []) {
			pids.push(child);
			queue.push(child);
		}
	}
	const groups = [...new Set(pids.map((pid) => groupOf.get(pid)).filter((group): group is number => !!group && group !== root))];
	return { pids, groups };
}

interface ExitOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * Spawns the Claude Code process for the SDK and owns its process tree. The SDK's own shutdown sends SIGTERM to
 * the child 2 s after an abort and SIGKILL 5 s after that, to the child alone. This sends SIGTERM at once to the
 * child's process group and to the groups of every descendant, then SIGKILL after the grace period, so a Bash
 * command the child started dies with it.
 */
class ChildTree {
	command = "";
	stderr = "";
	spawnError?: Error;
	private proc?: ChildProcess;
	private closed?: Promise<ExitOutcome>;
	private killTimer?: NodeJS.Timeout;
	/*
	 * Descendants can sit in their own process groups. They are remembered across calls because once the child is
	 * dead they are re-parented and a later scan from the child's pid no longer finds them.
	 */
	private readonly known = { pids: new Set<number>(), groups: new Set<number>() };
	private readonly sent = new Set<NodeJS.Signals>();
	private readonly killGraceMs: number;

	constructor(killGraceMs: number) {
		this.killGraceMs = killGraceMs;
	}

	spawn(options: SpawnOptions): SpawnedProcess {
		this.command = options.command;
		const proc = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		this.proc = proc;
		proc.stdin?.on("error", () => {});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (data: string) => {
			this.stderr += data;
		});
		this.closed = new Promise<ExitOutcome>((resolve) => {
			proc.once("error", (err) => {
				this.spawnError = err instanceof Error ? err : new Error(String(err));
				resolve({ code: null, signal: null });
			});
			proc.once("close", (code, signal) => resolve({ code, signal }));
		});
		return {
			stdin: proc.stdin!,
			stdout: proc.stdout!,
			get killed() {
				return proc.killed;
			},
			get exitCode() {
				return proc.exitCode;
			},
			get signalCode() {
				return proc.signalCode;
			},
			kill: (signal: NodeJS.Signals) => {
				this.signalTree(signal);
				return true;
			},
			on: (event: "exit" | "error", listener: (...args: any[]) => void) => {
				proc.on(event, listener);
			},
			once: (event: "exit" | "error", listener: (...args: any[]) => void) => {
				proc.once(event, listener);
			},
			off: (event: "exit" | "error", listener: (...args: any[]) => void) => {
				proc.off(event, listener);
			},
		};
	}

	get spawned(): boolean {
		return this.proc !== undefined;
	}

	/** True when the child died of a signal this sent, so of our own shutdown and not of anything that happened to it. */
	stoppedBy(exit: ExitOutcome): boolean {
		return exit.signal !== null && this.sent.has(exit.signal);
	}

	kill(): void {
		this.signalTree("SIGTERM");
		if (this.killTimer) return;
		// Runs even after the child has closed: its descendants may still be shutting down.
		this.killTimer = setTimeout(() => this.signalTree("SIGKILL"), this.killGraceMs);
		this.killTimer.unref();
	}

	/** Waits for the child to close, giving it a moment to exit on its own before killing it. */
	async exited(): Promise<ExitOutcome> {
		if (!this.proc || !this.closed) return { code: null, signal: null };
		const outcome = await Promise.race([this.closed, sleep(EXIT_GRACE_MS)]);
		if (outcome) return outcome;
		this.kill();
		return this.closed;
	}

	private signalTree(signal: NodeJS.Signals): void {
		const pid = this.proc?.pid;
		if (!pid) return;
		this.sent.add(signal);
		if (process.platform === "win32") {
			try {
				this.proc?.kill(signal);
			} catch {}
			return;
		}
		const found = descendantsOf(pid);
		for (const descendant of found.pids) this.known.pids.add(descendant);
		for (const group of found.groups) this.known.groups.add(group);
		const targets = [-pid, ...[...this.known.groups].map((group) => -group), ...this.known.pids];
		for (const target of targets) {
			try {
				process.kill(target, signal);
			} catch {}
		}
	}
}

function newRun(role: Role): ChildRun {
	return {
		role,
		text: "",
		toolCalls: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		ms: 0,
		exitCode: null,
		signal: null,
		aborted: false,
		stderr: "",
	};
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelCosts(usage: unknown): ModelCost[] {
	if (!usage || typeof usage !== "object") return [];
	return Object.entries(usage as Record<string, any>).map(([model, entry]) => ({
		model,
		inputTokens: count(entry?.inputTokens),
		outputTokens: count(entry?.outputTokens),
		cacheRead: count(entry?.cacheReadInputTokens),
		cacheWrite: count(entry?.cacheCreationInputTokens),
		costUsd: count(entry?.costUSD),
		...(typeof entry?.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
	}));
}

function promptTokens(usage: any): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const total = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
	return total > 0 ? total : undefined;
}

function contextWindowOf(modelId: string | undefined, models: ModelCost[] | undefined): number {
	const reported = models?.find((entry) => entry.model === modelId)?.contextWindow;
	if (reported) return reported;
	return modelId && /\[1m\]/i.test(modelId) ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

function cappedLabel(value: unknown): string {
	const text = String(value ?? "");
	return text.length > WORKFLOW_LABEL_CHARS ? text.slice(0, WORKFLOW_LABEL_CHARS) : text;
}

/** `workflow_progress` is not in the SDK's types, so every entry and field is checked before it is read. */
function workflowProgress(event: any): { phase?: string; agents: Array<{ label: string; state: string }>; done: number; total: number } {
	const entries = Array.isArray(event?.workflow_progress) ? event.workflow_progress : [];
	const agents: Array<{ label: string; state: string }> = [];
	let phase: string | undefined;
	let total = 0;
	let done = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "workflow_phase" && typeof entry.title === "string") phase = entry.title;
		else if (entry.type === "workflow_agent") {
			total++;
			if (entry.state === "done") done++;
			if (typeof entry.label === "string" && agents.length < MAX_WORKFLOW_AGENTS) agents.push({ label: cappedLabel(entry.label), state: cappedLabel(entry.state) });
		}
	}
	return { ...(phase === undefined ? {} : { phase }), agents, done, total };
}

function hasWorkflowProgress(event: any): boolean {
	return Array.isArray(event.workflow_progress) && event.workflow_progress.length > 0;
}

function workflowSummary(event: any): string | undefined {
	if (!hasWorkflowProgress(event)) return typeof event.description === "string" && event.description ? event.description : undefined;
	const { phase, done, total } = workflowProgress(event);
	return `workflow${phase ? ` ${phase}` : ""} · ${done}/${total} agents done`;
}

/** What a run reports to a monitor: task and agent activity the run itself does not keep. */
export type ChildEvent =
	| { type: "init"; sessionId: string }
	| { type: "tool_call"; name: string; brief: string; id?: string; input?: unknown }
	| { type: "agent_tool_call"; parentToolUseId: string; name: string; id?: string; input?: unknown }
	| { type: "tool_result"; toolUseId: string; text: string; isError: boolean }
	| { type: "task_started"; taskId: string; toolUseId?: string; taskType?: string; name: string; subagentType?: string }
	| { type: "task_progress"; taskId: string; description?: string; summary?: string; lastTool?: string; tokens?: number; toolUses?: number; phase?: string; agents?: Array<{ label: string; state: string }> }
	| { type: "task_ended"; taskId: string; status: "completed" | "failed" | "stopped"; summary?: string; tokens?: number }
	| { type: "turn_result"; ok: boolean; message?: string };

function taskKind(taskType: unknown): string {
	return typeof taskType === "string" ? taskType.replace(/^local_/, "") : "task";
}

function taskName(event: any, taskId: string): string {
	if (typeof event.workflow_name === "string") return event.workflow_name;
	if (typeof event.description === "string" && event.description) return event.description;
	return taskId;
}

function taskStatus(status: unknown): "completed" | "failed" | "stopped" {
	return status === "completed" || status === "failed" || status === "stopped" ? status : "failed";
}

/**
 * The child's stdin as a queue of user messages. A string prompt makes the SDK close stdin after the first
 * result, which for an ultracode run comes as soon as its workflow starts; a queue stays open for steers until
 * the run has no work left.
 */
export class ChildInput implements AsyncIterable<SDKUserMessage> {
	private readonly queue: SDKUserMessage[] = [];
	private wake?: () => void;
	private ended = false;

	get open(): boolean {
		return !this.ended;
	}

	push(text: string): boolean {
		if (this.ended) return false;
		this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
		this.wake?.();
		return true;
	}

	end(): void {
		this.ended = true;
		this.wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		for (;;) {
			const next = this.queue.shift();
			if (next) yield next;
			else if (this.ended) return;
			else await new Promise<void>((resolve) => (this.wake = resolve));
		}
	}
}

interface AskedQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

function askedQuestions(input: unknown): AskedQuestion[] {
	const questions = (input as { questions?: unknown })?.questions;
	if (!Array.isArray(questions)) return [];
	return questions.filter((entry): entry is AskedQuestion => typeof entry?.question === "string" && entry.question.trim() !== "");
}

/** AskUserQuestion's questions and options as the one question the host answers. */
export function questionText(questions: readonly AskedQuestion[]): string {
	const one = (entry: AskedQuestion, prefix: string) => {
		const lines = [`${prefix}${entry.header ? `[${entry.header}] ` : ""}${entry.question}`];
		for (const option of entry.options ?? []) lines.push(`- ${option.label}${option.description ? `: ${option.description}` : ""}`);
		if (entry.multiSelect) lines.push("(one or more, separated by commas)");
		return lines.join("\n");
	};
	if (questions.length === 1) return one(questions[0]!, "");
	return `${questions.map((entry, index) => one(entry, `${index + 1}. `)).join("\n\n")}\n\nAnswer each question on its own line, in order.`;
}

/** The answers map AskUserQuestion takes: one line per question when the lines match the questions, else the whole answer for each. */
export function questionAnswers(questions: readonly AskedQuestion[], answer: string): Record<string, string> {
	const lines = answer.split("\n").map((line) => line.trim()).filter(Boolean);
	const split = questions.length > 1 && lines.length === questions.length;
	return Object.fromEntries(questions.map((entry, index) => [entry.question, split ? lines[index]!.replace(/^\d+\.\s*/, "") : answer.trim()]));
}

type Ask = (question: string, signal: AbortSignal) => Promise<string>;

/**
 * The ask_orchestrator tool and the AskUserQuestion hook, which both hold the child's tool call open until the host
 * answers. A PreToolUse hook and not canUseTool, because with permissionPrompts "none" the SDK never calls canUseTool.
 */
function questionOptions(ask: Ask, signal: AbortSignal): Pick<Options, "mcpServers" | "allowedTools" | "hooks"> {
	const server = createSdkMcpServer({
		name: QUESTION_SERVER,
		timeout: QUESTION_TIMEOUT_MS,
		alwaysLoad: true,
		tools: [
			tool(
				QUESTION_TOOL,
				"Ask the orchestrator that gave you this task for a decision you need to go on, such as a name or a choice between options inside the task's scope. The call waits until the orchestrator answers, which can take a long time; the answer is the result.",
				{ question: z.string().describe("The question, with the options you see and the one you recommend.") },
				async ({ question }) => ({ content: [{ type: "text" as const, text: await ask(question, signal) }] }),
			),
		],
	});
	const askUser: HookCallback = async (input) => {
		if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "AskUserQuestion") return {};
		const questions = askedQuestions(input.tool_input);
		if (!questions.length) return {};
		const answer = await ask(questionText(questions), signal);
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { ...(input.tool_input as Record<string, unknown>), answers: questionAnswers(questions, answer) },
			},
		};
	};
	return {
		mcpServers: { [QUESTION_SERVER]: server },
		allowedTools: [`mcp__${QUESTION_SERVER}__${QUESTION_TOOL}`],
		hooks: { PreToolUse: [{ matcher: "AskUserQuestion", timeout: HOOK_TIMEOUT_S, hooks: [askUser] }] },
	};
}

interface RunOptions {
	role: Role;
	prompt: string;
	cwd: string;
	session?: ChildSession;
	title?: string;
	signal: AbortSignal | undefined;
	/** Where the caller pushes steers. Without it the run takes only the prompt. */
	input?: ChildInput;
	/** Answers the child's questions. Without it the child gets no ask_orchestrator tool. */
	onQuestion?: Ask;
	onProgress: (run: ChildRun) => void;
	onEvent?: (event: ChildEvent) => void;
	killGraceMs?: number;
}

export async function runChild(opts: RunOptions): Promise<ChildRun> {
	const { role } = opts;
	const run = newRun(role);
	const started = Date.now();
	const controller = new AbortController();
	const child = new ChildTree(opts.killGraceMs ?? KILL_GRACE_MS);
	const input = opts.input ?? new ChildInput();
	input.push(opts.prompt);
	const onAbort = () => {
		run.aborted = true;
		input.end();
		controller.abort();
		child.kill();
	};
	if (opts.signal?.aborted) onAbort();
	else opts.signal?.addEventListener("abort", onAbort, { once: true });

	const toolUseIds = new Set<string>();
	const agentToolUseIds = new Set<string>();
	const workflowTokens = new Map<string, number>();
	const pendingTasks = new Map<string, string>();
	const resultIds = new Set<string>();
	const streamed = new StreamedBlocks();
	const deltaProgress = throttled(DELTA_PROGRESS_MS, () => opts.onProgress(run));
	const emit = (event: ChildEvent) => {
		try {
			opts.onEvent?.(event);
		} catch {}
	};
	const onMessage = (event: any) => {
		if (event.parent_tool_use_id && event.type === "assistant") {
			const parts = Array.isArray(event.message?.content) ? event.message.content : [];
			for (const part of parts) {
				if (part?.type !== "tool_use") continue;
				if (typeof part.id === "string") {
					if (agentToolUseIds.has(part.id)) continue;
					agentToolUseIds.add(part.id);
				}
				emit({
					type: "agent_tool_call",
					parentToolUseId: String(event.parent_tool_use_id),
					name: String(part.name ?? "?"),
					...(typeof part.id === "string" ? { id: part.id, input: part.input } : {}),
				});
			}
		}
		if (event.type === "user" && Array.isArray(event.message?.content)) {
			for (const part of event.message.content) {
				if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string" || resultIds.has(part.tool_use_id)) continue;
				resultIds.add(part.tool_use_id);
				emit({ type: "tool_result", toolUseId: part.tool_use_id, text: resultText(part.content), isError: part.is_error === true });
			}
		}
		if (event.parent_tool_use_id) return;
		if (event.type === "system") {
			if (event.subtype === "init") {
				if (typeof event.session_id === "string") {
					run.sessionId = event.session_id;
					emit({ type: "init", sessionId: event.session_id });
				}
				if (typeof event.model === "string" && event.model) {
					run.modelId = event.model;
					run.contextWindow = contextWindowOf(run.modelId, run.models);
				}
				run.activity = "waiting for model";
				opts.onProgress(run);
			}
			if (event.subtype === "task_started") {
				if (event.task_id !== undefined && event.task_id !== null) {
					const taskId = String(event.task_id);
					// Ambient tasks, such as watchers, get no task_notification: Claude Code neither waits for nor sweeps them.
					if (event.ambient !== true && event.skip_transcript !== true) pendingTasks.set(taskId, `${taskKind(event.task_type)} ${taskName(event, taskId)}`);
					emit({
						type: "task_started",
						taskId,
						...(typeof event.tool_use_id === "string" ? { toolUseId: event.tool_use_id } : {}),
						...(typeof event.task_type === "string" ? { taskType: event.task_type } : {}),
						name: taskName(event, taskId),
						...(typeof event.subagent_type === "string" ? { subagentType: event.subagent_type } : {}),
					});
				}
				if (typeof event.workflow_name === "string") {
					run.activity = `Workflow ${event.workflow_name}`;
					opts.onProgress(run);
				}
			}
			if (event.subtype === "background_tasks_changed" && Array.isArray(event.tasks)) {
				pendingTasks.clear();
				for (const task of event.tasks) {
					if (!task || task.ambient === true || typeof task.task_id !== "string") continue;
					pendingTasks.set(task.task_id, `${taskKind(task.task_type)} ${taskName(task, task.task_id)}`);
				}
			}
			if ((event.subtype === "task_progress" || event.subtype === "task_notification") && event.task_id !== undefined) {
				const tokens = event.usage?.total_tokens;
				if (typeof tokens === "number") {
					workflowTokens.set(String(event.task_id), tokens);
					run.workflowTokens = [...workflowTokens.values()].reduce((sum, n) => sum + n, 0);
				}
				if (event.subtype === "task_progress") {
					const progress = hasWorkflowProgress(event) ? workflowProgress(event) : undefined;
					emit({
						type: "task_progress",
						taskId: String(event.task_id),
						...(typeof event.description === "string" && event.description ? { description: event.description } : {}),
						...(typeof event.summary === "string" ? { summary: event.summary } : {}),
						...(typeof event.last_tool_name === "string" ? { lastTool: event.last_tool_name } : {}),
						...(typeof tokens === "number" ? { tokens } : {}),
						...(typeof event.usage?.tool_uses === "number" ? { toolUses: event.usage.tool_uses } : {}),
						...(progress?.phase === undefined ? {} : { phase: progress.phase }),
						...(progress?.agents.length ? { agents: progress.agents } : {}),
					});
					const summary = workflowSummary(event);
					if (summary) run.activity = summary;
					opts.onProgress(run);
				} else {
					pendingTasks.delete(String(event.task_id));
					emit({
						type: "task_ended",
						taskId: String(event.task_id),
						status: taskStatus(event.status),
						...(typeof event.summary === "string" && event.summary ? { summary: event.summary } : {}),
						...(typeof tokens === "number" ? { tokens } : {}),
					});
				}
			}
		} else if (event.type === "stream_event") {
			const streamEvent = event.event ?? {};
			if (streamEvent.type === "message_start") {
				streamed.reset();
				const context = promptTokens(streamEvent.message?.usage);
				if (context !== undefined) run.contextTokens = context;
			}
			else if (streamEvent.type === "content_block_start" && streamEvent.content_block?.type === "tool_use") {
				run.activity = `calling ${String(streamEvent.content_block.name ?? "?")}`;
				opts.onProgress(run);
			} else if (streamEvent.type === "content_block_delta") {
				const delta = streamEvent.delta ?? {};
				if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
					run.activity = streamed.append("thinking", streamEvent.index, delta.thinking);
					deltaProgress.call();
				} else if (delta.type === "text_delta" && typeof delta.text === "string") {
					run.activity = streamed.append("writing", streamEvent.index, delta.text);
					deltaProgress.call();
				}
			}
		} else if (event.type === "user") {
			run.activity = "waiting for model";
			opts.onProgress(run);
		} else if (event.type === "assistant") {
			if (typeof event.uuid === "string") run.checkpoint = event.uuid;
			const context = promptTokens(event.message?.usage);
			if (context !== undefined) run.contextTokens = context;
			for (const part of event.message?.content ?? []) {
				if (part?.type !== "thinking" || typeof part.thinking !== "string" || !part.thinking.trim()) continue;
				const text = part.thinking.length > THINKING_CHARS ? `${part.thinking.slice(0, THINKING_CHARS)}…` : part.thinking;
				run.thinking = [...(run.thinking ?? []), text].slice(-THINKING_BLOCKS);
			}
			for (const part of event.message?.content ?? []) {
				if (part?.type !== "tool_use") continue;
				if (typeof part.id === "string") {
					if (toolUseIds.has(part.id)) continue;
					toolUseIds.add(part.id);
				}
				run.toolCalls++;
				const arg = briefArg(part.input);
				emit({ type: "tool_call", name: String(part.name ?? "?"), brief: arg, ...(typeof part.id === "string" ? { id: part.id, input: part.input } : {}) });
				run.activity = arg ? `${part.name} ${arg}` : String(part.name ?? "?");
				opts.onProgress(run);
			}
		} else if (event.type === "result") {
			if (typeof event.session_id === "string") run.sessionId = event.session_id;
			const usage = event.usage;
			if (usage) {
				run.tokensIn += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
				run.tokensOut += usage.output_tokens || 0;
				run.cacheRead += usage.cache_read_input_tokens || 0;
				run.cacheWrite += usage.cache_creation_input_tokens || 0;
			}
			if (typeof event.total_cost_usd === "number" && event.total_cost_usd > 0) run.costUsd = event.total_cost_usd;
			const models = modelCosts(event.modelUsage);
			if (models.length) {
				run.models = models;
				run.contextWindow = contextWindowOf(run.modelId, models);
			}
			if (typeof event.num_turns === "number") run.numTurns = (run.numTurns ?? 0) + event.num_turns;
			if (typeof event.duration_api_ms === "number") run.apiMs = (run.apiMs ?? 0) + event.duration_api_ms;
			const text = typeof event.result === "string" ? event.result : "";
			if (text.trim()) run.text = text;
			if (event.is_error) {
				// An error subtype carries its text in errors[]; a success subtype with is_error carries it in result.
				const errors = Array.isArray(event.errors) ? event.errors.filter((error: unknown) => typeof error === "string" && error.trim()) : [];
				run.stopReason = "error";
				run.errorMessage = text.trim() || errors.join("\n") || String(event.subtype ?? "error");
			} else {
				run.stopReason = "stop";
			}
			const message = run.errorMessage;
			emit({ type: "turn_result", ok: !event.is_error, ...(event.is_error && message !== undefined ? { message } : {}) });
			const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
			for (const denial of denials) run.deniedTools = [...(run.deniedTools ?? []), String(denial?.tool_name ?? "?")];
			// A pending task's notification starts another turn; with none left, nothing but a steer could, so stdin closes.
			if (!pendingTasks.size) input.end();
			opts.onProgress(run);
		}
	};

	let sdkError: Error | undefined;
	try {
		const messages = query({
			prompt: input,
			options: {
				...childOptions(role, opts.session, opts.title ?? `pi-fusion ${role.name}`),
				...(opts.onQuestion ? questionOptions(opts.onQuestion, controller.signal) : {}),
				...claudeExecutable(),
				cwd: opts.cwd,
				env: {
					...process.env,
					CLAUDE_AGENT_SDK_CLIENT_APP: "pi-fusion",
					// Headless Claude Code kills background tasks still running 10 min after the turn ends. Only an abort stops the child.
					CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
				},
				abortController: controller,
				spawnClaudeCodeProcess: (options) => child.spawn(options),
			},
		});
		for await (const message of messages) onMessage(message);
	} catch (error) {
		sdkError = error instanceof Error ? error : new Error(String(error));
	} finally {
		input.end();
		opts.signal?.removeEventListener("abort", onAbort);
		deltaProgress.cancel();
	}
	const exit = await child.exited();
	run.ms = Date.now() - started;
	/*
	 * Once the conversation has ended, an error result included, the SDK stops the child through the handle, and a
	 * child still running after that is stopped here. Neither stop is the child's outcome.
	 */
	const stopped = child.stoppedBy(exit) && !run.aborted;
	run.exitCode = stopped ? 0 : exit.code;
	run.signal = stopped ? null : exit.signal;
	run.stderr = child.stderr;
	if (child.spawnError) run.errorMessage ??= `failed to spawn ${child.command}: ${child.spawnError.message}`;
	// On abort and non-zero exit the SDK's error only restates what the run already records.
	else if (sdkError && !run.aborted && !run.exitCode) run.errorMessage ??= sdkError.message;
	if (run.aborted) run.stopReason = "aborted";
	else if (pendingTasks.size) run.abandonedTasks = [...pendingTasks.values()];
	return run;
}

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

/** Dollars as the dashboard shows them: cents are too coarse for a single cheap call. */
function formatUsd(n: number): string {
	return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/** Why a claude call is refused once this Pi session's estimated cost has reached PI_FUSION_BUDGET_LIMIT_USD. */
export function budgetBlockMessage(block: { limitUsd: number; costUsd: number }): string {
	return `the claude runs of this Pi session have cost an estimated ${formatUsd(block.costUsd)}, at or over the PI_FUSION_BUDGET_LIMIT_USD limit of ${formatUsd(block.limitUsd)}; no new run starts and no run is continued. Active runs are not cancelled; wait for them, message them or cancel them with claude_control. The estimate uses list prices and updates when a child turn ends, so it can lag; raise or unset the variable and restart Pi to start runs again`;
}

function stats(handle: string, run: ChildRun): string {
	const secs = Math.round(run.ms / 1000);
	const parts = [`${handle} · ${run.role.name} · ${run.role.model} · ${secs}s · ${run.toolCalls} tool calls · in ${formatTokens(run.tokensIn)} out ${formatTokens(run.tokensOut)}`];
	const { contextTokens, contextWindow } = run;
	if (contextTokens && contextWindow) parts.push(`context ${formatTokens(contextTokens)}/${formatTokens(contextWindow)} (${sharePercent(contextTokens / contextWindow)})`);
	if (run.workflowTokens) parts.push(`workflow agents ${formatTokens(run.workflowTokens)} tokens`);
	if (run.deniedTools?.length) parts.push(`denied: ${[...new Set(run.deniedTools)].join(", ")}`);
	if (run.sessionId) parts.push(`claude --resume ${run.sessionId}`);
	return parts.join(" · ");
}

export function failed(run: ChildRun): boolean {
	if (run.aborted || run.abandonedTasks?.length) return true;
	return !(run.exitCode === 0 && run.signal === null && run.stopReason === "stop");
}

function failureDetail(run: ChildRun): string {
	const fromError = run.errorMessage?.trim();
	if (fromError) return fromError;
	const stderrLines = run.stderr
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim());
	const errorLines = stderrLines.filter((line) => !line.startsWith("Warning:"));
	const detail = errorLines.length ? errorLines : stderrLines;
	if (detail.length) return detail.slice(-5).join("\n");
	return run.text.trim();
}

export function failureMessage(run: ChildRun): string {
	const name = run.role.name;
	if (run.aborted) return run.activity ? `${name} aborted while ${run.activity}` : `${name} aborted`;
	const outcome = run.signal
		? `${name} killed by ${run.signal}`
		: run.exitCode !== 0
			? `${name} ${run.exitCode === null ? "did not start" : `exited ${run.exitCode}`}`
			: run.abandonedTasks?.length
				? `${name} exited with ${run.abandonedTasks.join(", ")} still running`
				: run.stopReason === "error"
					? `${name} model error`
					: run.stopReason === undefined
						? `${name} produced no response`
						: `${name} ended with stopReason ${run.stopReason}`;
	const detail = failureDetail(run);
	return detail ? `${outcome}: ${detail}` : outcome;
}

const TOOL_NAME = "claude";
const CONTROL_TOOL_NAME = "claude_control";
const NOTICE_TYPE = "pi-fusion-run";
/** What a run notice is about: the run itself, or what the user did to it. */
const NOTICE_LABELS = new Map([
	["steer", "user steer"],
	["answer", "user answer"],
	["review", "user review"],
]);
/** What became of a run whose Pi process ended while it was still going: nobody was left to finish it. */
const HISTORY_ABORTED = "aborted when the earlier Pi process ended";
/** How long a going run's record may stay as it is on disk, on top of the write every turn that spent tokens gets. */
const HISTORY_SPEND_MS = 15_000;
const SUMMARY_CHARS = 600;
const CONTROL_ACTIONS = ["status", "wait", "message", "cancel"] as const;

type RunState = "running" | "waiting" | "done" | "failed" | "aborted" | "cancelled";

interface OpenQuestion {
	id: string;
	text: string;
	answer: (text: string) => void;
	drop: (error: Error) => void;
	/** Who answered it, so whoever arrives second can be told who was first. */
	answered?: { by: "user" | "host"; text: string; at: number };
}

/** What answering a run gave: a question is answered once, so a second caller in the same tick gets ok false. */
type Answered = { ok: true; question: OpenQuestion; next?: OpenQuestion } | { ok: false };

/** What started a run: the claude tool, a review the user asked for, or a review this extension started on its own. */
export type RunOrigin = "tool" | "review" | "auto-review";

/** What a review needs of the run it reads, so a run of this Pi process and one the history kept both fit. */
interface ReviewTarget {
	handle: string;
	role: string;
	state: string;
	prompt: string;
	report?: string;
	failure?: string;
	files?: ReadonlyArray<ChangedFile>;
	/** The working directory the run was made in, when that is not this one: a review reads the tree the run changed. */
	madeIn?: string;
	/** Links the source to the review that reads it, wherever the source is kept. */
	markReviewed(handle: string): void;
}

/** A run this Pi process started, from its start to its end, foreground or background. */
interface LiveRun {
	/** The run's id in the dashboard store. */
	id: string;
	handle: string;
	role: Role;
	/** The prompt the child was started with. */
	prompt: string;
	origin: RunOrigin;
	/** The handle of the latest independent review of this run. */
	reviewedBy?: string;
	/** For a review run, the handle of the run it reviews. */
	reviews?: string;
	background: boolean;
	started: number;
	endedAt?: number;
	state: RunState;
	input: ChildInput;
	controller: AbortController;
	cancelled: boolean;
	cancelledBy?: "user" | "host";
	latest?: ChildRun;
	cwd: string;
	before?: Snapshot;
	report?: string;
	failure?: string;
	stats?: string;
	/** What the host must read with this run's outcome, such as the plan handoff that gave the run its own handle. */
	note?: string;
	files?: ChangedFile[];
	/** What the run had changed when the render last sampled it, and when that was, while it is still running. */
	filesSampledAt?: number;
	filesSampled?: ChangedFile[];
	/** The child's open questions, oldest first; the run is waiting while there is one. */
	questions: OpenQuestion[];
	/** The answer the user gave the run's last question, until the host has been told about it. */
	userAnswer?: { questionId: string; text: string; at: number; acknowledged: boolean };
	/** True once a tool result carried the outcome, so no completion notice repeats it. */
	delivered: boolean;
	/** Called once when the run ends or opens a question. */
	waiters: Set<() => void>;
	/** The user's own observers of those events; unlike a waiter, one never keeps the run's notice from the host. */
	watchers: Set<() => void>;
	/** True once the run's entry is recorded and its report delivered, which is after its state turns terminal. */
	finished: boolean;
	/** The Pi tool that started the run, the id of its call, and the Pi session that made it, for the history. */
	tool?: string;
	toolCallId?: string;
	hostSessionId?: string;
	title: string;
	session: ChildSession;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
	ended: Promise<void>;
}

const isActive = (run: LiveRun | undefined): boolean => run?.state === "running" || run?.state === "waiting";

/** What the run changed: the list it ended with, or the sample the render took while it was still going. */
function runFiles(run: LiveRun): ChangedFile[] | undefined {
	return run.files ?? (isActive(run) ? run.filesSampled : undefined);
}

/** What every card about a run reads: bounded, and the same wherever a run's details go. */
function runDetails(run: LiveRun): CardDetails {
	const files = runFiles(run);
	const question = run.state === "waiting" ? run.questions[0]?.text : undefined;
	return {
		handle: run.handle,
		role: run.role.name,
		model: run.role.model,
		state: run.state,
		background: run.background,
		elapsedMs: (run.endedAt ?? Date.now()) - run.started,
		...(run.latest?.costUsd === undefined ? {} : { costUsd: run.latest.costUsd }),
		...(files === undefined ? {} : { filesChanged: files.length, ...(files.length ? { files: files.slice(0, CARD_FILES).map((file) => file.path) } : {}) }),
		...(run.reviewedBy === undefined ? {} : { reviewedBy: run.reviewedBy }),
		...(run.reviews === undefined ? {} : { reviews: run.reviews }),
		...(question === undefined ? {} : { question: question.slice(0, CARD_QUESTION_CHARS) }),
	};
}

/** What the editor widget says about an active run. */
function widgetRun(run: LiveRun): WidgetRun {
	const files = runFiles(run);
	return {
		handle: run.handle,
		role: run.role.name,
		...(run.reviews === undefined ? {} : { reviews: run.reviews }),
		state: run.state,
		elapsedMs: Date.now() - run.started,
		toolCalls: run.latest?.toolCalls ?? 0,
		...(run.latest?.activity === undefined ? {} : { activity: run.latest.activity }),
		...(files === undefined ? {} : { filesChanged: files.length }),
		...(run.questions[0] === undefined ? {} : { question: run.questions[0].text }),
	};
}

/** What the body of a card needs of a run's details, so a renderer passes on the details it already read. */
function bodyOf(details: CardDetails): { question?: string; handle?: string; files?: string[]; filesChanged?: number } {
	return {
		...(details.question === undefined ? {} : { question: details.question }),
		...(details.handle === undefined ? {} : { handle: details.handle }),
		...(details.files === undefined ? {} : { files: details.files }),
		...(details.filesChanged === undefined ? {} : { filesChanged: details.filesChanged }),
	};
}

/** The card a render slot already has, refilled, or a new one: Pi keeps the component it was given last time. */
function reuse(context: { lastComponent?: unknown }, header: string, lines: string[], mode: CardMode = "wrap"): Card {
	const last = context.lastComponent;
	if (!(last instanceof Card)) return new Card(header, lines, mode);
	last.setMode(mode);
	last.setHeader(header);
	last.setLines(lines);
	return last;
}

/** A collapsed card cuts its lines: a report written as paragraphs would otherwise fill the transcript. */
function cardMode(expanded: boolean): CardMode {
	return expanded ? "wrap" : "truncate";
}

/** A tool argument as a card shows it: anything but a string reads as nothing, because a render must never throw. */
function argText(value: unknown): string {
	return typeof value === "string" ? plainText(value) : "";
}

/** The card a finished claude or claude_control call shows: the run's header over its report, files and question. */
function resultCard(
	label: string,
	result: { content?: unknown; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: CardTheme,
	context: { lastComponent?: unknown; isError?: boolean },
): Card {
	const text = resultText(result.content);
	// firstLine leaves the text as the host reads it, so a card strips the child's activity here, where it is drawn.
	if (options.isPartial) return reuse(context, theme.fg("muted", firstLine(plainText(text))), []);
	const details = cardDetails(result.details);
	// A tool that threw returns no details, so the row's own error state is all that names what became of the run.
	if (!details.state && context.isError) details.state = "failed";
	return reuse(context, headerLine(theme, { label, details }), bodyLines(theme, text, { expanded: options.expanded, ...bodyOf(details) }), cardMode(options.expanded));
}

function activityLine(run: LiveRun): string {
	const secs = Math.round((Date.now() - run.started) / 1000);
	const latest = run.latest;
	if (run.state === "waiting") return `${run.handle} ${run.role.name} · ${secs}s · waiting for an answer`;
	if (!latest) return `${run.handle} ${run.role.name} · ${secs}s · starting`;
	return `${run.handle} ${run.role.name} · ${secs}s · ${latest.toolCalls} tool calls${latest.activity ? ` · ${plainText(latest.activity)}` : ""}`;
}

function statusLine(run: LiveRun): string {
	const secs = Math.round(((run.endedAt ?? Date.now()) - run.started) / 1000);
	const question = run.questions[0] ? `\n  question: ${firstLine(run.questions[0].text)}` : "";
	const reviews = run.reviews ? ` · review of ${run.reviews}` : "";
	const share = contextShare(run.latest);
	const context = share === undefined ? "" : ` · context ${sharePercent(share)}`;
	return `${run.handle} · ${run.role.name} · ${run.role.model} · ${run.state}${run.background ? " · background" : ""} · ${secs}s${context}${reviews}${question}`;
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > ACTIVITY_CHARS * 2 ? `${line.slice(0, ACTIVITY_CHARS * 2)}…` : line;
}

function askedText(run: LiveRun): string {
	return `${run.handle} (${roleText(run)}) asks:\n\n${run.questions[0]?.text ?? ""}\n\nThe run waits in the background until you answer with claude_control message and run ${run.handle}. Ask the user first if the decision is theirs.`;
}

/** How a run names itself in its reports: a review names the run it reviews, because its handle alone says nothing. */
function roleText(run: LiveRun): string {
	return run.reviews ? `${run.role.name}, review of ${run.reviews}` : run.role.name;
}

/** What a run's final text adds once a review of it has started, so whoever reads the report knows one is coming. */
function reviewLine(handle: string): string {
	return `${handle} reviews this run in the background; its report arrives as a message.`;
}

function finalText(run: LiveRun): string {
	const body = run.state === "done" ? run.report?.trim() || "(no output)" : run.failure ?? run.state;
	const reviewed = run.reviewedBy ? `\n\n${reviewLine(run.reviewedBy)}` : "";
	const note = run.note ? `${run.note}\n\n` : "";
	return `${note}${run.handle} (${roleText(run)}) ${run.state}.\n\n${body}${run.stats ? `\n\n[${run.stats}]` : ""}${reviewed}`;
}

/** The record of a run no process is running any more, or undefined when the record already ended: a run still going when its Pi process ended was finished by nobody. */
function asEnded(held: HistoryRecord): HistoryRecord | undefined {
	if (held.state !== "running" && held.state !== "waiting") return undefined;
	return { ...held, state: "aborted", endedAt: held.endedAt ?? held.startedAt, failure: HISTORY_ABORTED };
}

/** Why the run the on-disk history kept cannot be reviewed, or undefined when it can be. */
function heldNotReviewable(held: HistoryRecord): string | undefined {
	return reviewable({ state: held.state, role: held.role, ...(held.files ? { files: held.files } : {}) });
}

/**
 * What a run of an earlier Pi process, as the history kept it, tells the user and the host: what it did and what is
 * left. `cwd` is where this Pi process runs, because a review reads the tree the run changed and no other.
 */
function heldText(held: HistoryRecord, continuable: boolean, cwd: string): string {
	const secs = Math.round(((held.endedAt ?? held.startedAt) - held.startedAt) / 1000);
	const files = held.filesTotal ?? held.files?.length ?? 0;
	const body = (held.state === "done" ? held.report : held.failure)?.trim() ?? "";
	const lines = [`${held.handle} (${held.role}) ran in an earlier Pi process: ${held.state}, ${secs}s, ${files} changed files`];
	if (body) lines.push(body.length > SUMMARY_CHARS ? `${body.slice(0, SUMMARY_CHARS)}…` : body);
	// Only a run the branch recorded has a child session to resume; a run killed in flight recorded none.
	if (continuable) lines.push(`continue it with claude and continue ${held.handle}`);
	if (held.cwd === cwd && heldNotReviewable(held) === undefined) lines.push(`review it with /fusion review ${held.handle}`);
	return lines.join("\n");
}

function summary(run: LiveRun): string {
	const text = (run.state === "done" ? run.report : run.failure)?.trim() ?? "";
	return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
}

function handleNumber(handle: string): number {
	return Number(HANDLE.exec(handle)?.[1] ?? 0);
}

const FUSION_ARGS = ["dashboard", "dashboard stop", "status", "cancel", "steer", "wait", "answer", "review"];
const USAGE =
	"Usage: /fusion dashboard | /fusion dashboard stop | /fusion status [run-N] | /fusion cancel run-N | /fusion wait run-N | /fusion steer run-N <text> | /fusion answer [run-N] [text] | /fusion review run-N";
/** A /fusion argument list that names a run, as far as it is typed, for completion. */
const RUN_ARG = /^(status|cancel|wait|steer|answer|review)\s+(\S*)$/;
const BROWSER_OPENER: Record<string, string> = { darwin: "open", linux: "xdg-open" };

/** What a /fusion argument list asks for. */
export type FusionCommand =
	| { kind: "dashboard" }
	| { kind: "dashboard-stop" }
	| { kind: "status"; handle?: string }
	| { kind: "cancel" | "wait" | "review"; handle: string }
	| { kind: "steer"; handle: string; text: string }
	| { kind: "answer"; handle?: string; text?: string }
	| { kind: "usage"; message: string };

/** The command a /fusion argument list names, or the usage when it names none. */
export function parseFusion(args: string): FusionCommand {
	const usage: FusionCommand = { kind: "usage", message: USAGE };
	const text = args.trim();
	const tokens = text ? text.split(/\s+/) : [];
	const [first, second] = tokens;
	if (first === "dashboard") {
		if (tokens.length === 1) return { kind: "dashboard" };
		return tokens.length === 2 && second === "stop" ? { kind: "dashboard-stop" } : usage;
	}
	if (first === "status") {
		if (tokens.length === 1) return { kind: "status" };
		return tokens.length === 2 && HANDLE.test(second) ? { kind: "status", handle: second } : usage;
	}
	if (first === "cancel" || first === "wait" || first === "review") return tokens.length === 2 && HANDLE.test(second) ? { kind: first, handle: second } : usage;
	if (first === "steer") {
		const parts = /^steer\s+(\S+)\s+([\s\S]+)$/.exec(text);
		const steer = parts?.[2].trim();
		return parts && HANDLE.test(parts[1]) && steer ? { kind: "steer", handle: parts[1], text: steer } : usage;
	}
	if (first === "answer") {
		if (tokens.length === 1) return { kind: "answer" };
		const rest = text.slice(first.length).trim();
		if (!HANDLE.test(second)) return { kind: "answer", text: rest };
		const reply = rest.slice(second.length).trim();
		return { kind: "answer", handle: second, ...(reply ? { text: reply } : {}) };
	}
	return usage;
}

/** Best effort: a browser that will not start must not fail the command or reach the session as an unhandled error. */
function openInBrowser(url: string): void {
	const opener = BROWSER_OPENER[process.platform];
	if (!opener) return;
	try {
		const browser = spawn(opener, [url], { stdio: "ignore", detached: true });
		browser.on("error", () => {});
		browser.unref();
	} catch {}
}

const GUIDELINES = [
	"Route claude calls by complexity and risk, not by file count. Call claude with role plan, giving the goal, a short plan, constraints and what is already decided, when the design is unresolved: more than one viable approach, unclear requirements, a change to a shared contract or interface, or risk you cannot bound by reading the code. Treat the returned agreed plan as the contract and its Route section as a recommendation. Skip role plan when you can already state what to change, where, the acceptance criteria and how to verify it.",
	"A claude call with role plan continues the last plan run only while that run's context stays under its cap, 35% of the window by default. Past the cap the call starts a fresh plan run that carries the last report, the plan agreed so far, instead of the transcript behind it, and the result says which run replaced which. Keep working with the fresh run: state anything the earlier run knew and its report does not say, and call claude with continue and the older handle only when you need what it dropped.",
	"A claude call with continue is never handed off, because you named the run. Past the cap its result says so and names what a fresh run would take instead; act on that when the next step can stand on its own, and keep continuing the run while it cannot.",
	"Delegate every implementation task to claude with role implement or role ultracode, in dependency order; do not edit files yourself.",
	"Use claude with role implement for a clear, bounded task, however many files it touches: straight from the user's request when no design question is open, or one task at a time from a plan that role plan agreed.",
	"Use claude with role ultracode for complex, uncertain or high-risk work that gains from separate specialist agents and independent verification, or when the user asks for ultracode or for Fable to implement. Role ultracode runs its agents one at a time so builds and tests do not overlap; do not ask it for parallel work, and expect it to be slow. Give it a whole agreed plan in one call unless tasks must be verified separately. Its report's Review section is a self-review by agents it briefed.",
	"When a claude role implement report has an Escalation section, do not re-send or widen the task yourself. Keep what it changed and verified, then take the design question to claude role plan or the broader work to claude role ultracode, with the report as context.",
	"The user's explicit choice wins over these claude routing guidelines: Opus means role implement, Fable or ultracode means role ultracode, and the user can ask for or skip role plan. A model or effort the user names goes in claude's model or effort parameter; leave both unset otherwise.",
	"Use claude with role ask to answer a question about the code or its dependencies without changing files, instead of reading many files yourself, and with role ask and mode review for an independent review of a change, naming the diff or files and what the change must do. Role ask runs read-only tools and returns an answer or ranked findings with file and line references; it never implements.",
	"To follow up on an earlier claude run, such as a test that still fails after role implement, call claude with continue set to its handle and the follow-up as task instead of starting a new run; the child keeps its context. Start a new run when the work is unrelated.",
	"Call claude with background true when the run will take long and you have other work or the user wants to keep talking, such as role ultracode or a long role implement task; the call returns the handle at once and the report arrives later as a message. Only one run that can change files is active at a time, but role ask runs can go next to it. Use claude_control status to check a run, wait to block on its report, message to steer it, and cancel to stop it. A message to a run that has ended is not sent; decide from the returned report whether to continue the run with claude continue or leave it.",
	"A claude child can ask you a question while it works. The claude call, a claude_control wait or a message then gives you the question, and the run waits in the background, keeping its context, until you answer with claude_control message. Answer it yourself when the conversation already settles it; otherwise ask the user and pass on their answer. Do not start or continue another run that can change files while it waits.",
	"Report to the user which claude roles you used and why, what role plan agreed when it ran, what role implement or role ultracode changed and how it was verified, and what role ultracode's review found; summarize rather than pasting the child reports verbatim.",
];

/** A plain string enum: some providers reject the anyOf of consts that a union of literals becomes. */
const stringEnum = <T extends readonly string[]>(values: T, description: string) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });

export default function fusion(pi: ExtensionAPI) {
	for (const name of new Set([...Object.values(ROLES).map((role) => role.contract), ...Object.values(ASK_CONTRACTS)])) {
		const contract = path.join(CONTRACTS_DIR, name);
		if (!fs.existsSync(contract)) throw new Error(`pi-fusion: missing contract ${contract}`);
	}

	const store = new RunStore();
	const ledger = new Ledger(budgetConfig());
	/** The variables that are set and name nothing their control can use, read where the ledger reads them: when Pi loads this. */
	const budgetTrouble = [...budgetProblems(), ...planProblems()];
	/** The share of its window, as a percentage, past which a plan run is handed off to a fresh one. */
	const planPct = planContextPct();
	let budgetNoted = false;
	/** Whether an implement or ultracode run that changed files gets an independent review without being asked. */
	const autoReview = process.env.PI_FUSION_AUTO_REVIEW?.trim() === "1";
	/** Whether this Pi session keeps its runs on disk, so a later process on the same host session can show them. */
	const historyOn = historyEnabled();
	let history: History | undefined;
	/** The runs an earlier Pi process left in this host session's file, the newest record per handle. */
	const historical = new Map<string, HistoryRecord>();
	const loadedHistory = new Set<string>();
	let historyWarned = false;
	/** The latest ctx a call gave this extension, so a completion, which is given none, can still read the branch. */
	let lastCtx: any;
	let dashboard: Promise<Dashboard> | undefined;

	/** Monitoring is never worth a failed tool call, so nothing the store does reaches the caller. */
	const record = (call: () => void): void => {
		try {
			call();
		} catch {}
	};

	/** Says once, on the first call of the process, that a budget variable turned its control off instead of setting it. */
	const noteBudget = (ctx: any): void => {
		if (budgetNoted || !budgetTrouble.length) return;
		budgetNoted = true;
		for (const trouble of budgetTrouble) record(() => ctx.ui.notify(`fusion: ${trouble}`, "warning"));
	};

	/** The session spend the dashboard header shows, with the thresholds that make it worth watching. */
	const sessionUsage = () => ({
		...ledger.totals(),
		warnUsd: ledger.config.warnUsd,
		...(ledger.config.limitUsd === undefined ? {} : { limitUsd: ledger.config.limitUsd }),
	});

	const openDashboard = (cwd: string): Promise<Dashboard> => {
		if (dashboard) return dashboard;
		const starting: Promise<Dashboard> = startDashboard(store, { cwd, usage: sessionUsage }).catch((error) => {
			if (dashboard === starting) dashboard = undefined;
			throw error;
		});
		dashboard = starting;
		return starting;
	};

	/** Closes a started dashboard, and a start still in flight once it has resolved, so no server is left listening. */
	const closeDashboard = async (): Promise<boolean> => {
		const starting = dashboard;
		dashboard = undefined;
		if (!starting) return false;
		try {
			await (await starting).close();
		} catch {}
		return true;
	};


	/** A history that cannot be read or written costs the user a list, never a run, so it is said once and dropped. */
	const warnHistory = (ctx: any, warning: string): void => {
		if (historyWarned) return;
		historyWarned = true;
		record(() => ctx.ui.notify(`fusion history: ${warning}`, "warning"));
	};

	/** The host session this Pi process is on, or none when the host cannot say, because no history call may fail. */
	const hostSession = (ctx: any): string | undefined => {
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			return typeof id === "string" && id ? id : undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * Writes runs into the file of the host session named, which is only ever one this runtime loaded: the file of an
	 * ancestor session is read and never written back, because a Pi process still on it would lose the records it wrote
	 * between this read and this rename. A run that started under a session id the host has since changed still lands
	 * in the file it started in. Several runs go in one call, because a write rewrites the whole file.
	 */
	const saveHistory = (ctx: any, hostSessionId: string | undefined, ...held: HistoryRecord[]): void => {
		if (!history || !held.length || !hostSessionId || !loadedHistory.has(hostSessionId)) return;
		record(() => {
			const trouble = history?.saveAll(hostSessionId, held[0]!.cwd, held);
			if (trouble?.warning) warnHistory(ctx, trouble.warning);
		});
	};

	/** The run as the history keeps it: what it was asked, what it did, and where its child session is. */
	const historyRecord = (run: LiveRun, state: RunState, child?: ChildRun): HistoryRecord => ({
		id: run.id,
		handle: run.handle,
		role: run.role.name,
		...(run.role.mode === undefined ? {} : { mode: run.role.mode }),
		model: run.role.model,
		hostSessionId: run.hostSessionId ?? "",
		cwd: run.cwd,
		...(run.tool === undefined ? {} : { tool: run.tool }),
		...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
		origin: run.origin,
		...(run.reviews === undefined ? {} : { reviews: run.reviews }),
		...(run.reviewedBy === undefined ? {} : { reviewedBy: run.reviewedBy }),
		state,
		...(run.background ? { background: true } : {}),
		startedAt: run.started,
		...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
		prompt: run.prompt,
		...(run.report === undefined ? {} : { report: run.report }),
		...(run.failure === undefined ? {} : { failure: run.failure }),
		...(run.files === undefined ? {} : { files: run.files, filesTotal: run.files.length }),
		...(child?.sessionId === undefined ? {} : { sessionId: child.sessionId }),
		...(child?.checkpoint === undefined ? {} : { checkpoint: child.checkpoint }),
		session: run.session,
		contract: `contracts/${run.role.contract}`,
		title: run.title,
		...(child === undefined
			? {}
			: {
					usage: {
						...(child.costUsd === undefined ? {} : { costUsd: child.costUsd }),
						tokensIn: child.tokensIn,
						tokensOut: child.tokensOut,
						...(child.workflowTokens === undefined ? {} : { workflowTokens: child.workflowTokens }),
						toolCalls: child.toolCalls,
					},
				}),
	});

	/** Turns what an earlier Pi process left behind into what this one shows: its spend, its dashboard and its lookups. */
	const restoreHistory = (hostSessionId: string, ctx: any): void => {
		const loaded = history?.load(hostSessionId);
		if (!loaded) return;
		if (loaded.warning) warnHistory(ctx, loaded.warning);
		const corrected: HistoryRecord[] = [];
		for (const read of loaded.records) {
			const interrupted = asEnded(read);
			const held = interrupted ?? read;
			if (interrupted) corrected.push(interrupted);
			if (held.usage) ledger.update(held.id, held.usage);
			store.restore(held);
			historical.set(held.handle, held);
		}
		saveHistory(ctx, hostSessionId, ...corrected);
	};

	/**
	 * Loads this host session's runs from disk once per runtime, so a later Pi process on the same session shows what
	 * ran before it. A session Pi keeps no file for keeps no history, and nothing here is worth a failed call.
	 */
	const ensureHistory = (ctx: any): void => {
		lastCtx = ctx;
		if (!historyOn) return;
		let file: unknown;
		let hostSessionId: unknown;
		try {
			file = ctx.sessionManager?.getSessionFile?.();
			hostSessionId = ctx.sessionManager?.getSessionId?.();
		} catch {
			return;
		}
		if (typeof file !== "string" || typeof hostSessionId !== "string" || !hostSessionId || loadedHistory.has(hostSessionId)) return;
		loadedHistory.add(hostSessionId);
		history ??= new History(historyDir());
		record(() => restoreHistory(hostSessionId as string, ctx));
	};

	/** The runs the host branch remembers, or none when the host cannot say, because a completion must not fail. */
	const branchRuns = (ctx: any): Map<string, RunRecord> => {
		try {
			return runRecords(ctx.sessionManager.getBranch()).runs;
		} catch {
			return new Map();
		}
	};

	/** A record of the branch's run and the history's run are the same run when neither names another child session. */
	const sameChild = (held: HistoryRecord, branch: RunRecord): boolean =>
		held.sessionId === undefined || branch.sessionId === undefined || held.sessionId === branch.sessionId;

	/**
	 * What the history kept about a run the branch remembers and this process never started. A run of an ancestor host
	 * session, which is what a fork leaves behind, is read from that session's file and never written back to it.
	 */
	const heldRun = (handle: string, branch: RunRecord, ctx: any): HistoryRecord | undefined => {
		if (!history) return undefined;
		const current = hostSession(ctx);
		if (!branch.hostSessionId || branch.hostSessionId === current) {
			const held = historical.get(handle);
			return held && sameChild(held, branch) ? held : undefined;
		}
		const loaded = history.load(branch.hostSessionId);
		if (loaded.warning) warnHistory(ctx, loaded.warning);
		const held = [...loaded.records].reverse().find((entry) => entry.handle === handle && sameChild(entry, branch));
		// That session's file is another process's to correct, so a run it left going ends here and nowhere else.
		return held === undefined ? undefined : (asEnded(held) ?? held);
	};

	/** The runs this Pi process started, by handle. Pi builds a new extension runtime for every host session. */
	const runs = new Map<string, LiveRun>();
	let ui: { setStatus(key: string, text: string | undefined): void; setWidget?(key: string, lines: string[] | undefined): void } | undefined;
	let ticker: NodeJS.Timeout | undefined;
	let shuttingDown = false;
	/** Whether the active runs also show over the editor; the footer status line stays either way. */
	const widgetOn = process.env.PI_FUSION_WIDGET?.trim() !== "0";

	const active = (): LiveRun[] => [...runs.values()].filter(isActive);

	/** Monitoring only: a host that cannot take the status or an update must not fail the run that renders. */
	const render = () => {
		const running = active();
		record(() => ui?.setStatus("fusion", running.length ? running.map(activityLine).join(" | ") : undefined));
		for (const run of running) record(() => run.onUpdate?.({ content: [{ type: "text", text: activityLine(run) }], details: {} }));
		if (widgetOn) {
			record(() => {
				const lines = widgetLines(undefined, running.map(widgetRun), ledger.config.warnUsd.length || ledger.config.limitUsd !== undefined ? sessionUsage() : undefined);
				ui?.setWidget?.("fusion", lines.length ? lines : undefined);
			});
		}
		for (const run of running) sampleFiles(run);
		if (running.length && !ticker) {
			ticker = setInterval(render, TICK_MS);
			ticker.unref();
		} else if (!running.length && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	/** pi.sendMessage throws when this extension runtime is no longer the session's, which must not fail the caller. */
	const send = (message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
		try {
			pi.sendMessage(message, options);
		} catch {}
	};

	const notify = (run: LiveRun, text: string) => {
		send(
			{ customType: NOTICE_TYPE, content: `Background run ${text}`, display: true, details: runDetails(run) },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	/** Calls the run's waiters and watchers and reports whether a waiter heard, so a notice goes out only when none did. */
	const settle = (run: LiveRun): boolean => {
		const waiters = [...run.waiters];
		const watchers = [...run.watchers];
		run.waiters.clear();
		run.watchers.clear();
		for (const listener of [...waiters, ...watchers]) listener();
		return waiters.length > 0;
	};

	const waitOn = (run: LiveRun, listeners: Set<() => void>, signal?: AbortSignal): Promise<boolean> =>
		new Promise((resolve) => {
			if (run.state !== "running") return resolve(true);
			const stop = () => {
				listeners.delete(done);
				resolve(false);
			};
			const done = () => {
				signal?.removeEventListener("abort", stop);
				resolve(true);
			};
			listeners.add(done);
			if (signal?.aborted) stop();
			else signal?.addEventListener("abort", stop, { once: true });
		});

	/** Resolves true when the run ends or opens a question, or false when the signal stops the wait first. */
	const settled = (run: LiveRun, signal?: AbortSignal): Promise<boolean> => waitOn(run, run.waiters, signal);

	/** The same wait for the user, which leaves the run's notice to the host. */
	const watched = (run: LiveRun, signal?: AbortSignal): Promise<boolean> => waitOn(run, run.watchers, signal);

	/**
	 * Answers the run's oldest open question, if the run still waits for one. Everything up to the resolve is
	 * synchronous, so of two callers in the same tick the first answers and the second is told there was nothing left
	 * to answer. A run that has ended keeps its questions until its end lands, and answering one of those would put the
	 * finished run back to running, so the state decides whether there is anything to answer, not the list.
	 */
	const answer = (run: LiveRun, text: string, by: "user" | "host"): Answered => {
		if (run.state !== "waiting") return { ok: false };
		const question = run.questions.shift();
		if (!question) return { ok: false };
		const at = Date.now();
		question.answered = { by, text, at };
		if (by === "user") run.userAnswer = { questionId: question.id, text, at, acknowledged: false };
		else delete run.userAnswer;
		question.answer(text);
		const next = run.questions[0];
		return { ok: true, question, ...(next ? { next } : {}) };
	};

	/**
	 * Raises the records' highest handle over the runs of this Pi process and the ones the history kept, so a new run
	 * never takes the name of a run that ended in no branch entry, which is what a Pi process killed mid-run leaves.
	 */
	const coverLiveHandles = (records: RunRecords): RunRecords => {
		for (const handle of [...runs.keys(), ...historical.keys()]) records.highest = Math.max(records.highest, handleNumber(handle));
		return records;
	};

	/** What a handle names now: a run of this Pi process, a run an earlier one left in the history, or neither. */
	const found = (handle: string, ctx: any): { run: LiveRun } | { held: HistoryRecord; branch?: RunRecord } | { gone: RunRecord } | { unknown: true } => {
		const run = runs.get(handle);
		if (run) return { run };
		const branch = branchRuns(ctx).get(handle);
		// A run its Pi process never saw end recorded no entry, so the history is all that still names it.
		if (!branch) {
			const held = historical.get(handle);
			return held ? { held } : { unknown: true };
		}
		const held = heldRun(handle, branch, ctx);
		return held ? { held, branch } : { gone: branch };
	};

	/** A run's last report, from this Pi process or from the history an earlier one left, for a plan handoff to carry. */
	const lastReport = (handle: string): string | undefined => {
		const live = runs.get(handle)?.report?.trim();
		if (live) return live;
		return historical.get(handle)?.report?.trim() || undefined;
	};

	/** The callback that records a finished run's session on the host branch, so a later call can continue it. */
	const recordRun =
		(call: { handle: string; role: Role; hostSessionId: string; session: ChildSession; prior?: RunRecord }) =>
		(child: ChildRun): void => {
			const { handle, role, hostSessionId, session } = call;
			const entry: Record<string, unknown> = { run: handle, role: role.name, hostSessionId };
			if (role.mode) entry.mode = role.mode;
			if (!child.sessionId) {
				if (!call.prior) pi.appendEntry(SESSION_ENTRY, entry);
				return;
			}
			const ok = !failed(child);
			if (session.kind === "resume" && !ok) return;
			entry.sessionId = child.sessionId;
			const checkpoint = (ok && child.checkpoint) || (session.kind === "fork" ? session.at : undefined);
			if (checkpoint) entry.checkpoint = checkpoint;
			if (ok && child.contextTokens && child.contextWindow) {
				entry.contextTokens = child.contextTokens;
				entry.contextWindow = child.contextWindow;
			}
			pi.appendEntry(SESSION_ENTRY, entry);
		};

	/** Adds a call's latest counters to the session ledger and warns the user once at each threshold the total passes. */
	const meter = (run: LiveRun, usage: CallUsage, ctx: any): void => {
		record(() => ledger.update(run.id, usage));
		for (let threshold = ledger.nextWarning(); threshold !== undefined; threshold = ledger.nextWarning()) {
			try {
				ctx.ui.notify(
					`fusion: the claude runs of this Pi session have cost an estimated ${formatUsd(ledger.totals().costUsd)} so far, past the ${formatUsd(threshold)} warning threshold (list prices; the estimate updates when a child turn ends, so it lags)`,
					"warning",
				);
			} catch {
				return;
			}
			ledger.markWarned(threshold);
		}
	};

	const startRun = async (call: {
		/** The Pi tool that started the run and the id of its call, when a tool did. */
		tool?: string;
		toolCallId?: string;
		role: Role;
		handle: string;
		prompt: string;
		origin: RunOrigin;
		/** For a review run, the handle of the run it reviews. */
		reviews?: string;
		/** What the host reads with the run's outcome, over the child's own report. */
		note?: string;
		session: ChildSession;
		title: string;
		background: boolean;
		onUpdate: LiveRun["onUpdate"];
		ctx: any;
		onRun: (run: ChildRun) => void;
	}): Promise<LiveRun> => {
		const { toolCallId, role, handle, prompt, session, title, ctx } = call;
		let hostSessionId: string | undefined;
		try {
			hostSessionId = ctx.sessionManager?.getSessionId() || undefined;
		} catch {}
		const run: LiveRun = {
			id: randomUUID(),
			handle,
			role,
			prompt,
			origin: call.origin,
			...(call.reviews === undefined ? {} : { reviews: call.reviews }),
			...(call.note === undefined ? {} : { note: call.note }),
			...(call.tool === undefined ? {} : { tool: call.tool }),
			...(toolCallId === undefined ? {} : { toolCallId }),
			...(hostSessionId === undefined ? {} : { hostSessionId }),
			title,
			session,
			background: call.background,
			started: Date.now(),
			state: "running",
			input: new ChildInput(),
			controller: new AbortController(),
			cancelled: false,
			cwd: ctx.cwd,
			questions: [],
			delivered: false,
			waiters: new Set(),
			watchers: new Set(),
			finished: false,
			...(call.onUpdate ? { onUpdate: call.onUpdate } : {}),
			ended: Promise.resolve(),
		};
		runs.set(handle, run);
		const id = run.id;
		record(() =>
			store.start({
				id,
				handle,
				role: role.name,
				model: role.model,
				...(toolCallId === undefined ? {} : { toolCallId }),
				...(call.tool === undefined ? {} : { tool: call.tool }),
				origin: call.origin,
				...(call.reviews === undefined ? {} : { reviews: call.reviews }),
				...(hostSessionId === undefined ? {} : { hostSessionId }),
				prompt,
				contract: `contracts/${role.contract}`,
				title,
				session,
				...(call.background ? { background: true } : {}),
			}),
		);
		saveHistory(ctx, run.hostSessionId, historyRecord(run, "running"));
		render();
		/** The claude_control message that answered the last question returns the next one, so that one gets no notice. */
		const opened = (announce: boolean) => {
			run.state = "waiting";
			record(() => store.question(id, run.questions[0]!.text));
			render();
			if (!settle(run) && announce && run.background && !shuttingDown) notify(run, askedText(run));
		};
		const onQuestion: Ask = (text, signal) =>
			new Promise<string>((resolve, reject) => {
				if (signal.aborted) return reject(new Error(`${role.name} stopped`));
				const onAbort = () => question.drop(new Error(`${role.name} stopped`));
				const question: OpenQuestion = {
					id: randomUUID(),
					text,
					answer: (reply) => {
						signal.removeEventListener("abort", onAbort);
						resolve(reply);
						if (run.questions.length) opened(false);
						else {
							run.state = "running";
							record(() => store.question(id, undefined));
							render();
						}
					},
					drop: (error) => {
						signal.removeEventListener("abort", onAbort);
						run.questions = run.questions.filter((open) => open !== question);
						reject(error);
					},
				};
				signal.addEventListener("abort", onAbort, { once: true });
				// A new question is not the one the user answered, so their answer no longer describes the run.
				delete run.userAnswer;
				run.questions.push(question);
				if (run.questions.length === 1) opened(true);
			});
		const before = role.name === "ask" ? undefined : await snapshot(ctx.cwd);
		run.before = before;
		/** Monitoring only: a git failure leaves the file list out and never fails the run. */
		const files = async () => {
			const after = before && (await snapshot(ctx.cwd));
			if (!before || !after) return {};
			try {
				return { files: await changedFiles(before, after) };
			} catch {
				return {};
			}
		};
		/** What the run had spent when the history last took it, so a Pi process killed mid-run loses little of its cost. */
		let spent = { at: 0, tokens: 0 };
		const saveSpend = () => {
			const tokens = (run.latest?.tokensIn ?? 0) + (run.latest?.tokensOut ?? 0);
			const now = Date.now();
			if (tokens === spent.tokens && now - spent.at < HISTORY_SPEND_MS) return;
			spent = { at: now, tokens };
			saveHistory(ctx, run.hostSessionId, historyRecord(run, run.state, run.latest));
		};
		run.ended = (async () => {
			try {
				let child: ChildRun;
				try {
					child = await runChild({
						role,
						prompt,
						cwd: ctx.cwd,
						session,
						title,
						signal: run.controller.signal,
						input: run.input,
						onQuestion,
						onProgress: (progress) => {
							run.latest = progress;
							meter(run, progress, ctx);
							record(() => store.progress(id, progress));
							saveSpend();
							render();
						},
						onEvent: (event) => record(() => store.event(id, event)),
					});
				} catch (error) {
					run.failure = error instanceof Error ? error.message : String(error);
					run.state = "failed";
					const changed = await files();
					if (changed.files) run.files = changed.files;
					record(() => store.finish(id, { status: "failed", failure: run.failure!, ...changed }));
					return;
				}
				meter(run, child, ctx);
				const failure = run.cancelled ? `${role.name} cancelled${run.cancelledBy === "user" ? " by the user" : ""}` : failed(child) ? failureMessage(child) : undefined;
				run.state = run.cancelled ? "cancelled" : child.aborted ? "aborted" : failure !== undefined ? "failed" : "done";
				run.report = child.text;
				run.stats = stats(handle, child);
				if (failure !== undefined) run.failure = failure;
				const changed = await files();
				if (changed.files) run.files = changed.files;
				record(() => store.finish(id, { status: run.state as Exclude<RunState, "running" | "waiting">, text: child.text, ...(failure === undefined ? {} : { failure }), snapshot: child, ...changed }));
				try {
					call.onRun(child);
				} catch {}
			} finally {
				for (const question of [...run.questions]) question.drop(new Error(`${role.name} ended`));
				run.endedAt = Date.now();
				saveHistory(ctx, run.hostSessionId, historyRecord(run, run.state, run.latest));
				render();
				// Before the run settles, so the report the host reads already names the review that reads the same tree.
				record(() => startAutoReview(run, ctx));
				const heard = settle(run);
				if (run.background && !heard && !run.delivered && !shuttingDown) notify(run, finalText(run));
				run.finished = true;
			}
		})();
		return run;
	};

	/** Why the live run cannot be reviewed, or undefined when it can be. */
	const notReviewable = (run: LiveRun): string | undefined => reviewable({ state: run.state, role: run.role.name, ...(run.files ? { files: run.files } : {}) });

	/** The run a review reads: one this Pi process started, or one an earlier process left in the history. */
	const liveSource = (run: LiveRun, ctx: any): ReviewTarget => ({
		handle: run.handle,
		role: run.role.name,
		state: run.state,
		prompt: run.prompt,
		...(run.report === undefined ? {} : { report: run.report }),
		...(run.failure === undefined ? {} : { failure: run.failure }),
		...(run.files === undefined ? {} : { files: run.files }),
		markReviewed: (handle) => {
			run.reviewedBy = handle;
			record(() => store.reviewed(run.id, handle));
			saveHistory(ctx, run.hostSessionId, historyRecord(run, run.state, run.latest));
		},
	});

	const heldSource = (held: HistoryRecord, ctx: any): ReviewTarget => ({
		handle: held.handle,
		role: held.role,
		state: held.state,
		prompt: held.prompt,
		...(held.cwd === ctx.cwd ? {} : { madeIn: held.cwd }),
		...(held.report === undefined ? {} : { report: held.report }),
		...(held.failure === undefined ? {} : { failure: held.failure }),
		...(held.files === undefined ? {} : { files: held.files }),
		markReviewed: (handle) => {
			held.reviewedBy = handle;
			saveHistory(ctx, held.hostSessionId, held);
		},
	});

	/**
	 * Starts an independent review of a run that has ended: a background ask child that the run never briefed. It
	 * checks and takes its handle synchronously, before startRun's first await, so the run it returns is already in
	 * `runs` and no other run can take the same handle in between.
	 */
	const startReview = (source: ReviewTarget, origin: "review" | "auto-review", ctx: any): { run: LiveRun } | { refused: string } => {
		if (source.madeIn) return { refused: `${source.handle} was made in ${source.madeIn}, not in this working directory; review it from there` };
		const reason = reviewable({ state: source.state, role: source.role, ...(source.files ? { files: source.files } : {}) });
		if (reason) return { refused: `${source.handle} ${reason}` };
		const blocked = ledger.blocked();
		if (blocked) return { refused: budgetBlockMessage(blocked) };
		const handle = `run-${coverLiveHandles(runRecords(ctx.sessionManager.getBranch())).highest + 1}`;
		const role = roleFor({ role: "ask", task: "", mode: "review" });
		const hostSessionId: string = ctx.sessionManager.getSessionId();
		const session: ChildSession = { kind: "new", id: randomUUID() };
		const prompt = reviewPrompt({
			handle: source.handle,
			role: source.role,
			state: source.state === "done" ? "done" : "failed",
			task: source.prompt,
			report: source.report ?? "",
			...(source.failure === undefined ? {} : { failure: source.failure }),
			files: source.files ?? [],
		});
		// Nobody awaits a review, so a failure in its start reaches the user as a notice, not an unhandled rejection.
		void startRun({
			tool: `fusion ${origin}`,
			role,
			handle,
			prompt,
			origin,
			reviews: source.handle,
			session,
			title: `pi-fusion ${handle} ask review of ${source.handle} · host ${hostSessionId}`,
			background: true,
			onUpdate: undefined,
			ctx,
			onRun: recordRun({ handle, role, hostSessionId, session }),
		}).catch((error) => {
			record(() => ctx.ui.notify(`fusion: ${handle} did not start: ${error instanceof Error ? error.message : String(error)}`, "warning"));
		});
		// A start that threw before it registered its run left nothing behind, so the source keeps no link to it.
		const started = runs.get(handle);
		if (!started) return { refused: `${handle} could not start` };
		source.markReviewed(handle);
		return { run: started };
	};

	/** The review a run that changed files gets on its own, when the user turned automatic reviews on. */
	const startAutoReview = (run: LiveRun, ctx: any): void => {
		if (!autoReview || run.origin !== "tool" || run.state !== "done" || run.reviewedBy || shuttingDown) return;
		if (notReviewable(run)) return;
		const started = startReview(liveSource(run, ctx), "auto-review", ctx);
		if ("refused" in started) ctx.ui.notify(`fusion: auto-review of ${run.handle} did not start: ${started.refused}`, "warning");
	};

	/** The finished result of a foreground run, as the claude tool returns it. */
	const outcome = (run: LiveRun) => {
		if (run.state !== "done") throw new Error(run.stats ? `${run.failure}\n\n[${run.stats}]` : run.failure);
		const child = run.latest;
		const reviewed = run.reviewedBy ? `\n\n${reviewLine(run.reviewedBy)}` : "";
		const note = run.note ? `${run.note}\n\n` : "";
		return {
			content: [{ type: "text" as const, text: `${note}${run.report?.trim() || "(no output)"}\n\n[${run.stats}]${reviewed}` }],
			details: {
				...runDetails(run),
				handle: run.handle,
				role: run.role.name,
				model: run.role.model,
				...(run.reviewedBy ? { reviewedBy: run.reviewedBy } : {}),
				ms: (run.endedAt ?? Date.now()) - run.started,
				toolCalls: child?.toolCalls,
				tokensIn: child?.tokensIn,
				tokensOut: child?.tokensOut,
				workflowTokens: child?.workflowTokens,
				deniedTools: child?.deniedTools,
				sessionId: child?.sessionId,
				sessionUsage: ledger.totals(),
			},
		};
	};

	/** Monitoring only: what a running run has changed, sampled at most every FILE_SAMPLE_MS and never waited for. */
	const sampleFiles = (run: LiveRun): void => {
		if (!run.before || run.files) return;
		const now = Date.now();
		if (run.filesSampledAt !== undefined && now - run.filesSampledAt < FILE_SAMPLE_MS) return;
		run.filesSampledAt = now;
		void currentFiles(run)
			.then((files) => {
				if (files) run.filesSampled = files;
			})
			.catch(() => {});
	};

	const currentFiles = async (run: LiveRun): Promise<ChangedFile[] | undefined> => {
		if (run.files || !run.before) return run.files;
		try {
			const after = await snapshot(run.cwd);
			return after ? await changedFiles(run.before, after) : undefined;
		} catch {
			return undefined;
		}
	};

	/** What claude_control status reports about one run. */
	const runStatus = async (run: LiveRun): Promise<string[]> => {
		const lines = [statusLine(run)];
		if (run.state === "running" && run.latest?.activity) lines.push(`activity: ${run.latest.activity}`);
		lines.push(`tool calls: ${run.latest?.toolCalls ?? 0}`);
		const files = await currentFiles(run);
		if (files) lines.push(files.length ? `changed files:\n${files.map((file) => `${file.status} ${file.path}`).join("\n")}` : "changed files: none");
		return lines;
	};

	/** What the runs of this Pi session have cost so far, with the thresholds that act on it, for /fusion status. */
	const usageLine = (): string => {
		const totals = ledger.totals();
		const parts = [
			`session usage: est. ${formatUsd(totals.costUsd)} · in ${formatTokens(totals.tokensIn)} out ${formatTokens(totals.tokensOut)} tokens · workflow agents ${formatTokens(totals.workflowTokens)} tokens · ${totals.calls} calls`,
		];
		if (ledger.config.warnUsd.length) parts.push(`warn at ${ledger.config.warnUsd.map((threshold) => formatUsd(threshold)).join(", ")}`);
		if (ledger.config.limitUsd !== undefined) parts.push(`limit ${formatUsd(ledger.config.limitUsd)}`);
		return parts.join(" · ");
	};

	/** The dismissals of the /fusion waits now on screen, so a closing session can take them down. */
	const waits = new Set<() => void>();

	/** Shows the run's activity until it settles or the user presses Esc, which it reports as true. */
	const watchInTui = (run: LiveRun, ctx: any): Promise<boolean> =>
		ctx.ui.custom((tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, _keybindings: unknown, done: (escaped: boolean) => void) => {
			const stop = new AbortController();
			const ticker = setInterval(() => tui.requestRender(), TICK_MS);
			ticker.unref();
			const finish = (escaped: boolean) => {
				if (stop.signal.aborted) return;
				stop.abort();
				clearInterval(ticker);
				waits.delete(dismiss);
				done(escaped);
			};
			const dismiss = () => finish(false);
			waits.add(dismiss);
			void watched(run, stop.signal).then((heard) => {
				if (heard) finish(false);
			});
			return {
				render: (width: number) => [truncateToWidth(activityLine(run), width), truncateToWidth(theme.fg("dim", `Esc leaves ${run.handle} running`), width)],
				handleInput: (data: string) => {
					if (matchesKey(data, "escape")) finish(true);
				},
				invalidate: () => {},
				dispose: () => clearInterval(ticker),
			};
		});

	/**
	 * The runs of earlier Pi processes this branch can still name, oldest handle first, without the ones now live. A
	 * handle the branch gave another child is that child's; a handle the branch never recorded is the history's alone,
	 * because a run whose Pi process died in flight recorded nothing.
	 */
	const heldRuns = (ctx: any): HistoryRecord[] => {
		if (!historical.size) return [];
		const branch = branchRuns(ctx);
		return [...historical.values()]
			.filter((held) => {
				const record = branch.get(held.handle);
				return !runs.has(held.handle) && (record === undefined || sameChild(held, record));
			})
			.sort((left, right) => handleNumber(left.handle) - handleNumber(right.handle));
	};

	/** The working directory of the last call, or undefined when the host cannot say, because a completion must not fail. */
	const lastCwd = (): string | undefined => {
		try {
			return lastCtx?.cwd;
		} catch {
			return undefined;
		}
	};

	/** The handles a /fusion argument can still name: any for status, active for cancel and wait, running for steer, waiting for answer, reviewable for review. Status and review also name the runs an earlier Pi process left. */
	const completable = (kind: string): string[] => {
		const handles = (list: LiveRun[]) => list.map((run) => run.handle);
		const held = lastCtx ? heldRuns(lastCtx) : [];
		if (kind === "status") return [...handles([...runs.values()]), ...held.map((run) => run.handle)];
		if (kind === "steer") return handles([...runs.values()].filter((run) => run.state === "running"));
		if (kind === "answer") return handles([...runs.values()].filter((run) => run.state === "waiting"));
		if (kind === "review") {
			// A review of an earlier process's run reads the tree that run changed, so only one made here is offered.
			const here = lastCwd();
			const offered = held.filter((run) => run.cwd === here && heldNotReviewable(run) === undefined);
			return [...handles([...runs.values()].filter((run) => notReviewable(run) === undefined)), ...offered.map((run) => run.handle)];
		}
		return handles(active());
	};

	pi.registerCommand("fusion", {
		description: "Open or close the pi-fusion dashboard, or check, cancel, steer, answer, review and wait for claude runs",
		getArgumentCompletions: (prefix: string) => {
			const named = RUN_ARG.exec(prefix);
			if (named) {
				const kind = named[1];
				const matches = completable(kind).filter((handle) => handle.startsWith(named[2]));
				return matches.length ? matches.map((handle) => ({ value: `${kind} ${handle}`, label: `${kind} ${handle}` })) : null;
			}
			const items = FUSION_ARGS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			ui = ctx.ui;
			ensureHistory(ctx);
			noteBudget(ctx);
			/** Every notice /fusion shows: a child's report, activity, question or changed path reaches most of them. */
			const notice = (text: string, level: "info" | "warning" | "error") => ctx.ui.notify(plainText(text), level);
			const command = parseFusion(args);
			if (command.kind === "usage") {
				notice(command.message, "warning");
				return;
			}
			if (command.kind === "dashboard") {
				let running: Dashboard;
				try {
					running = await openDashboard(ctx.cwd);
				} catch (error) {
					notice(`fusion: the dashboard did not start: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				notice(`fusion dashboard: ${running.url}`, "info");
				if (process.env.PI_FUSION_DASHBOARD_OPEN !== "0") openInBrowser(running.url);
				return;
			}
			if (command.kind === "dashboard-stop") {
				notice((await closeDashboard()) ? "fusion: dashboard closed" : "fusion: the dashboard is not running", "info");
				return;
			}
			/** The live run a handle names, or undefined once the user has been told what became of it. */
			const live = (handle: string): LiveRun | undefined => {
				const what = found(handle, ctx);
				if ("run" in what) return what.run;
				if ("held" in what) notice(heldText(what.held, what.branch !== undefined, ctx.cwd), "info");
				else if ("gone" in what) notice(`${handle} (${what.gone.role}) ran before this Pi process started and is not active; continue it with claude and continue ${handle}`, "info");
				else notice(`unknown run ${handle}; runs in this Pi session: ${[...runs.keys()].join(", ") || "none"}`, "warning");
				return undefined;
			};
			if (command.kind === "status") {
				if (command.handle === undefined) {
					const all = [...runs.values()];
					const earlier = heldRuns(ctx).map((held) => `${held.handle} · ${held.role} · ${held.model} · ${held.state} · earlier Pi process`);
					notice([...(all.length ? all.map(statusLine) : ["no claude runs in this Pi session yet"]), ...earlier, usageLine()].join("\n"), "info");
					return;
				}
				const run = live(command.handle);
				if (!run) return;
				const lines = await runStatus(run);
				if (run.latest?.sessionId) lines.push(`claude --resume ${run.latest.sessionId}`);
				notice(lines.join("\n"), "info");
				return;
			}
			if (command.kind === "answer") {
				/** The one run waiting for an answer, or undefined once the user has been told there is none or more than one. */
				const sole = (): LiveRun | undefined => {
					const open = [...runs.values()].filter((entry) => entry.state === "waiting");
					if (!open.length) {
						notice("no run is waiting for an answer", "info");
						return undefined;
					}
					if (open.length > 1) {
						notice(`several runs are waiting for an answer: ${open.map((entry) => entry.handle).join(", ")}; name one with /fusion answer run-N [text]`, "warning");
						return undefined;
					}
					return open[0];
				};
				const run = command.handle === undefined ? sole() : live(command.handle);
				if (!run) return;
				const question = run.questions[0];
				if (run.state !== "waiting" || !question) {
					// An abort takes the run's questions away before its end lands, so only the end names the state.
					if (!question && run.controller.signal.aborted) await run.ended;
					notice(`${run.handle} is not waiting for an answer (state: ${run.state})`, "warning");
					return;
				}
				let text = command.text;
				if (text === undefined) {
					if (ctx.hasUI === false || typeof ctx.ui.editor !== "function") {
						notice(`${run.handle} needs the answer on the command line: /fusion answer ${run.handle} <text>`, "warning");
						return;
					}
					const typed = await ctx.ui.editor(plainText(`Answer ${run.handle}: ${firstLine(question.text)}`));
					if (!typed?.trim()) {
						notice(`answer cancelled; ${run.handle} still waits`, "info");
						return;
					}
					text = typed.trim();
				}
				// The run can move on while the editor is open, so only the question that was read is answered.
				const sent: Answered = run.questions[0]?.id === question.id ? answer(run, text, "user") : { ok: false };
				if (!sent.ok) {
					const already = question.answered;
					// The same abort window: the run reads as active with its questions gone until its end lands.
					if (!already && run.controller.signal.aborted) await run.ended;
					const why = already
						? `${run.handle}'s question was already answered by the ${already.by}: ${already.text}`
						: isActive(run)
							? `${run.handle} moved on to another question`
							: `${run.handle} has ended: ${run.state}`;
					notice(`${why}; your answer was not sent`, "warning");
					return;
				}
				const next = sent.next ? `\nIt has another question: ${firstLine(sent.next.text)}` : "";
				notice(`answer sent to ${run.handle}; the child goes on${next}`, "info");
				send(
					{
						customType: NOTICE_TYPE,
						content: `The user answered ${run.handle} (${run.role.name}): ${text}\n\nQuestion: ${firstLine(question.text)}`,
						display: true,
						details: { handle: run.handle, role: run.role.name, state: run.state, kind: "answer", by: "user", questionId: question.id },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
				// The answer uncovered a question the host has not heard, and the answer message on its own starts no turn.
				if (sent.next && run.background && !shuttingDown) notify(run, askedText(run));
				return;
			}
			if (command.kind === "review") {
				const what = found(command.handle, ctx);
				// A run whose state has just turned terminal has no file list until its end path lands, and a review reads one.
				if ("run" in what && !isActive(what.run) && !what.run.finished) await what.run.ended;
				const source = "run" in what ? liveSource(what.run, ctx) : "held" in what ? heldSource(what.held, ctx) : undefined;
				if (!source) {
					// There is nothing to review: live() says what became of the handle, or that nobody here knows it.
					live(command.handle);
					return;
				}
				const started = startReview(source, "review", ctx);
				if ("refused" in started) {
					notice(started.refused, "warning");
					return;
				}
				const handle = started.run.handle;
				notice(`${handle} reviews ${source.handle} in the background; its report arrives as a message`, "info");
				send(
					{
						customType: NOTICE_TYPE,
						content: `The user started ${handle}, an independent review of ${source.handle}; its report arrives when it ends.`,
						display: true,
						details: { handle, role: "ask", state: "running", kind: "review", by: "user", reviews: source.handle },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
				return;
			}
			const run = live(command.handle);
			if (!run) return;
			if (command.kind === "cancel") {
				if (!isActive(run)) {
					notice(`${run.handle} has already ended: ${run.state}`, "info");
					return;
				}
				run.cancelled = true;
				run.cancelledBy = "user";
				run.controller.abort();
				// run.ended is a resolved placeholder until the run's child starts, so the end signal is what to wait on.
				await watched(run);
				await run.ended;
				notice(`${run.handle} cancelled`, "info");
				return;
			}
			if (command.kind === "steer") {
				if (run.state === "waiting") {
					notice(`${run.handle} is waiting for an answer, not a steer; answer it with /fusion answer ${run.handle} <text>`, "warning");
					return;
				}
				if (!isActive(run)) {
					notice(`${run.handle} has ended: ${run.state}; nothing was sent`, "warning");
					return;
				}
				if (!run.input.push(command.text)) {
					notice(`${run.handle} no longer takes input`, "warning");
					return;
				}
				notice(`steer sent to ${run.handle}; the child reads it when it next takes input`, "info");
				send(
					{
						customType: NOTICE_TYPE,
						content: `The user steered ${run.handle} (${run.role.name}): ${command.text}`,
						display: true,
						details: { handle: run.handle, role: run.role.name, state: run.state, kind: "steer", by: "user" },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
				return;
			}
			if (!isActive(run)) {
				await run.ended;
				notice(finalText(run), "info");
				return;
			}
			let escaped = false;
			if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") escaped = await watchInTui(run, ctx);
			else await watched(run);
			if (shuttingDown) return;
			if (escaped) {
				notice(`stopped waiting; ${run.handle} goes on`, "info");
				return;
			}
			if (run.state === "waiting") {
				notice(`${run.handle} asks: ${firstLine(run.questions[0]?.text ?? "")}. Answer it with /fusion answer ${run.handle} <text>`, "warning");
				return;
			}
			await run.ended;
			notice(finalText(run), run.state === "done" ? "info" : "error");
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		record(() => ui?.setWidget?.("fusion", undefined));
		for (const dismiss of [...waits]) dismiss();
		waits.clear();
		for (const run of active()) {
			run.cancelled = true;
			run.controller.abort();
		}
		const unfinished = [...runs.values()].filter((run) => !run.finished);
		await Promise.all([closeDashboard(), ...unfinished.map((run) => run.ended)]);
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		const unfinished = [...runs.values()].filter((run) => !run.finished);
		if (!unfinished.length) return undefined;
		const names = unfinished.map((run) => `${run.handle} (${run.role.name}${isActive(run) ? "" : ", finishing"})`).join(", ");
		ctx.ui.notify(
			`/tree is blocked while claude runs are active: ${names}. A report or run record that arrives after /tree would land on the destination branch. Wait for each run or cancel it with claude_control, then retry /tree.`,
			"warning",
		);
		return { cancel: true };
	});

	pi.registerMessageRenderer(NOTICE_TYPE, (message, options, theme) => {
		const details = cardDetails(message.details);
		const label = NOTICE_LABELS.get(details.kind ?? "") ?? "run";
		const header = headerLine(theme, { label, details, color: "customMessageLabel" });
		return new Card(header, bodyLines(theme, resultText(message.content), { expanded: options.expanded, ...bodyOf(details) }), cardMode(options.expanded));
	});

	pi.registerTool({
		name: TOOL_NAME,
		executionMode: "sequential",
		label: "Claude",
		description:
			"Delegate work to a child: a headless Claude Code session in this working directory. The role picks the job. plan: Claude Fable, which can read the code, run commands and write scratch files, challenges a goal and your proposed plan and consolidates it into an agreed, numbered task list with acceptance criteria. A plan call continues the last plan run, so follow-ups can refer to the earlier agreement, until that run's context passes its cap, when the call starts a fresh plan run carrying the agreed plan and says so; fresh starts a new plan run. implement: Claude Opus implements one clear, bounded task with full tools and reports what changed and how it was verified. If the task needs a broader scope or a design decision, it stops and reports under Escalation instead of widening the task. ultracode: Claude Fable in Claude Code with ultracode on orchestrates Claude Opus 5 agents at xhigh effort, one agent at a time, to implement, verify and review a task, several tasks in dependency order, or a whole agreed plan. It is slower and costlier than implement. ask: Claude Opus with read-only tools (Read, Bash, Grep, Glob, WebSearch, WebFetch) answers a question about the code with file and line references, or with mode review gives an independent review of a change, findings ranked by severity. It has no Edit or Write, and its contract forbids changing files through Bash. Every run gets a handle such as run-3, shown in the stats line. continue with a handle sends the task as a follow-up to that run: the child keeps its context from the run's last successful call, across a resume of this session, /tree and forks. A new run has not seen this conversation, so its task must be self-contained. Calls run one at a time: Pi serializes any turn that contains one. Returns the child's report, or with background true the handle at once and the report later as a message; manage a background run with claude_control. If the child asks a question, the call returns the question at once and the run waits in the background until you answer it with claude_control message. Only one run that can change files is active at a time, waiting included; ask runs can go next to it.",
		promptSnippet: "Delegate planning (plan), bounded implementation (implement), complex, high-risk implementation (ultracode) or read-only questions and reviews (ask) to a Claude Code child",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			role: Type.Optional(stringEnum(ROLE_NAMES, "plan, implement, ultracode or ask. Required unless continue is set.")),
			task: Type.String({
				description:
					"For plan: the goal, your proposed plan, constraints and decisions already made; the child reads the code itself, so do not paste file contents. For implement and ultracode: the task or tasks, agreed or direct: what to change, where, acceptance criteria, and how to verify each one. For ask: the question, or for mode review the change to review (a diff, a commit range or files) and what it must do. With continue: the follow-up message.",
			}),
			continue: Type.Optional(Type.String({ description: "A run's handle, such as run-3: continue that run instead of starting a new one." })),
			context: Type.Optional(Type.String({ description: "Extra context the child needs: decisions, related files, results of earlier tasks." })),
			background: Type.Optional(Type.Boolean({ description: "Return at once with the run's handle and let the run go on; you get its report as a message when it ends. Default false." })),
			fresh: Type.Optional(Type.Boolean({ description: "plan only, not with continue: start a new plan run instead of continuing the last one." })),
			mode: Type.Optional(stringEnum(ASK_MODES, "ask only: answer (default) for a question, review for an independent review of a change. A continued ask run keeps its mode unless this names another.")),
			model: Type.Optional(Type.String({ description: "implement and ask only: a Claude Code model alias or id instead of the role's default." })),
			effort: Type.Optional(stringEnum(EFFORTS, "plan, implement and ask only: the child's effort instead of the role's default.")),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			ui = ctx.ui;
			ensureHistory(ctx);
			noteBudget(ctx);
			// A run whose state has just turned terminal records its branch entry when its end path lands; a continue reads it.
			const finishing = params.continue === undefined ? undefined : runs.get(params.continue);
			if (finishing && !isActive(finishing) && !finishing.finished) await finishing.ended;
			const records = coverLiveHandles(runRecords(ctx.sessionManager.getBranch()));
			const refuseActive = (handle: string | undefined) => {
				if (handle !== undefined && isActive(runs.get(handle))) {
					throw new Error(`${handle} is still active; send it a message with claude_control message, or wait for it with claude_control wait`);
				}
			};
			refuseActive(params.continue);
			const { role, handle, record: prior, handoff } = claudeCall(params, records, planPct);
			refuseActive(handle);
			const busy = role.name === "ask" ? undefined : active().find((run) => run.role.name !== "ask");
			if (busy) {
				throw new Error(`${busy.handle} (${busy.role.name}) is still active; wait for it, message it or cancel it with claude_control before you start or continue another run that can change files`);
			}
			const blocked = ledger.blocked();
			if (blocked) throw new Error(budgetBlockMessage(blocked));
			const background = params.background === true;
			const task = params.context ? `${params.task}\n\n## Context\n${params.context}` : params.task;
			const carried = handoff ? lastReport(handoff.from) : undefined;
			if (handoff && carried === undefined) throw new Error(handoffBlocked(handoff.from, handoff.share));
			const prompt = handoff && carried !== undefined ? handoffPrompt(task, handoff.from, carried) : task;
			const continued = params.continue === undefined ? undefined : handoffShare(prior, planPct);
			const note = handoff
				? handoffNote(handoff.from, handle, handoff.share)
				: continued === undefined
					? undefined
					: continueNote(handle, role.name, continued, planPct);
			const hostSessionId: string = ctx.sessionManager.getSessionId();
			const session = nextSession(prior, hostSessionId);
			const title = `pi-fusion ${handle} ${role.name} · host ${hostSessionId}`;
			/** Only the live run a continued call replaces knows the run it reviews, and the new one keeps naming it. */
			const reviews = params.continue === undefined ? undefined : runs.get(params.continue)?.reviews;
			const run = await startRun({
				tool: TOOL_NAME,
				toolCallId,
				role,
				handle,
				prompt,
				origin: "tool",
				...(reviews === undefined ? {} : { reviews }),
				...(note === undefined ? {} : { note }),
				session,
				title,
				background,
				onUpdate: background ? undefined : onUpdate,
				ctx,
				onRun: recordRun({ handle, role, hostSessionId, session, prior }),
			});
			if (background) {
				return {
					content: [{ type: "text" as const, text: `${note ? `${note}\n\n` : ""}${handle} started in the background; you get the report when it ends` }],
					details: { ...runDetails(run), handle, role: role.name, model: role.model, background: true, sessionUsage: ledger.totals() },
				};
			}
			const onAbort = () => run.controller.abort();
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await settled(run);
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			if (run.state === "waiting") {
				run.background = true;
				delete run.onUpdate;
				return {
					content: [{ type: "text" as const, text: `${note ? `${note}\n\n` : ""}${askedText(run)}` }],
					details: { ...runDetails(run), handle, role: role.name, model: role.model, background: true, state: "waiting", sessionUsage: ledger.totals() },
				};
			}
			await run.ended;
			run.delivered = true;
			return outcome(run);
		},
		renderCall(args, theme, context) {
			const call = (args ?? {}) as Partial<Record<"continue" | "role" | "task", unknown>>;
			const continued = argText(call.continue);
			const target = continued ? `continue ${continued}` : argText(call.role);
			const label = theme.fg("toolTitle", theme.bold(target ? `${TOOL_NAME} ${target}` : TOOL_NAME));
			const task = firstLine(argText(call.task));
			return reuse(context, task ? `${label} ${theme.fg("muted", task)}` : label, [], "truncate");
		},
		renderResult(result, options, theme, context) {
			return resultCard(TOOL_NAME, result, options, theme, context);
		},
	});

	pi.registerTool({
		name: CONTROL_TOOL_NAME,
		executionMode: "sequential",
		label: "Claude control",
		description:
			"Act on the claude runs of this Pi session by handle. A run is running, waiting (its child asked a question and waits for the answer), or has ended. status: without run, list every run with role, model, state, elapsed time and open question; with run, add its current activity, tool call count and, for a run that can change files, the work tree changes seen so far. wait: block until the run ends and return its report, or until it asks a question and return the question; Esc stops the wait, not the run. message: to a waiting run, the answer to its question; to a running child, a steer it reads when it next takes input; to a run that has ended it sends nothing and returns the run's state and a summary of its report, so you can decide to continue the run with claude or take no action. cancel: stop the run.",
		promptSnippet: "Check, wait for, answer, steer or cancel a claude run by its handle",
		parameters: Type.Object({
			action: stringEnum(CONTROL_ACTIONS, "status, wait, message or cancel."),
			run: Type.Optional(Type.String({ description: "The run's handle, such as run-3. Required for every action except status." })),
			message: Type.Optional(Type.String({ description: "message only: the answer to a waiting run's question, or a steer for a running child." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			ui = ctx.ui;
			ensureHistory(ctx);
			noteBudget(ctx);
			const reply = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
			if (!(CONTROL_ACTIONS as readonly string[]).includes(params.action)) {
				throw new Error(`unknown action ${params.action}; use one of ${CONTROL_ACTIONS.join(", ")}`);
			}
			if (params.action === "status" && params.run === undefined) {
				const all = [...runs.values()];
				return reply(all.length ? all.map(statusLine).join("\n") : "no claude runs in this Pi session yet", { usage: ledger.totals() });
			}
			if (params.run === undefined) throw new Error(`${params.action} needs run`);
			if (params.action === "message" && !params.message?.trim()) throw new Error("message needs message");
			const handle = params.run;
			const run = runs.get(handle);
			if (!run) {
				const record = branchRuns(ctx).get(handle);
				const unsent = params.action === "message" ? " The message was not sent." : "";
				// A run its Pi process never saw end recorded no entry, so the history is all that still names it.
				if (!record) {
					const held = historical.get(handle);
					if (!held) throw new Error(`unknown run ${handle}`);
					if (params.action === "status") return reply(heldText(held, false, ctx.cwd), { handle, state: held.state, historical: true });
					return reply(`${handle} (${held.role}) ran in an earlier Pi process and is not active.${unsent} Read it with claude_control status and run ${handle}, or take no action.`, {
						handle,
						state: held.state,
						historical: true,
					});
				}
				const held = params.action === "status" ? heldRun(handle, record, ctx) : undefined;
				if (held) return reply(heldText(held, true, ctx.cwd), { handle, state: held.state, historical: true });
				return reply(`${handle} (${record.role}) ran before this Pi session started and is not active.${unsent} Continue it with claude and continue ${handle}, or take no action.`, { handle, state: "ended" });
			}
			if (params.action === "status") {
				const lines = await runStatus(run);
				const answered = run.userAnswer;
				if (answered) {
					answered.acknowledged = true;
					lines.push(`answered by the user: ${answered.text}`);
				}
				return reply(lines.join("\n"), { ...runDetails(run), handle, state: run.state, usage: ledger.totals() });
			}
			if (params.action === "wait") {
				if (!(await settled(run, signal))) throw new Error(`stopped waiting; ${handle} goes on in the background`);
				const answered = run.userAnswer;
				if (answered) answered.acknowledged = true;
				const answerLine = answered ? `\n\nanswered by the user: ${answered.text}` : "";
				if (run.state === "waiting") return reply(`${askedText(run)}${answerLine}`, { ...runDetails(run), handle, state: run.state });
				// Taken before the run is awaited: a wait that lands while the run is still finishing carries the report too.
				run.delivered = true;
				await run.ended;
				return reply(`${finalText(run)}${answerLine}`, { ...runDetails(run), handle, state: run.state });
			}
			if (params.action === "message") {
				if (run.state === "waiting") {
					const sent = answer(run, params.message!, "host");
					if (sent.ok) {
						const next = sent.next ? `\n\nIt has another question:\n\n${sent.next.text}` : "";
						// The details name the answered question, so the host sees an answer that met a newer one than it read.
						return reply(`answer sent to ${handle}; the child goes on${next}`, { ...runDetails(run), handle, state: run.state, sent: "answer", answered: firstLine(sent.question.text) });
					}
				}
				const answered = run.userAnswer;
				if (run.state === "running" && answered && !answered.acknowledged) {
					answered.acknowledged = true;
					return reply(
						`The user already answered ${handle}'s question with: ${answered.text}. Your message was not sent; the child goes on with the user's answer. If it still applies, send it again with claude_control message and it goes to the child as a steer, or as the answer if it has asked another question by then.`,
						{ ...runDetails(run), handle, state: run.state, sent: "none", answeredBy: "user" },
					);
				}
				if (run.state === "running" && run.input.push(params.message!)) {
					return reply(`steer sent to ${handle}; the child reads it when it next takes input`, { ...runDetails(run), handle, state: run.state, sent: "steer" });
				}
				await run.ended;
				const text = summary(run);
				return reply(
					`${handle} (${run.role.name}) has ended: ${run.state}. The message was not sent.${text ? `\n\nReport summary:\n${text}` : ""}\n\nIf the message still applies, continue the run with claude and continue ${handle}, where you can also set model, effort, context and background. Otherwise take no action.`,
					{ ...runDetails(run), handle, state: run.state, sent: "none" },
				);
			}
			if (!isActive(run)) return reply(`${handle} has already ended: ${run.state}. Nothing to cancel.`, { ...runDetails(run), handle, state: run.state });
			run.cancelled = true;
			run.delivered = true;
			run.controller.abort();
			await run.ended;
			return reply(`${handle} cancelled`, { ...runDetails(run), handle, state: run.state });
		},
		renderResult(result, options, theme, context) {
			const action = typeof context.args?.action === "string" ? ` ${context.args.action}` : "";
			return resultCard(`${CONTROL_TOOL_NAME}${action}`, result, options, theme, context);
		},
	});
}
