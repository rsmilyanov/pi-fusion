import type { Readable, Writable } from "node:stream";
import { ChildTree, type CleanupReport, type ExitOutcome, KILL_GRACE_MS, type LaunchedProcess, type LaunchOptions, type OwnedCleanup } from "../process-tree.ts";
import {
	boundText,
	CODEX_APPROVAL_METHODS,
	CODEX_QUESTION_TOOL,
	CODEX_TOOL_CALL_METHOD,
	type CodexDenial,
	type CodexInitialize,
	type CodexItem,
	type CodexLatestTurn,
	type CodexQuestionCall,
	type CodexRead,
	type CodexReroute,
	type CodexSandboxRequest,
	type CodexThreadRead,
	type CodexThreadResume,
	type CodexThreadStart,
	type CodexThreadStatus,
	type CodexTokenUsage,
	type CodexTurnError,
	type CodexTurnKey,
	type CodexTurnStatus,
	readApproval,
	readErrorNotice,
	readInitialize,
	readItem,
	readQuestionCall,
	readReroute,
	readThreadRead,
	readThreadResume,
	readThreadStart,
	readThreadStatusChanged,
	readTokenUsage,
	readTurnCompleted,
	readTurnStart,
	readTurnStarted,
	readTurnSteer,
	readTurnsList,
} from "./codex-protocol.ts";
import { LineFramer, MAX_TIMER_MS, type PiLine } from "./pi-transport.ts";

/**
 * The Codex transport: one app-server child over stdio, read and written as the JSON-RPC its protocol uses, and the
 * bounds everything that child can make this host hold is cut to. It is a transport and not a backend: it starts the
 * launch it is handed and nothing it found itself, it maps no outcome, writes no record and decides no policy. What it
 * hands back is evidence — a thread's identity and selection as the child reported them, a turn's events correlated
 * by thread and turn id, usage, denials and the child's end — for a backend above it to judge.
 *
 * The wire is JSON-RPC as Codex speaks it, one object per LF-terminated line: a request carries `id` and `method`, a
 * notification `method` alone, a response `id` with `result` or `error`, and the `jsonrpc` member is neither sent nor
 * required. Host request ids are integers this transport counts up from one; a server request's id is the child's and
 * lives in its own namespace, so a response is only ever correlated against what this side issued.
 *
 * The capabilities this build gives a child are deliberately few: it answers every command or file approval with
 * `decline`, and has no answer for anything else the child asks — a question for the user, another dynamic tool, an
 * elicitation — which is answered with a JSON-RPC error and ends the run as unsupported. The one exception is the
 * question tool, and only for a child started with `onQuestion`: that child, and no other, opts into Codex's
 * experimental API at the handshake, for the whole connection, and a fresh thread is registered `ask_orchestrator` as
 * a dynamic tool. A resumed or forked thread is registered nothing — the stable requests take no tools, and Codex
 * restores a thread's tools from its own history — so a question call is answered on any turn this transport owns,
 * whether or not this child registered the tool. There is no navigation and no generic request: the only methods it
 * sends are the handshake, thread/start, turn/start, thread/read and turn/interrupt, and the stable resume, fork,
 * latest-turn and steer foundations — thread/resume, thread/fork, thread/turns/list and turn/steer. Shapes come from
 * `codex-protocol.ts`, read in Codex 0.160.0's source and not measured against a running app-server.
 *
 * **Questions.** An `item/tool/call` naming `ask_orchestrator` is taken only from a live, unfinished turn this
 * transport admitted: one that arrives for its thread before the turn/start answer named the turn is held until that
 * answer, then asked if it names that turn and refused if not. The callback is never awaited on the read loop, so
 * notifications, responses and the turn's end go on being read while a question waits. Each request is answered once:
 * with the host's answer as the tool's one text item, or with `success: false` and one fixed text when the call could
 * not be hosted, the run has no callback, or the question ended unanswered — its turn ended, the host rejected, or the
 * child is being stopped, which aborts the question's own signal. A refusal is the tool's answer and not the run's
 * failure, so the model can go on and report what it lacked. Nothing is retried or resent, and the answer is never
 * kept here.
 *
 * Framing reuses the Pi transport's byte-capped `LineFramer` and nothing else of it; the lifecycle, writer, readers and
 * failures here are this backend's own. The defaults below are bounded and internal: no environment variable, tool
 * argument or configuration file reaches any of them, and tests narrow them to be fast.
 */

/** Every ceiling this transport keeps. Zero is not a value any of them takes. */
export interface CodexBounds {
	/** One inbound frame. A tool item can carry a command's aggregated output, which is why this is far over a message. */
	maxFrameBytes: number;
	/** One outbound frame: a turn's prompt. A frame past it is refused before anything queues it. */
	maxOutboundFrameBytes: number;
	/** One stderr line. Past it the line is counted and dropped, never parsed or kept. */
	maxStderrLineBytes: number;
	/** How much stderr is kept at all: a rolling tail of what the child last wrote. */
	maxStderrTailBytes: number;
	/** Text a child reported that a failure or a report may carry: an error message, a denied command. */
	maxDiagnosticBytes: number;
	/** The last agent message of a turn, as a report keeps it. */
	maxMessageBytes: number;
	/** A thread's developer instructions, refused past it rather than cut: half a contract is not the contract. */
	maxInstructionsBytes: number;
	/** Host requests outstanding at once. */
	maxPendingRequests: number;
	/** Notifications for a turn whose id the turn/start answer has not yet named, held until it does. */
	maxEarlyNotifications: number;
	/** Server request ids this transport answers over its whole life. Nothing is evicted from that count. */
	maxServerRequests: number;
	/** Reroutes, denials and retryable errors one turn's report lists; past it they are counted and not listed. */
	maxRecorded: number;
	/** The spawn through the initialize answer. */
	initializeMs: number;
	/** Every other request, the wait for its frame to be written included. */
	requestMs: number;
	/** One step of a shutdown: the wait for an interrupted turn to end, and for this transport's pipes to close. */
	shutdownStepMs: number;
}

export const CODEX_BOUNDS: Readonly<CodexBounds> = Object.freeze({
	maxFrameBytes: 16 * 1024 * 1024,
	maxOutboundFrameBytes: 8 * 1024 * 1024,
	maxStderrLineBytes: 64 * 1024,
	maxStderrTailBytes: 64 * 1024,
	maxDiagnosticBytes: 4 * 1024,
	maxMessageBytes: 256 * 1024,
	maxInstructionsBytes: 1024 * 1024,
	maxPendingRequests: 16,
	maxEarlyNotifications: 512,
	maxServerRequests: 256,
	maxRecorded: 32,
	initializeMs: 60_000,
	requestMs: 60_000,
	shutdownStepMs: 5_000,
});

const BOUND_FIELDS = Object.keys(CODEX_BOUNDS) as (keyof CodexBounds)[];
const MS_FIELDS: readonly (keyof CodexBounds)[] = ["initializeMs", "requestMs", "shutdownStepMs"];

/** The defaults with whatever a caller named over them, each a positive safe integer and each timer one node can run. */
export function codexBounds(over: Partial<CodexBounds> = {}): CodexBounds {
	const bounds = { ...CODEX_BOUNDS } as CodexBounds;
	for (const field of BOUND_FIELDS) {
		const named = over[field];
		const value = named === undefined ? CODEX_BOUNDS[field] : named;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
		if (MS_FIELDS.includes(field) && value > MAX_TIMER_MS) throw new TypeError(`${field} must be at most ${MAX_TIMER_MS}, which is as long as one timer can run`);
		bounds[field] = value;
	}
	codexWriterCaps(bounds);
	return bounds;
}

/**
 * What the writer may hold, derived from the bounds: one frame per pending request, as many replies to the child's own
 * requests again, and two more for the handshake's notification and a shutdown's interrupt. Bytes are two outbound
 * frames, one being written and one waiting.
 */
export function codexWriterCaps(bounds: Readonly<CodexBounds>): { items: number; bytes: number } {
	const items = 2 * bounds.maxPendingRequests + 2;
	const bytes = 2 * bounds.maxOutboundFrameBytes;
	if (!Number.isSafeInteger(items) || !Number.isSafeInteger(bytes)) throw new TypeError("maxPendingRequests and maxOutboundFrameBytes must leave the writer's caps safe integers");
	return { items, bytes };
}

/* ------------------------------------------------------------------------------------------------------------------
 * Failures
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * What this transport can fail with. `handshake` is a child that never answered initialize usefully. `rejected` is a
 * request the child answered with a JSON-RPC error, which ends that call and not the child. `unsupported` is a request
 * the child made that this build has no answer for: it is refused on the wire and the run fails. `refused` is a call
 * this side would not send — past a cap, for a thread or turn it does not own — and `busy` is a turn already running.
 * `unverified` is a finalization that threw instead of reporting, which claims nothing about the process.
 */
export type CodexFailureKind = "spawn" | "handshake" | "exited" | "protocol" | "timeout" | "closed" | "aborted" | "unstoppable" | "refused" | "busy" | "rejected" | "unsupported" | "unverified";

export interface CodexFailure {
	kind: CodexFailureKind;
	message: string;
	exit?: ExitOutcome;
	/** The JSON-RPC error code of a `rejected` call or a `handshake` the child refused. */
	code?: number;
}

const FAILURE_TEXT: { [kind in CodexFailureKind]: string } = {
	spawn: "the codex app-server could not be started",
	handshake: "the codex app-server did not complete its handshake",
	exited: "the codex app-server exited before its work was done",
	protocol: "the codex app-server sent something this transport cannot read",
	timeout: "the codex app-server did not answer inside its bound",
	closed: "this transport is closed",
	aborted: "the run was cancelled",
	unstoppable: "the codex app-server could not be stopped",
	refused: "this transport would not send this call",
	busy: "the codex app-server already has a turn running",
	rejected: "the codex app-server refused the request",
	unsupported: "the codex app-server asked for something this backend does not support",
	unverified: "the codex app-server's cleanup produced no report, and the state of its process is unverified",
};

/** What may be added to a failure's fixed text. `error` and `excerpt` are child text, always bounded and labelled. */
export interface CodexFailureDetail {
	exit?: ExitOutcome;
	/** One of this module's fixed phrases, or a reader's: never a value that arrived from anywhere. */
	reason?: string;
	code?: number;
	/** The child's own error message, cut to the diagnostic cap. */
	error?: string;
	/** A bounded excerpt of the child's stderr. */
	excerpt?: string;
}

const exitText = (exit: ExitOutcome): string => {
	if (exit.signal !== null) return `signal ${exit.signal}`;
	return exit.code === null ? "no exit code and no signal" : `exit code ${exit.code}`;
};

export function codexFailure(kind: CodexFailureKind, detail: CodexFailureDetail = {}): CodexFailure {
	let message = FAILURE_TEXT[kind];
	if (detail.exit !== undefined) message += ` (${exitText(detail.exit)})`;
	if (detail.reason !== undefined) message += `: ${detail.reason}`;
	if (detail.code !== undefined) message += ` (error ${detail.code})`;
	if (detail.error !== undefined) message += `: ${detail.error}`;
	if (detail.excerpt !== undefined && detail.excerpt.trim()) message += `\n\nChild stderr:\n${detail.excerpt.trimEnd()}`;
	return {
		kind,
		message,
		...(detail.exit === undefined ? {} : { exit: { ...detail.exit } }),
		...(detail.code === undefined ? {} : { code: detail.code }),
	};
}

/** A failure as something thrown. `finalExit` travels on a refused startup, because nobody else holds that child. */
export class CodexTransportError extends Error {
	readonly kind: CodexFailureKind;
	readonly exit?: ExitOutcome;
	readonly code?: number;
	readonly finalExit?: CodexExit;

	constructor(failure: CodexFailure, finalExit?: CodexExit) {
		super(failure.message);
		this.name = "CodexTransportError";
		this.kind = failure.kind;
		if (failure.exit !== undefined) this.exit = failure.exit;
		if (failure.code !== undefined) this.code = failure.code;
		if (finalExit !== undefined) this.finalExit = finalExit;
	}

	get failure(): CodexFailure {
		return { kind: this.kind, message: this.message, ...(this.exit === undefined ? {} : { exit: { ...this.exit } }), ...(this.code === undefined ? {} : { code: this.code }) };
	}
}

/* ------------------------------------------------------------------------------------------------------------------
 * Pure pieces: stderr, envelopes, correlation
 * ---------------------------------------------------------------------------------------------------------------- */

/** Everything kept of a child's stderr: counts and a rolling tail, never a history. Nothing in it is parsed. */
export interface CodexStderrRecord {
	lines: number;
	truncatedLines: number;
	tail: string;
	/** Bytes not held: cut lines whole, and what the tail evicted. Approximate omission accounting, never below zero. */
	dropped: number;
}

/** The last `max` bytes of a text, from a character boundary. */
const keepLastBytes = (text: string, max: number): { text: string; bytes: number } => {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= max) return { text, bytes: buffer.length };
	let at = buffer.length - max;
	while (at < buffer.length && (buffer[at] & 0xc0) === 0x80) at += 1;
	const kept = buffer.subarray(at);
	return { text: kept.toString("utf8"), bytes: kept.length };
};

/**
 * A child's stderr, read through the framer and kept as a bounded tail. Codex writes its own logs here; none of them
 * is a protocol record and none of them decides anything, so a cut line is counted and a whole one only remembered.
 */
export class CodexStderrTail {
	private readonly framer: LineFramer;
	private readonly max: number;
	private tail = "";
	private bytes = 0;
	private evicted = 0;
	private readonly state = { lines: 0, truncatedLines: 0 };
	private ended = false;

	constructor(bounds: Readonly<Pick<CodexBounds, "maxStderrLineBytes" | "maxStderrTailBytes">> = CODEX_BOUNDS) {
		this.framer = new LineFramer(bounds.maxStderrLineBytes, "drop");
		this.max = bounds.maxStderrTailBytes;
	}

	push(chunk: Buffer): void {
		if (this.ended) return;
		for (const line of this.framer.push(chunk)) this.read(line);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const line of this.framer.end()) this.read(line);
	}

	get record(): CodexStderrRecord {
		return { ...this.state, tail: this.tail, dropped: this.framer.counters.dropped + this.evicted };
	}

	private read(line: PiLine): void {
		this.state.lines += 1;
		if (line.truncated) {
			this.state.truncatedLines += 1;
			return;
		}
		const text = `${line.text}\n`;
		this.tail += text;
		this.bytes += Buffer.byteLength(text);
		if (this.bytes <= this.max) return;
		const kept = keepLastBytes(this.tail, this.max);
		this.evicted += this.bytes - kept.bytes;
		this.tail = kept.text;
		this.bytes = kept.bytes;
	}
}

/** One inbound message, by what its members make it. */
export type CodexMessage =
	| { kind: "result"; id: unknown; result: unknown }
	| { kind: "error"; id: unknown; code: number; message: string; cut: boolean }
	| { kind: "request"; id: string | number; method: string; params: unknown }
	| { kind: "notification"; method: string; params: unknown };

/** How long a method name may be before it is no method at all. Codex's are short slash-separated words. */
export const CODEX_METHOD_MAX_CHARS = 128;
const METHOD = /^[A-Za-z0-9_./-]+$/;

/**
 * One parsed json value as a JSON-RPC message, or why it is none. A `jsonrpc` member is tolerated as "2.0" and refused
 * as anything else; an id with a method is the child's request, a method alone a notification, an id alone a response
 * with exactly one of `result` and `error`. A server request's id is a string or an integer, which is all its id can be.
 */
export function readMessage(value: unknown, maxErrorBytes: number = CODEX_BOUNDS.maxDiagnosticBytes): CodexRead<CodexMessage> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "a record from it is not a json object" };
	const record = value as { [key: string]: unknown };
	if ("jsonrpc" in record && record.jsonrpc !== "2.0") return { ok: false, reason: "a record from it names a json-rpc version other than 2.0" };
	if ("method" in record) {
		const method = record.method;
		if (typeof method !== "string" || method === "" || method.length > CODEX_METHOD_MAX_CHARS || !METHOD.test(method)) return { ok: false, reason: "a record from it names a method that is not one" };
		if (!("id" in record)) return { ok: true, value: { kind: "notification", method, params: record.params } };
		const id = record.id;
		if (!(typeof id === "string" && id !== "" && id.length <= CODEX_METHOD_MAX_CHARS) && !(typeof id === "number" && Number.isSafeInteger(id))) return { ok: false, reason: "a request from it carries an id that is not one" };
		return { ok: true, value: { kind: "request", id, method, params: record.params } };
	}
	if (!("id" in record)) return { ok: false, reason: "a record from it is neither a request, a notification nor a response" };
	const hasResult = "result" in record;
	const hasError = "error" in record;
	if (hasResult === hasError) return { ok: false, reason: "a response from it carries both a result and an error, or neither" };
	if (hasResult) return { ok: true, value: { kind: "result", id: record.id, result: record.result } };
	const error = record.error;
	if (typeof error !== "object" || error === null || Array.isArray(error)) return { ok: false, reason: "an error response from it carries no error object" };
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code !== "number" || !Number.isSafeInteger(code) || typeof message !== "string") return { ok: false, reason: "an error response from it carries no code and message" };
	const bounded = boundText(message, maxErrorBytes);
	return { ok: true, value: { kind: "error", id: record.id, code, message: bounded.text, cut: bounded.cut } };
}

/** How a host request ends: with its result, or with the failure that ended it instead. */
export type CodexOutcome = { ok: true; result: unknown } | { ok: false; failure: CodexFailure };

/** What the correlator calls when a request settles, once each: the caller's timer stop, then its settle. */
export interface CodexRequestHooks {
	stopTimer?(): void;
	settle(outcome: CodexOutcome): void;
}

export type CodexIdClass = "pending" | "late" | "impossible";

/**
 * Host ids out, answers back. Ids are integers counted up from one, so a finished id is classifiable from the counter
 * alone and nothing keeps a history: `late` is an id issued and no longer waited on — a timed-out request or an answer
 * repeated — and is counted and dropped; `impossible` is one never issued, which is a protocol failure.
 */
export class CodexCorrelator {
	private readonly max: number;
	private readonly pending = new Map<number, { method: string; hooks: CodexRequestHooks }>();
	private count = 0;

	constructor(maxPending: number = CODEX_BOUNDS.maxPendingRequests) {
		this.max = maxPending;
	}

	get issued(): number {
		return this.count;
	}

	get size(): number {
		return this.pending.size;
	}

	/** The next id, or a `refused` throw when there is no slot to wait on it: a request nothing waits on is not written. */
	issue(method: string, hooks: CodexRequestHooks): number {
		if (this.pending.size >= this.max) throw new CodexTransportError(codexFailure("refused", { reason: "no request slot is free" }));
		this.count += 1;
		this.pending.set(this.count, { method, hooks });
		return this.count;
	}

	classify(id: unknown): CodexIdClass {
		if (typeof id !== "number" || !Number.isSafeInteger(id)) return "impossible";
		if (this.pending.has(id)) return "pending";
		return id >= 1 && id <= this.count ? "late" : "impossible";
	}

	methodOf(id: number): string | undefined {
		return this.pending.get(id)?.method;
	}

	/** Ends one request, once: the record goes before either hook runs, so a second answer finds nothing. */
	settle(id: number, outcome: CodexOutcome): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		entry.hooks.stopTimer?.();
		entry.hooks.settle(outcome);
		return true;
	}

	/** Ends every outstanding request with one failure. Every id is attempted; the first throw comes back out after. */
	settleAll(failure: CodexFailure): number {
		let settled = 0;
		let thrown: { error: unknown } | undefined;
		for (const id of [...this.pending.keys()]) {
			try {
				if (this.settle(id, { ok: false, failure })) settled += 1;
			} catch (error) {
				thrown ??= { error };
			}
		}
		if (thrown) throw thrown.error;
		return settled;
	}
}

/* ------------------------------------------------------------------------------------------------------------------
 * The lifecycle: one child, from the spawn to the exit. Everything below owns a process; nothing above it does.
 * ---------------------------------------------------------------------------------------------------------------- */

/** What the handshake says this client is. Codex records it as the thread's originator; nothing else reads it here. */
export interface CodexClientInfo {
	name: string;
	version: string;
	title?: string;
}

export const CODEX_CLIENT_INFO: Readonly<CodexClientInfo> = Object.freeze({ name: "pi-fusion", title: "Pi-Fusion", version: "0" });

/**
 * What one thread/start sends: the selection a call named, the sandbox mode, the approval policy and the role's
 * developer instructions, and nothing more. No cwd — the launch's process cwd is the thread's, and naming one can make
 * Codex record a trust entry in the user's configuration — no effort, which thread/start does not take, no sandbox
 * policy and no configuration map. `developerInstructions` is a stable field of 0.160.0's `ThreadStartParams` (no
 * experimental marker at rust-v0.160.0, source inspection only) and is how a role's contract reaches the thread.
 */
export interface CodexThreadStartParams {
	model?: string;
	modelProvider?: string;
	sandbox: CodexSandboxRequest;
	approvalPolicy: "never";
	/** The role's shared contract, non-empty and at most `maxInstructionsBytes`. */
	developerInstructions: string;
}

/**
 * What one thread/resume sends: the persisted thread to load and the same fields a thread/start takes, and
 * `excludeTurns: true` beside them, so the answer carries no history this transport would have to hold. The answer
 * must name this very thread; one naming another is refused, never adopted.
 */
export interface CodexThreadResumeParams extends CodexThreadStartParams {
	threadId: string;
}

/**
 * What one thread/fork sends: the source thread, the turn the fork keeps through — inclusive, a persisted turn id the
 * caller verified — the thread/start fields and `excludeTurns: true`. Only the thread the answer names is registered
 * as this transport's; the source is not. Whether that thread is distinct from the source, and the `forkedFromId` it
 * reports, are handed back as reported for the backend to check.
 */
export interface CodexThreadForkParams extends CodexThreadResumeParams {
	lastTurnId: string;
}

/**
 * How one steer ended: the child took the input for the turn it was meant for, or answered with a JSON-RPC error and
 * took nothing. Accepted is delivery, never consumption. A refusal is final: nothing here resends it.
 */
export type CodexSteerResult = { outcome: "accepted" } | { outcome: "refused"; failure: CodexFailure };

/** What one turn/start sends: the thread, the prompt as one text input, and a model and effort a call named. No provider, sandbox policy or configuration. */
export interface CodexTurnStartParams {
	threadId: string;
	text: string;
	model?: string;
	effort?: string;
}

/** Everything one turn reported, correlated by its thread and turn id. A copy, never the live record. */
export interface CodexTurnEvidence {
	threadId: string;
	turnId: string;
	/** A turn/started arrived for it, before or after the turn/start answer. */
	started: boolean;
	/** What turn/completed reported. Absent until it arrives; a transport-ended turn may never have one. */
	completion?: { status: CodexTurnStatus; error: CodexTurnError | null };
	/** The latest usage update for this turn; it may arrive after the completion, which `usageAfterCompletion` counts. */
	usage?: Omit<CodexTokenUsage, "threadId" | "turnId">;
	usageUpdates: number;
	usageAfterCompletion: number;
	retryableErrors: number;
	lastRetryableError?: CodexTurnError;
	terminalErrors: number;
	terminalError?: CodexTurnError;
	/** Per-turn telemetry, listed up to the cap and counted past it. Never the thread's configured selection. */
	reroutes: Omit<CodexReroute, "threadId" | "turnId">[];
	rerouteCount: number;
	/** Approvals this transport declined for this turn, listed up to the cap and counted past it. */
	denials: CodexDenial[];
	denialCount: number;
	items: { started: number; completed: number };
	/** The text of the last completed agent message, bounded. Display, never evidence of success. */
	finalMessage?: { text: string; cut: boolean };
	/** Notifications correlated to this turn, the early ones it was handed included. */
	notifications: number;
}

/**
 * How a turn ended. The first three are the child's own turn/completed; `aborted` is a shutdown or cancellation from
 * this host, `exited` a child that ended under it, and `transport` a turn this transport ended on a protocol failure, a
 * timeout or a request it could not support. Only the first is ever a successful turn, and even that is the child's say.
 */
export interface CodexTurnResult extends CodexTurnEvidence {
	outcome: CodexTurnStatus | "aborted" | "exited" | "transport";
	failure?: CodexFailure;
}

/** One admitted turn, as its caller follows it. */
export interface CodexTurn {
	readonly threadId: string;
	readonly turnId: string;
	/** What the turn reported so far, usage that landed after its completion included. */
	snapshot(): CodexTurnEvidence;
	/** Resolves when the turn ends, however it ends, and never rejects. Usage may still arrive after it. */
	readonly done: Promise<CodexTurnResult>;
}

/** What one child did that a number can say, kept for its exit record. Nothing in the lifecycle branches on these. */
export interface CodexCounters {
	notifications: number;
	/** Notifications naming a method this build does not read. Counted, never forwarded and never evidence. */
	unknownNotifications: number;
	/** Turn-scoped notifications for a thread this transport did not start — a subagent's among them. Not evidence. */
	otherThreadNotifications: number;
	/** Turn-scoped notifications for a turn of an own thread that no turn/start of this transport's named. */
	foreignTurnNotifications: number;
	/** Notifications that arrived before the turn/start answer that named their turn, and were held for it. */
	earlyNotifications: number;
	/** Item notifications whose item could not be read: counted and dropped, and never evidence either way. */
	malformedItems: number;
	lateResponses: number;
	serverRequests: number;
	declinedApprovals: number;
	/** Server requests answered with an error because this build supports nothing they ask for. */
	unsupportedRequests: number;
	/** Question calls handed to `onQuestion`. */
	questions: number;
	/** Question calls answered `success: false` without asking anyone: no callback, or not one this run could host. */
	refusedQuestions: number;
	/** A server request id this transport had already answered, asked again. Not answered twice. */
	duplicateServerRequests: number;
	/** Thrown by `onNotification`, caught so a child is never lost to a caller's own error. */
	listenerErrors: number;
	/** Frames accepted for writing and then dropped unwritten. */
	droppedFrames: number;
	/** How many of the two pipes had not closed when this transport stopped waiting: 0, 1 or 2. */
	streamsUnclosed: number;
}

/**
 * How one child ended, and everything this transport knows about it. `failure` is absent only when this host asked for
 * the stop and the root's own exit bears that out; a root that crashed or exited nonzero while being stopped is still a
 * failure, because asking for a stop is not evidence of how the process actually ended.
 */
export interface CodexExit {
	exit: ExitOutcome;
	cleanup: CleanupReport;
	stderr: CodexStderrRecord;
	failure?: CodexFailure;
	/** Intent: this host began the stop — a shutdown, a cancellation, or a failure this transport ended the child for. */
	stopRequested: boolean;
	/**
	 * Evidence: the root's actual exit was status 0 with no signal, or a signal this tree itself sent. Any other signal —
	 * a crash such as SIGSEGV among them — or a nonzero status is not, whoever asked for the stop.
	 */
	cleanExit: boolean;
	counters: CodexCounters;
	/** Denials that named no turn this transport admitted, the last one only. Each is in `declinedApprovals` too. */
	lastUnmatchedDenial?: CodexDenial;
}

/**
 * A notification as `onNotification` receives it: a method this build reads, and its params untouched. It is display
 * data, unfiltered: it may name another thread (a subagent's), another turn, or a turn not yet admitted. Nothing that
 * decides a run may be read from it — authoritative evidence is an admitted turn's `snapshot()`/`done`, which are scoped
 * to that turn's own thread and turn id, and the readbacks `startThread` and `readThread` answer with. A caller showing
 * progress filters by its own primary thread and turn ids.
 */
export interface CodexNotification {
	method: string;
	params: unknown;
}

/**
 * What one child is started with. `launch` is composed elsewhere and used as it is: nothing here locates a binary,
 * reads `PATH` or defaults to an installed Codex. `cleanup` and `bounds` are internal seams, never user settings.
 */
export interface CodexChildOptions {
	launch: LaunchOptions;
	signal?: AbortSignal;
	killGraceMs?: number;
	cleanup?: OwnedCleanup;
	bounds?: Partial<CodexBounds>;
	clientInfo?: CodexClientInfo;
	/**
	 * Called synchronously, in the child's order, for every well-formed notification of a method this build reads,
	 * whichever thread or turn it names. Display only; see `CodexNotification`.
	 */
	onNotification?: (notification: CodexNotification) => void;
	/**
	 * Answers the child's questions, and rejects when the signal aborts: the backend boundary's own question callback.
	 * Present, it opts this connection into Codex's experimental API and registers the question tool on a fresh thread;
	 * absent, neither happens, and a question call a continued thread still makes is answered `success: false`.
	 */
	onQuestion?: (question: string, signal: AbortSignal) => Promise<string>;
}

/** One app-server child as its caller drives it. Every call is refused once the child is closing or gone. */
export interface CodexChild {
	readonly pid: number;
	/** What the handshake answered: the Codex home and platform the child reports, for a caller to compare. */
	readonly initialize: CodexInitialize;
	readonly counters: CodexCounters;
	/** How this child ended, once it has. Rejects with an `unverified` failure only when its cleanup produced no report. */
	readonly exited: Promise<CodexExit>;
	/** Opens one thread and reads back what it was opened with, exactly as reported: comparing it is the caller's. */
	startThread(params: CodexThreadStartParams, timeoutMs?: number): Promise<CodexThreadStart>;
	/**
	 * Admits one turn on a thread this transport started. The answer names the turn; `done` is what ends it. A JSON-RPC
	 * error answering it is the child's definite refusal: no turn was admitted, and the call rejects `rejected`. No answer
	 * inside the bound is different — a turn may be running that nothing here can name — so the timeout ends this child:
	 * the call rejects `timeout`, the transport closes with that failure, every later call is refused, and a late answer
	 * is only counted. Nothing is retried, replayed or interrupted on a guessed id.
	 */
	startTurn(params: CodexTurnStartParams, timeoutMs?: number): Promise<CodexTurn>;
	/** Loads one persisted thread and reads back what it was loaded with. The answer must name the thread asked for. */
	resumeThread(params: CodexThreadResumeParams, timeoutMs?: number): Promise<CodexThreadResume>;
	/** Forks one persisted thread through one turn, and registers the thread the answer names. Its metadata is reported, not judged. */
	forkThread(params: CodexThreadForkParams, timeoutMs?: number): Promise<CodexThreadResume>;
	/** The newest turn of one own thread, by id and stored status, or none: one thread/turns/list, no items and no history. */
	latestTurn(threadId: string, timeoutMs?: number): Promise<CodexLatestTurn>;
	/**
	 * Sends one turn/steer for one admitted turn still running, once: a JSON-RPC error answering it resolves `refused`
	 * and is never retried. An answer naming another turn is a protocol failure. Accepting a steer changes nothing about
	 * the turn: it is still running, and a second turn/start is still `busy`.
	 */
	steer(turn: CodexTurnKey, text: string, timeoutMs?: number): Promise<CodexSteerResult>;
	/** Reads one own thread's configured selection and status. Notifications the child sent before answering are applied first. */
	readThread(threadId: string, timeoutMs?: number): Promise<CodexThreadRead>;
	/** Asks the child to interrupt one admitted turn. The answer is an acknowledgement; the turn ends with its own completion. */
	interrupt(turn: CodexTurnKey, timeoutMs?: number): Promise<void>;
	/** The latest status a thread/status/changed or thread/read reported for an own thread. */
	threadStatus(threadId: string): CodexThreadStatus | undefined;
	/**
	 * Stops this child and reports how it ended: an admitted turn still running is interrupted and given one bounded
	 * step to end, then stdin is ended and the tree's owned cleanup runs. One shutdown, one answer, however often asked.
	 */
	shutdown(reason?: "host" | "aborted"): Promise<CodexExit>;
}

const OVERSIZED_RECORD = "a record from it is longer than this transport reads";
const NOT_JSON = "a record from it is not json";
const UNKNOWN_ID = "a response from it carries an id this transport never issued";
const TRAILING_RECORD = "its last record was cut off before its end";
const EARLY_OVERFLOW = "it sent more notifications ahead of a turn/start answer than this transport holds";
const SERVER_IDS_EXHAUSTED = "it made more requests than this transport answers";
const REPLY_UNQUEUED = "a reply to one of its requests could not be queued";
const DUPLICATE_COMPLETION = "it completed one turn twice";
const NOT_OWN_THREAD = "the thread is not one this transport started";
const NOT_OWN_TURN = "the turn is not one this transport admitted, or it has ended";
const WRONG_THREAD = "its thread/read answer names another thread";
const WRONG_RESUME = "its thread/resume answer names another thread";
const WRONG_STEER = "its turn/steer answer names another turn";

/** The JSON-RPC code a refused server request is answered with: Codex's own method-not-found. */
export const CODEX_UNSUPPORTED_CODE = -32601;

/** What the model reads about the question tool: the Claude and Pi question tools' own sentence, word for word. */
export const CODEX_QUESTION_DESCRIPTION =
	"Ask the orchestrator that gave you this task for a decision you need to go on, such as a name or a choice between options inside the task's scope. The call waits until the orchestrator answers, which can take a long time; the answer is the result.";

/** The one dynamic tool a fresh thread of a child started with `onQuestion` is registered, and nothing else ever is. */
export const CODEX_QUESTION_TOOL_SPEC = Object.freeze({
	type: "function",
	name: CODEX_QUESTION_TOOL,
	description: CODEX_QUESTION_DESCRIPTION,
	inputSchema: Object.freeze({ type: "object", properties: Object.freeze({ question: Object.freeze({ type: "string" }) }), required: Object.freeze(["question"]) }),
});

/** A question call to a child with no `onQuestion`: a tool its thread kept from an earlier run that this one cannot answer. */
export const CODEX_QUESTION_UNAVAILABLE =
	"no one can answer a question in this run, so this call has no answer; if you cannot go on without the decision, stop and report the question, the options you see and the one you recommend";
/** A question call this transport would not host: not one non-empty question from a running turn of this run's own. */
export const CODEX_QUESTION_REFUSED = "this question was not taken, so nothing was asked: a question is asked only when it is non-empty and comes from this run's own running turn";
/** A question that was asked and ended with no answer: its turn ended, the run is stopping, or the host gave none. */
export const CODEX_QUESTION_UNANSWERED = "the question ended without an answer, because its turn or the run ended first; this call has no answer to report";

/** One question call this transport took, from the request that carried it to its one reply. */
interface OpenQuestion {
	id: string | number;
	key: CodexTurnKey;
	question: string;
	/** The turn it was asked on, once it was: a turn that ends ends its questions. */
	turn?: TurnRecord;
	/** The question's own signal, aborted when this transport ends it rather than the host answering it. */
	controller?: AbortController;
	done: boolean;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const positiveTimer = (what: string, value: number): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${what} must be a positive safe integer`);
	if (value > MAX_TIMER_MS) throw new TypeError(`${what} must be at most ${MAX_TIMER_MS}, which is as long as one timer can run`);
	return value;
};

/** Which kind of frame a queued one is, so a shutdown drops the caller's and keeps its own and the child's replies. */
type WriteKind = "request" | "reply" | "control";

interface WriteItem {
	kind: WriteKind;
	/** The host request id a request or control frame belongs to, so dropping it settles exactly that request. */
	owner?: number;
	text: string;
	bytes: number;
}

/**
 * A bounded FIFO in front of the child's stdin. Full is a refusal, never a wait: a caller waiting for room would be
 * spending its own deadline on a child that is not reading. A `write` that answered false gates every later write
 * until `drain`, and a close or error releases what is queued to its owners rather than leaving it waiting.
 */
class CodexWriter {
	private readonly queue: WriteItem[] = [];
	private stream?: Writable;
	private bytes = 0;
	private blocked = false;
	private shut = false;
	private readonly caps: { items: number; bytes: number };
	private readonly onDropped: (items: WriteItem[]) => void;

	constructor(caps: { items: number; bytes: number }, onDropped: (items: WriteItem[]) => void) {
		this.caps = caps;
		this.onDropped = onDropped;
	}

	attach(stream: Writable | undefined): void {
		if (!stream) {
			this.close();
			return;
		}
		this.stream = stream;
		this.pump();
	}

	get open(): boolean {
		return !this.shut;
	}

	/** True while the pipe has refused more for now: what a test of backpressure looks at, and nothing decides on. */
	get waiting(): boolean {
		return this.blocked;
	}

	get queued(): number {
		return this.queue.length;
	}

	enqueue(item: WriteItem): boolean {
		if (this.shut || this.queue.length >= this.caps.items || this.bytes + item.bytes > this.caps.bytes) return false;
		this.queue.push(item);
		this.bytes += item.bytes;
		this.pump();
		return true;
	}

	drained(): void {
		this.blocked = false;
		this.pump();
	}

	dropUnsent(matches: (item: WriteItem) => boolean): void {
		const dropped: WriteItem[] = [];
		const kept: WriteItem[] = [];
		for (const item of this.queue) (matches(item) ? dropped : kept).push(item);
		if (!dropped.length) return;
		this.queue.length = 0;
		this.queue.push(...kept);
		this.bytes = kept.reduce((total, item) => total + item.bytes, 0);
		this.onDropped(dropped);
	}

	close(): void {
		if (this.shut) return;
		this.shut = true;
		this.blocked = false;
		if (!this.queue.length) return;
		const dropped = this.queue.splice(0, this.queue.length);
		this.bytes = 0;
		this.onDropped(dropped);
	}

	private pump(): void {
		if (!this.stream || this.blocked || this.shut) return;
		while (this.queue.length) {
			if (!this.stream.writable) return;
			const item = this.queue.shift()!;
			this.bytes -= item.bytes;
			let accepted: boolean;
			try {
				accepted = this.stream.write(item.text);
			} catch {
				this.queue.unshift(item);
				this.bytes += item.bytes;
				this.close();
				return;
			}
			if (!accepted) {
				this.blocked = true;
				return;
			}
		}
	}
}

/**
 * One of the child's pipes as this transport reads it, finished at whichever of `end`, `close` or `error` comes first:
 * an owned cleanup destroys a pipe it still holds, and a destroyed pipe closes with no `end` before it.
 */
class CodexPipe {
	private readonly done = deferred<void>();
	private onChunk: (chunk: Buffer) => void;
	private onFinish: () => void;
	private over = false;

	constructor(stream: Readable | undefined, onChunk: (chunk: Buffer) => void, onFinish: () => void) {
		this.onChunk = onChunk;
		this.onFinish = onFinish;
		if (!stream) {
			this.finish();
			return;
		}
		stream.on("data", (chunk: Buffer | string) => {
			if (!this.over) this.onChunk(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
		});
		stream.on("end", () => this.finish());
		stream.on("close", () => this.finish());
		stream.on("error", () => this.finish());
	}

	get finished(): boolean {
		return this.over;
	}

	/** Drops the callbacks and keeps the stream's own listeners reading into nothing, so a live child never blocks on it. */
	abandon(): void {
		this.onChunk = () => {};
		this.onFinish = () => {};
	}

	async closedWithin(ms: number): Promise<boolean> {
		if (this.over) return true;
		let timer: NodeJS.Timeout | undefined;
		const bound = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
		});
		try {
			return await Promise.race([this.done.promise.then(() => true), bound]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private finish(): void {
		if (this.over) return;
		this.over = true;
		this.onFinish();
		this.done.resolve(undefined);
	}
}

/** The live record of one admitted turn. */
interface TurnRecord {
	evidence: CodexTurnEvidence;
	done: boolean;
	/** Fixed by a finalization, so a completion that lands during a shutdown is recorded and never renames the outcome. */
	fixed?: CodexTurnResult["outcome"];
	answer: Deferred<CodexTurnResult>;
}

/** A turn-scoped notification held until the turn/start answer names its turn. */
interface EarlyEvent {
	key: CodexTurnKey;
	apply: (turn: TurnRecord) => void;
}

interface FinalCause {
	reason: "host" | "aborted" | "handshake" | "protocol" | "timeout" | "unsupported" | "exited" | "spawn";
	failure?: CodexFailure;
}

const keyOf = (key: CodexTurnKey): string => JSON.stringify([key.threadId, key.turnId]);

/** The methods this build reads, each to its own handler below. Anything else is counted and ignored. */
const READ_NOTIFICATIONS = new Set([
	"turn/started",
	"turn/completed",
	"error",
	"thread/tokenUsage/updated",
	"model/rerouted",
	"thread/status/changed",
	"item/started",
	"item/completed",
	"thread/started",
	"serverRequest/resolved",
]);

class CodexChildImpl implements CodexChild {
	private readonly bounds: CodexBounds;
	private readonly tree: ChildTree;
	private readonly writer: CodexWriter;
	private readonly correlator: CodexCorrelator;
	private readonly stdoutFramer: LineFramer;
	private readonly stderrTail: CodexStderrTail;
	private readonly options: CodexChildOptions;
	private readonly exitedAt = deferred<CodexExit>();
	private readonly tally: CodexCounters = {
		notifications: 0,
		unknownNotifications: 0,
		otherThreadNotifications: 0,
		foreignTurnNotifications: 0,
		earlyNotifications: 0,
		malformedItems: 0,
		lateResponses: 0,
		serverRequests: 0,
		declinedApprovals: 0,
		unsupportedRequests: 0,
		questions: 0,
		refusedQuestions: 0,
		duplicateServerRequests: 0,
		listenerErrors: 0,
		droppedFrames: 0,
		streamsUnclosed: 0,
	};
	/** Threads this transport started, with the latest status reported for each. */
	private readonly threads = new Map<string, { status?: CodexThreadStatus }>();
	private readonly turns = new Map<string, TurnRecord>();
	/** Every server request id answered, by type and value, for the life of this transport. Nothing is evicted. */
	private readonly serverIds = new Set<string>();
	private readonly stopWaiters: Array<() => void> = [];
	/** Question calls taken and not yet answered, held or asked: each gets its one reply from here. */
	private readonly questions = new Set<OpenQuestion>();
	private state: "starting" | "ready" | "closing" | "ended" = "starting";
	private handle?: LaunchedProcess;
	private out?: CodexPipe;
	private err?: CodexPipe;
	/** The one turn/start in flight, if any, and what arrived for its thread before it was answered. */
	private pendingStart?: { threadId: string; early: EarlyEvent[]; questions: OpenQuestion[] };
	private activeTurn?: TurnRecord;
	private failure?: CodexFailure;
	private lastUnmatchedDenial?: CodexDenial;
	private abortListener?: () => void;
	private ending?: Promise<CodexExit>;
	private exitSeen?: ExitOutcome;
	private spawnRefused = false;
	private stderrDone = false;
	private trailing = false;
	private requestedStop = false;
	private ready = false;
	private childPid = 0;
	private handshake?: CodexInitialize;

	constructor(options: CodexChildOptions, bounds: CodexBounds) {
		this.options = options;
		this.bounds = bounds;
		this.correlator = new CodexCorrelator(bounds.maxPendingRequests);
		this.stdoutFramer = new LineFramer(bounds.maxFrameBytes, "drop");
		this.stderrTail = new CodexStderrTail(bounds);
		this.writer = new CodexWriter(codexWriterCaps(bounds), (items) => this.releaseDropped(items));
		this.tree = new ChildTree(options.killGraceMs ?? KILL_GRACE_MS, options.cleanup ?? {}, { stderr: "stream" });
	}

	get pid(): number {
		return this.childPid;
	}

	get initialize(): CodexInitialize {
		if (!this.handshake) throw new CodexTransportError(codexFailure("closed"));
		return { ...this.handshake };
	}

	get counters(): CodexCounters {
		return { ...this.tally };
	}

	get exited(): Promise<CodexExit> {
		return this.exitedAt.promise;
	}

	/** Spawn, initialize, initialized. A child that fails anywhere in there is finished here and never handed over. */
	async start(): Promise<CodexChild> {
		if (this.options.signal?.aborted) throw await this.startupRefusal({ reason: "aborted", failure: codexFailure("aborted") });
		try {
			this.handle = this.tree.spawn(this.options.launch);
		} catch {
			this.spawnRefused = true;
			throw await this.startupRefusal({ reason: "spawn" });
		}
		// Every listener goes on before the first await, so nothing the child writes in the meantime is missed.
		this.bind();
		const signal = this.options.signal;
		if (signal) {
			this.abortListener = () => this.fail({ reason: "aborted", failure: codexFailure("aborted") });
			signal.addEventListener("abort", this.abortListener, { once: true });
		}
		try {
			const clientInfo = this.options.clientInfo ?? CODEX_CLIENT_INFO;
			// The experimental API is opted into for the whole connection, and only when there is someone to ask.
			const params = { clientInfo: { ...clientInfo }, ...(this.options.onQuestion === undefined ? {} : { capabilities: { experimentalApi: true } }) };
			const result = await this.call("initialize", params, this.bounds.initializeMs, "control", undefined, (failure) => {
				// The handshake's own bound ends the child rather than the call: there is nothing to go on with.
				void this.finalize({ reason: "handshake", failure: codexFailure("handshake", { reason: "it did not answer initialize inside its bound" }) });
				return failure;
			});
			// One stdout chunk can answer initialize and then fail this transport: readiness never reopens a closing child.
			if (this.ending) throw await this.startupRefusal({ reason: "handshake" });
			const read = readInitialize(result);
			if (!read.ok) throw await this.startupRefusal({ reason: "handshake", failure: codexFailure("handshake", { reason: read.reason }) });
			if (!this.notify("initialized")) throw await this.startupRefusal({ reason: "handshake", failure: codexFailure("handshake", { reason: "its initialized notification could not be queued" }) });
			const pid = this.tree.pid;
			if (pid === undefined) throw await this.startupRefusal({ reason: "spawn" });
			this.childPid = pid;
			this.handshake = read.value;
		} catch (error) {
			if (error instanceof CodexTransportError && error.finalExit) throw error;
			// A JSON-RPC error answering initialize is the child refusing the handshake, and says so with its code.
			const failure = error instanceof CodexTransportError && error.kind === "rejected" ? codexFailure("handshake", { reason: "it refused initialize", ...(error.code === undefined ? {} : { code: error.code }) }) : undefined;
			throw await this.startupRefusal({ reason: "handshake", ...(failure ? { failure } : {}) });
		}
		this.ready = true;
		this.state = "ready";
		return this;
	}

	startThread(params: CodexThreadStartParams, timeoutMs?: number): Promise<CodexThreadStart> {
		const refused = this.refusal(timeoutMs);
		if (refused) return Promise.reject(refused);
		const body = this.threadBody(params);
		if (body instanceof Error) return Promise.reject(body);
		// Only a fresh thread is registered the question tool: a continued one keeps the tools its history restores.
		if (this.options.onQuestion !== undefined) body.dynamicTools = [CODEX_QUESTION_TOOL_SPEC];
		return this.call("thread/start", body, timeoutMs ?? this.bounds.requestMs, "request", (result) => {
			const read = this.readOrFail(readThreadStart(result));
			this.threads.set(read.threadId, {});
			return read;
		});
	}

	resumeThread(params: CodexThreadResumeParams, timeoutMs?: number): Promise<CodexThreadResume> {
		const refused = this.refusal(timeoutMs);
		if (refused) return Promise.reject(refused);
		if (typeof params.threadId !== "string" || params.threadId === "") return Promise.reject(new TypeError("threadId is the persisted thread's id"));
		const fields = this.threadBody(params);
		if (fields instanceof Error) return Promise.reject(fields);
		const body = { threadId: params.threadId, ...fields, excludeTurns: true };
		return this.call("thread/resume", body, timeoutMs ?? this.bounds.requestMs, "request", (result) => {
			const read = this.readOrFail(readThreadResume(result, "thread/resume"));
			if (read.threadId !== params.threadId) return this.readOrFail<never>({ ok: false, reason: WRONG_RESUME });
			this.own(read.threadId);
			return read;
		});
	}

	forkThread(params: CodexThreadForkParams, timeoutMs?: number): Promise<CodexThreadResume> {
		const refused = this.refusal(timeoutMs);
		if (refused) return Promise.reject(refused);
		if (typeof params.threadId !== "string" || params.threadId === "") return Promise.reject(new TypeError("threadId is the source thread's id"));
		if (typeof params.lastTurnId !== "string" || params.lastTurnId === "") return Promise.reject(new TypeError("lastTurnId is the persisted turn the fork keeps through"));
		const fields = this.threadBody(params);
		if (fields instanceof Error) return Promise.reject(fields);
		const body = { threadId: params.threadId, lastTurnId: params.lastTurnId, ...fields, excludeTurns: true };
		return this.call("thread/fork", body, timeoutMs ?? this.bounds.requestMs, "request", (result) => {
			const read = this.readOrFail(readThreadResume(result, "thread/fork"));
			this.own(read.threadId);
			return read;
		});
	}

	latestTurn(threadId: string, timeoutMs?: number): Promise<CodexLatestTurn> {
		const refused = this.refusal(timeoutMs);
		if (refused) return Promise.reject(refused);
		if (!this.threads.has(threadId)) return Promise.reject(new CodexTransportError(codexFailure("refused", { reason: NOT_OWN_THREAD })));
		const body = { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" };
		return this.call("thread/turns/list", body, timeoutMs ?? this.bounds.requestMs, "request", (result) => this.readOrFail(readTurnsList(result)));
	}

	steer(turn: CodexTurnKey, text: string, timeoutMs?: number): Promise<CodexSteerResult> {
		const refused = this.refusal(timeoutMs);
		if (refused) return Promise.reject(refused);
		if (typeof text !== "string" || text === "") return Promise.reject(new TypeError("a steer carries non-empty text"));
		const record = this.turns.get(keyOf(turn));
		if (!record || record.done) return Promise.reject(new CodexTransportError(codexFailure("refused", { reason: NOT_OWN_TURN })));
		const body = { threadId: turn.threadId, expectedTurnId: turn.turnId, input: [{ type: "text", text }] };
		const steered = this.call("turn/steer", body, timeoutMs ?? this.bounds.requestMs, "request", (result): CodexSteerResult => {
			const read = this.readOrFail(readTurnSteer(result));
			if (read.turnId !== turn.turnId) return this.readOrFail<never>({ ok: false, reason: WRONG_STEER });
			return { outcome: "accepted" };
		});
		// The child's own refusal is an answer, not a failure of this call; every other end of it still rejects.
		return steered.catch((error: unknown): CodexSteerResult => {
			if (error instanceof CodexTransportError && error.kind === "rejected") return { outcome: "refused", failure: error.failure };
			throw error;
		});
	}

	startTurn(params: CodexTurnStartParams, timeoutMs?: number): Promise<CodexTurn> {
		const refused = this.refusal(timeoutMs);
		if (refused) return Promise.reject(refused);
		if (typeof params.text !== "string") return Promise.reject(new TypeError("a turn is started with the text of its prompt"));
		for (const field of ["model", "effort"] as const) {
			if (params[field] !== undefined && (typeof params[field] !== "string" || params[field] === "")) return Promise.reject(new TypeError(`${field} is a non-empty string when named`));
		}
		if (!this.threads.has(params.threadId)) return Promise.reject(new CodexTransportError(codexFailure("refused", { reason: NOT_OWN_THREAD })));
		if (this.pendingStart || (this.activeTurn && !this.activeTurn.done)) return Promise.reject(new CodexTransportError(codexFailure("busy")));
		const body: Record<string, unknown> = { threadId: params.threadId, input: [{ type: "text", text: params.text }] };
		if (params.model !== undefined) body.model = params.model;
		if (params.effort !== undefined) body.effort = params.effort;
		// Held before the request is written: the child can stream the turn's first notifications ahead of its answer.
		const pending = { threadId: params.threadId, early: [] as EarlyEvent[], questions: [] as OpenQuestion[] };
		this.pendingStart = pending;
		const release = (): void => {
			if (this.pendingStart === pending) this.pendingStart = undefined;
		};
		const unanswered = (failure: CodexFailure): CodexFailure => {
			// Terminal: the child may be running a turn this transport cannot name, so it is not left open for a second
			// start that a native app-server could take as input to that orphaned work. The stop is the ordinary memoized
			// one, with no turn admitted, so nothing is interrupted on a guessed id.
			const ended = codexFailure("timeout", { reason: "it did not answer turn/start inside its bound, so whether a turn is running is unknown" });
			void this.finalize({ reason: "timeout", failure: ended });
			return failure.kind === "timeout" ? ended : failure;
		};
		const started = this.call("turn/start", body, timeoutMs ?? this.bounds.requestMs, "request", (result) => {
			// Inside the answer's own line: the next line of the same chunk can be this turn's completion, or a request
			// that ends the run, and either has to find the turn admitted rather than waiting for a continuation.
			release();
			const read = this.readOrFail(readTurnStart(result));
			const key = { threadId: params.threadId, turnId: read.turnId };
			if (this.turns.has(keyOf(key))) return this.readOrFail<never>({ ok: false, reason: "it admitted a turn under an id it had already used" });
			const record = this.admit(key);
			for (const event of pending.early) {
				if (event.key.turnId !== key.turnId) {
					this.tally.foreignTurnNotifications += 1;
					continue;
				}
				record.evidence.notifications += 1;
				event.apply(record);
			}
			// After the early events, so a question held for a turn they already ended is refused rather than asked.
			for (const question of pending.questions) {
				if (question.key.turnId === key.turnId) this.ask(question, record);
				else this.refuseQuestion(question, CODEX_QUESTION_REFUSED);
			}
			const turn: CodexTurn = { threadId: key.threadId, turnId: key.turnId, snapshot: () => structuredClone(record.evidence), done: record.answer.promise };
			return turn;
		}, unanswered);
		started.catch(() => {
			release();
			// No turn was named, so no question held for one is asked.
			for (const question of pending.questions) this.refuseQuestion(question, CODEX_QUESTION_REFUSED);
		});
		return started;
	}

	readThread(threadId: string, timeoutMs?: number): Promise<CodexThreadRead> {
		const refused = this.refusal(timeoutMs);
		if (refused) return Promise.reject(refused);
		const thread = this.threads.get(threadId);
		if (!thread) return Promise.reject(new CodexTransportError(codexFailure("refused", { reason: NOT_OWN_THREAD })));
		return this.call("thread/read", { threadId, includeTurns: false }, timeoutMs ?? this.bounds.requestMs, "request", (result) => {
			const read = this.readOrFail(readThreadRead(result));
			if (read.threadId !== threadId) return this.readOrFail<never>({ ok: false, reason: WRONG_THREAD });
			thread.status = read.status;
			return read;
		});
	}

	async interrupt(turn: CodexTurnKey, timeoutMs?: number): Promise<void> {
		const refused = this.refusal(timeoutMs);
		if (refused) throw refused;
		const record = this.turns.get(keyOf(turn));
		if (!record || record.done) throw new CodexTransportError(codexFailure("refused", { reason: NOT_OWN_TURN }));
		await this.call("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId }, timeoutMs ?? this.bounds.requestMs);
	}

	threadStatus(threadId: string): CodexThreadStatus | undefined {
		const status = this.threads.get(threadId)?.status;
		return status === undefined ? undefined : structuredClone(status);
	}

	shutdown(reason: "host" | "aborted" = "host"): Promise<CodexExit> {
		return this.finalize({ reason, ...(reason === "aborted" ? { failure: codexFailure("aborted") } : {}) });
	}

	/* ---------------------------------------------------------------------------------------------------------- */

	/** The refusal a call gets before anything is composed: a closed transport first, then a bound that is not one. */
	private refusal(timeoutMs: number | undefined): Error | undefined {
		if (this.state !== "ready") return new CodexTransportError(codexFailure(this.failure?.kind === "exited" ? "exited" : "closed"));
		if (timeoutMs === undefined) return undefined;
		try {
			positiveTimer("timeoutMs", timeoutMs);
		} catch (error) {
			return error as Error;
		}
		return undefined;
	}

	/**
	 * The fields every thread-opening request shares, checked and composed from the named fields alone, so nothing a
	 * caller's object carries beside them reaches the wire. No effort: none of these requests takes one.
	 */
	private threadBody(params: CodexThreadStartParams): Record<string, unknown> | Error {
		if (params.sandbox !== "read-only" && params.sandbox !== "workspace-write") return new TypeError("sandbox is read-only or workspace-write");
		if (params.approvalPolicy !== "never") return new TypeError("the approval policy is never");
		if (typeof params.developerInstructions !== "string" || params.developerInstructions === "") return new TypeError("developerInstructions is the role's non-empty contract text");
		if (Buffer.byteLength(params.developerInstructions) > this.bounds.maxInstructionsBytes) return new CodexTransportError(codexFailure("refused", { reason: "the developer instructions are longer than this transport sends" }));
		for (const field of ["model", "modelProvider"] as const) {
			if (params[field] !== undefined && (typeof params[field] !== "string" || params[field] === "")) return new TypeError(`${field} is a non-empty string when named`);
		}
		const body: Record<string, unknown> = { sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, developerInstructions: params.developerInstructions };
		if (params.model !== undefined) body.model = params.model;
		if (params.modelProvider !== undefined) body.modelProvider = params.modelProvider;
		return body;
	}

	/** Registers a thread an answer named as this transport's. One already owned keeps the status it has. */
	private own(threadId: string): void {
		if (!this.threads.has(threadId)) this.threads.set(threadId, {});
	}

	/** A reader's answer, or the protocol failure it is: malformed evidence ends the child, and the call says so. */
	private readOrFail<T>(read: CodexRead<T>): T {
		if (read.ok) return read.value;
		this.protocol(read.reason);
		throw new CodexTransportError(this.failure ?? codexFailure("protocol", { reason: read.reason }));
	}

	private admit(key: CodexTurnKey): TurnRecord {
		const record: TurnRecord = {
			evidence: {
				threadId: key.threadId,
				turnId: key.turnId,
				started: false,
				usageUpdates: 0,
				usageAfterCompletion: 0,
				retryableErrors: 0,
				terminalErrors: 0,
				reroutes: [],
				rerouteCount: 0,
				denials: [],
				denialCount: 0,
				items: { started: 0, completed: 0 },
				notifications: 0,
			},
			done: false,
			answer: deferred<CodexTurnResult>(),
		};
		this.turns.set(keyOf(key), record);
		this.activeTurn = record;
		return record;
	}

	private alive(): boolean {
		return this.tree.spawned && this.exitSeen === undefined;
	}

	/** One outbound frame, or nothing: a record that does not serialize, and one past the cap, are both refused. */
	private frame(record: Record<string, unknown>): { text: string; bytes: number } | undefined {
		let body: string;
		try {
			body = JSON.stringify(record);
		} catch {
			return undefined;
		}
		if (typeof body !== "string" || !body.startsWith("{")) return undefined;
		const text = `${body}\n`;
		const bytes = Buffer.byteLength(text);
		return bytes > this.bounds.maxOutboundFrameBytes ? undefined : { text, bytes };
	}

	/**
	 * One host request and its result. The clock starts at admission, so a frame waiting behind others spends the
	 * caller's bound. A request that times out leaves the child running — the caller decides whether that ends it —
	 * unless `onTimeout` decides otherwise and returns the failure the call ends with.
	 *
	 * `accept` reads the result synchronously, inside the line that answered it, so what it registers — a thread, an
	 * admitted turn — is in place before the next line of the same chunk is read. What it throws is the call's rejection.
	 */
	private call<T = unknown>(method: string, params: unknown, timeoutMs: number, kind: WriteKind = "request", accept?: (result: unknown) => T, onTimeout?: (failure: CodexFailure) => CodexFailure): Promise<T> {
		const answer = deferred<T>();
		let timer: NodeJS.Timeout | undefined;
		let id: number;
		try {
			id = this.correlator.issue(method, {
				stopTimer: () => {
					if (timer !== undefined) clearTimeout(timer);
				},
				settle: (outcome) => {
					if (!outcome.ok) {
						answer.reject(new CodexTransportError(outcome.failure));
						return;
					}
					try {
						answer.resolve(accept ? accept(outcome.result) : (outcome.result as T));
					} catch (error) {
						answer.reject(error);
					}
				},
			});
		} catch (error) {
			return Promise.reject(error);
		}
		timer = setTimeout(() => {
			const failure = codexFailure("timeout");
			this.correlator.settle(id, { ok: false, failure: onTimeout ? onTimeout(failure) : failure });
			this.writer.dropUnsent((item) => item.owner === id);
		}, timeoutMs);
		const framed = this.frame({ id, method, params });
		if (!framed || !this.writer.enqueue({ kind, owner: id, text: framed.text, bytes: framed.bytes })) {
			this.correlator.settle(id, { ok: false, failure: codexFailure("refused", { reason: framed ? "the write queue has no room for it" : "it does not fit in one frame" }) });
		}
		return answer.promise;
	}

	private notify(method: string): boolean {
		const framed = this.frame({ method });
		return framed !== undefined && this.writer.enqueue({ kind: "control", text: framed.text, bytes: framed.bytes });
	}

	/**
	 * One reply to a server request. A reply that cannot be queued leaves the child waiting on it, which ends the run,
	 * except on the way out: a child already being stopped is only counted a dropped frame, never finalized again.
	 */
	private reply(id: string | number, body: { result: unknown } | { error: { code: number; message: string } }): void {
		const framed = this.frame({ id, ...body });
		if (framed && this.writer.enqueue({ kind: "reply", text: framed.text, bytes: framed.bytes })) return;
		if (this.state === "closing" || this.state === "ended") this.tally.droppedFrames += 1;
		else this.protocol(REPLY_UNQUEUED);
	}

	private bind(): void {
		const handle = this.handle!;
		handle.on("error", () => this.rootError());
		handle.on("exit", (code: number | null, signal: NodeJS.Signals | null) => this.rootExit({ code, signal }));
		const stdin = handle.stdin as Writable | undefined;
		if (stdin) {
			stdin.on("error", () => this.writer.close());
			stdin.on("close", () => this.writer.close());
			stdin.on("drain", () => this.writer.drained());
		}
		this.writer.attach(stdin);
		this.out = new CodexPipe(handle.stdout, (chunk) => this.readStdout(chunk), () => this.endStdout());
		this.err = new CodexPipe(handle.stderr, (chunk) => this.readStderr(chunk), () => this.endStderr());
	}

	/** Node reports a signal it could not deliver as it reports a spawn that never happened: by the pid. */
	private rootError(): void {
		if (this.tree.pid !== undefined) return;
		this.spawnRefused = true;
		this.fail({ reason: "spawn" });
	}

	private rootExit(exit: ExitOutcome): void {
		this.exitSeen = exit;
		this.releaseStop();
		this.fail({ reason: "exited", failure: codexFailure("exited", { exit }) });
	}

	private readStderr(chunk: Buffer): void {
		if (!this.stderrDone) this.stderrTail.push(chunk);
	}

	private endStderr(): void {
		if (this.stderrDone) return;
		this.stderrDone = true;
		this.stderrTail.end();
	}

	private endStdout(): void {
		for (const line of this.stdoutFramer.end()) {
			if (line.partial && line.text !== "") this.trailing = true;
		}
	}

	private readStdout(chunk: Buffer): void {
		if (this.state === "ended") return;
		let lines: PiLine[];
		try {
			lines = this.stdoutFramer.push(chunk);
		} catch {
			return;
		}
		for (const [at, line] of lines.entries()) {
			if (this.readLine(line)) continue;
			this.tally.droppedFrames += lines.length - at - 1;
			return;
		}
		// A flood with no LF is over the cap long before any line ends; waiting for its end would let the child decide.
		if (this.stdoutFramer.inProgress.truncated) this.protocol(OVERSIZED_RECORD);
	}

	/** One complete line. Answers false once something stopped this transport reading any more of them. */
	private readLine(line: PiLine): boolean {
		if (this.state === "ended") return false;
		if (line.truncated) {
			this.protocol(OVERSIZED_RECORD);
			return false;
		}
		if (line.partial) {
			if (line.text !== "") this.trailing = true;
			return false;
		}
		let value: unknown;
		try {
			value = JSON.parse(line.text);
		} catch {
			this.protocol(NOT_JSON);
			return false;
		}
		const message = readMessage(value, this.bounds.maxDiagnosticBytes);
		if (!message.ok) {
			this.protocol(message.reason);
			return false;
		}
		const read = message.value;
		if (read.kind === "notification") return this.readNotification(read.method, read.params);
		if (read.kind === "request") return this.readServerRequest(read.id, read.method, read.params);
		return this.readResponse(read);
	}

	private readResponse(message: Extract<CodexMessage, { kind: "result" | "error" }>): boolean {
		const state = this.correlator.classify(message.id);
		if (state === "impossible") {
			this.protocol(UNKNOWN_ID);
			return false;
		}
		if (state === "late") {
			this.tally.lateResponses += 1;
			return true;
		}
		const id = message.id as number;
		if (message.kind === "result") this.correlator.settle(id, { ok: true, result: message.result });
		else this.correlator.settle(id, { ok: false, failure: codexFailure("rejected", { code: message.code, error: message.message }) });
		return true;
	}

	/**
	 * A request from the child. Approvals are declined, every one and on the wire, and surfaced as denials; everything
	 * else is answered with an error and fails the run, because a child waiting for an answer this build cannot give —
	 * a question for the user, a dynamic tool — has no other end. Each id is answered once.
	 */
	private readServerRequest(id: string | number, method: string, params: unknown): boolean {
		this.tally.serverRequests += 1;
		const seen = `${typeof id}:${id}`;
		if (this.serverIds.has(seen)) {
			this.tally.duplicateServerRequests += 1;
			return true;
		}
		if (this.serverIds.size >= this.bounds.maxServerRequests) {
			this.protocol(SERVER_IDS_EXHAUSTED);
			return false;
		}
		this.serverIds.add(seen);
		const kind = Object.hasOwn(CODEX_APPROVAL_METHODS, method) ? CODEX_APPROVAL_METHODS[method] : undefined;
		if (kind !== undefined) {
			this.reply(id, { result: { decision: "decline" } });
			this.tally.declinedApprovals += 1;
			this.recordDenial(readApproval(kind, params, this.bounds.maxDiagnosticBytes));
			return this.state !== "ended";
		}
		const question = method === CODEX_TOOL_CALL_METHOD ? readQuestionCall(params, this.bounds.maxMessageBytes) : undefined;
		if (question !== undefined) {
			this.takeQuestion(id, question);
			return this.state !== "ended";
		}
		this.tally.unsupportedRequests += 1;
		this.reply(id, { error: { code: CODEX_UNSUPPORTED_CODE, message: "this client does not support this request" } });
		this.fail({ reason: "unsupported", failure: codexFailure("unsupported", { reason: `it sent a ${method} request` }) });
		return true;
	}

	/**
	 * One question call, scoped before anyone is asked: a run with no callback, a call that is not one, another thread's
	 * and a turn that ended or was never this transport's are answered `success: false` at once. One for the thread of
	 * a turn/start still unanswered is held, bounded, for the answer that names its turn.
	 */
	private takeQuestion(id: string | number, call: CodexRead<CodexQuestionCall>): void {
		const refuse = (text: string): void => {
			this.tally.refusedQuestions += 1;
			this.toolResult(id, { success: false, text });
		};
		if (this.options.onQuestion === undefined) return refuse(CODEX_QUESTION_UNAVAILABLE);
		if (this.state !== "ready") return refuse(CODEX_QUESTION_UNANSWERED);
		if (!call.ok || !this.threads.has(call.value.threadId)) return refuse(CODEX_QUESTION_REFUSED);
		const { threadId, turnId, question: text } = call.value;
		const question: OpenQuestion = { id, key: { threadId, turnId }, question: text, done: false };
		const turn = this.turns.get(keyOf(question.key));
		if (turn) return this.ask(question, turn);
		const pending = this.pendingStart;
		if (pending === undefined || pending.threadId !== threadId || pending.questions.length >= this.bounds.maxEarlyNotifications) return refuse(CODEX_QUESTION_REFUSED);
		pending.questions.push(question);
		this.questions.add(question);
	}

	/**
	 * Hands one question to the callback with a signal of its own, and leaves it: the answer, a rejection or this
	 * transport ending it first is one reply, and the read loop goes on meanwhile. A turn that already ended is refused.
	 */
	private ask(question: OpenQuestion, turn: TurnRecord): void {
		const ask = this.options.onQuestion;
		if (ask === undefined || turn.done || this.state !== "ready") return this.refuseQuestion(question, turn.done ? CODEX_QUESTION_REFUSED : CODEX_QUESTION_UNANSWERED);
		const controller = new AbortController();
		question.turn = turn;
		question.controller = controller;
		this.questions.add(question);
		this.tally.questions += 1;
		let asked: Promise<unknown>;
		try {
			asked = Promise.resolve(ask(question.question, controller.signal));
		} catch (error) {
			asked = Promise.reject(error);
		}
		asked
			.then(
				(answer) => this.answerQuestion(question, typeof answer === "string" ? { success: true, text: answer } : { success: false, text: CODEX_QUESTION_UNANSWERED }),
				() => this.answerQuestion(question, { success: false, text: CODEX_QUESTION_UNANSWERED }),
			)
			.catch(() => {});
	}

	/** A question taken and then not asked: held for a turn that was never named, or for one that had already ended. */
	private refuseQuestion(question: OpenQuestion, text: string): void {
		if (question.done) return;
		this.tally.refusedQuestions += 1;
		this.answerQuestion(question, { success: false, text });
	}

	/**
	 * The one reply a question call gets, as the dynamic tool result: the answer as its one text item, or `success: false`
	 * with a fixed text. A question this transport ends has its signal aborted after it is marked answered, so the
	 * rejection that abort causes finds it done. Once the child is gone nothing is written.
	 */
	private answerQuestion(question: OpenQuestion, result: { success: boolean; text: string }): void {
		if (question.done) return;
		question.done = true;
		this.questions.delete(question);
		if (!result.success) question.controller?.abort();
		this.toolResult(question.id, result);
	}

	/** A dynamic tool result on the wire, unless the child is gone. The text is written and never kept. */
	private toolResult(id: string | number, result: { success: boolean; text: string }): void {
		if (this.state === "ended") return;
		this.reply(id, { result: { success: result.success, contentItems: [{ type: "inputText", text: result.text }] } });
	}

	/** Ends the questions still open — every one, or only those asked on one turn — each with its one unanswered reply. */
	private endQuestions(turn?: TurnRecord): void {
		for (const question of [...this.questions]) {
			if (turn === undefined || question.turn === turn) this.answerQuestion(question, { success: false, text: CODEX_QUESTION_UNANSWERED });
		}
	}

	private recordDenial(denial: CodexDenial): void {
		if (denial.threadId !== undefined && denial.turnId !== undefined) {
			const key = { threadId: denial.threadId, turnId: denial.turnId };
			if (this.route(key, (turn) => this.addDenial(turn, denial))) return;
		}
		this.lastUnmatchedDenial = denial;
	}

	private addDenial(turn: TurnRecord, denial: CodexDenial): void {
		turn.evidence.denialCount += 1;
		if (turn.evidence.denials.length < this.bounds.maxRecorded) turn.evidence.denials.push(denial);
	}

	private readNotification(method: string, params: unknown): boolean {
		this.tally.notifications += 1;
		if (!READ_NOTIFICATIONS.has(method)) {
			this.tally.unknownNotifications += 1;
			return true;
		}
		if (!this.applyNotification(method, params)) return false;
		const listener = this.options.onNotification;
		if (listener) {
			try {
				listener({ method, params });
			} catch {
				this.tally.listenerErrors += 1;
			}
		}
		return this.state !== "ended";
	}

	/** One notification of a method this build reads. Malformed lifecycle evidence fails the child; a malformed item is counted. */
	private applyNotification(method: string, params: unknown): boolean {
		const max = this.bounds.maxDiagnosticBytes;
		switch (method) {
			case "turn/started": {
				const read = readTurnStarted(params);
				if (!read.ok) return this.malformed(read.reason);
				this.route(read.value, (turn) => (turn.evidence.started = true));
				return true;
			}
			case "turn/completed": {
				const read = readTurnCompleted(params, max);
				if (!read.ok) return this.malformed(read.reason);
				const { status, error } = read.value;
				this.route(read.value, (turn) => this.complete(turn, status, error));
				return true;
			}
			case "error": {
				const read = readErrorNotice(params, max);
				if (!read.ok) return this.malformed(read.reason);
				const notice = read.value;
				this.route(notice, (turn) => {
					if (notice.willRetry) {
						turn.evidence.retryableErrors += 1;
						turn.evidence.lastRetryableError = notice.error;
					} else {
						turn.evidence.terminalErrors += 1;
						turn.evidence.terminalError = notice.error;
					}
				});
				return true;
			}
			case "thread/tokenUsage/updated": {
				const read = readTokenUsage(params);
				if (!read.ok) return this.malformed(read.reason);
				const { threadId: _thread, turnId: _turn, ...usage } = read.value;
				this.route(read.value, (turn) => {
					turn.evidence.usage = usage;
					turn.evidence.usageUpdates += 1;
					if (turn.evidence.completion !== undefined) turn.evidence.usageAfterCompletion += 1;
				});
				return true;
			}
			case "model/rerouted": {
				const read = readReroute(params);
				if (!read.ok) return this.malformed(read.reason);
				const { threadId: _thread, turnId: _turn, ...reroute } = read.value;
				this.route(read.value, (turn) => {
					turn.evidence.rerouteCount += 1;
					if (turn.evidence.reroutes.length < this.bounds.maxRecorded) turn.evidence.reroutes.push(reroute);
				});
				return true;
			}
			case "thread/status/changed": {
				const read = readThreadStatusChanged(params);
				if (!read.ok) return this.malformed(read.reason);
				const thread = this.threads.get(read.value.threadId);
				if (thread) thread.status = read.value.status;
				else this.tally.otherThreadNotifications += 1;
				return true;
			}
			case "item/started":
			case "item/completed": {
				const read = readItem(params, this.bounds.maxMessageBytes);
				if (!read.ok) {
					this.tally.malformedItems += 1;
					return true;
				}
				const item: CodexItem = read.value;
				this.route(item, (turn) => {
					if (method === "item/started") {
						turn.evidence.items.started += 1;
						return;
					}
					turn.evidence.items.completed += 1;
					if (item.text !== undefined) turn.evidence.finalMessage = item.text;
				});
				return true;
			}
			default:
				// thread/started and serverRequest/resolved: read for nothing but the count above.
				return true;
		}
	}

	private malformed(reason: string): boolean {
		this.protocol(reason);
		return false;
	}

	/**
	 * Hands one turn-scoped event to the turn it names. A thread this transport did not start — a subagent's — is not
	 * evidence; a turn of an own thread whose turn/start is still unanswered is held, bounded, for that answer; any other
	 * turn of an own thread is counted. Answers whether the event reached or was held for an own turn.
	 */
	private route(key: CodexTurnKey, apply: (turn: TurnRecord) => void): boolean {
		if (!this.threads.has(key.threadId)) {
			this.tally.otherThreadNotifications += 1;
			return false;
		}
		const turn = this.turns.get(keyOf(key));
		if (turn) {
			turn.evidence.notifications += 1;
			apply(turn);
			return true;
		}
		const pending = this.pendingStart;
		if (pending && pending.threadId === key.threadId) {
			if (pending.early.length >= this.bounds.maxEarlyNotifications) {
				this.protocol(EARLY_OVERFLOW);
				return false;
			}
			pending.early.push({ key, apply });
			this.tally.earlyNotifications += 1;
			return true;
		}
		this.tally.foreignTurnNotifications += 1;
		return false;
	}

	private complete(turn: TurnRecord, status: CodexTurnStatus, error: CodexTurnError | null): void {
		if (turn.evidence.completion !== undefined) {
			if (this.state === "ready") this.protocol(DUPLICATE_COMPLETION);
			return;
		}
		turn.evidence.completion = { status, error };
		this.finishTurn(turn, status);
		// Any end of the turn a shutdown interrupted is what its bounded wait is for.
		this.releaseStop();
	}

	private finishTurn(turn: TurnRecord, outcome: CodexTurnResult["outcome"], failure?: CodexFailure): void {
		if (turn.done) return;
		turn.done = true;
		const settled = turn.fixed ?? outcome;
		const server = settled === "completed" || settled === "failed" || settled === "interrupted";
		const reported = failure ?? (server ? undefined : this.failure);
		turn.answer.resolve({ ...structuredClone(turn.evidence), outcome: settled, ...(reported === undefined ? {} : { failure: reported }) });
		this.endQuestions(turn);
	}

	/** Frames that will never be written: each request owner is settled once, and a dropped reply is counted. */
	private releaseDropped(items: WriteItem[]): void {
		const failure = this.failure ?? codexFailure("closed");
		for (const item of items) {
			this.tally.droppedFrames += 1;
			if (item.owner !== undefined) this.correlator.settle(item.owner, { ok: false, failure });
		}
	}

	/* ---------------------------------------------------------------------------------------------------------- */

	private protocol(reason: string): void {
		this.fail({ reason: "protocol", failure: codexFailure("protocol", { reason }) });
	}

	private fail(cause: FinalCause): void {
		void this.finalize(cause);
	}

	private releaseStop(): void {
		for (const waiter of this.stopWaiters.splice(0, this.stopWaiters.length)) waiter();
	}

	private async startupRefusal(cause: FinalCause): Promise<CodexTransportError> {
		const exit = await this.finalize(cause);
		return new CodexTransportError(exit.failure ?? codexFailure("handshake"), exit);
	}

	/**
	 * One finalization per transport, memoized before it can run, so anything re-entering it gets the same promise. A
	 * finalization that throws is collapsed once into an `unverified` rejection every caller gets: no report, no exit and
	 * no signal is invented, every local wait is released, and the process is left exactly as it was.
	 */
	private finalize(cause: FinalCause): Promise<CodexExit> {
		if (this.ending) return this.ending;
		const ending = this.runFinalize(cause).catch(() => {
			throw this.collapse();
		});
		this.ending = ending;
		ending.catch(() => {});
		this.exitedAt.promise.catch(() => {});
		ending.then(
			(exit) => this.exitedAt.resolve(exit),
			(error) => this.exitedAt.reject(error),
		);
		return ending;
	}

	private collapse(): CodexTransportError {
		const failure = codexFailure("unverified");
		this.failure ??= failure;
		this.state = "ended";
		for (const step of [
			() => this.detachAbort(),
			() => this.releaseStop(),
			() => this.writer.close(),
			() => this.correlator.settleAll(failure),
			() => this.endQuestions(),
			() => {
				for (const turn of this.turns.values()) this.finishTurn(turn, turn.fixed ?? "transport", failure);
			},
			() => {
				this.out?.abandon();
				this.err?.abandon();
			},
		]) {
			try {
				step();
			} catch {}
		}
		return new CodexTransportError(failure);
	}

	/**
	 * The order: external admission stops and the caller's unsent frames go, settling their owners. A live child with an
	 * admitted turn still running is observed once while it still owns its descendants, sent turn/interrupt, and given one
	 * bounded step for that turn to complete or the child to exit — its acknowledgement alone ends nothing. Then the
	 * tree's owned cleanup, which ends stdin first, then both pipes read to their close within one more bounded step.
	 */
	private async runFinalize(cause: FinalCause): Promise<CodexExit> {
		this.state = "closing";
		this.detachAbort();
		if (cause.failure) this.failure ??= cause.failure;
		this.requestedStop = cause.reason !== "exited" && cause.reason !== "spawn";

		const turn = this.activeTurn && !this.activeTurn.done ? this.activeTurn : undefined;
		if (turn) {
			if (cause.reason === "host" || cause.reason === "aborted") turn.fixed = "aborted";
			else if (cause.reason !== "exited") turn.fixed = "transport";
		}
		this.writer.dropUnsent((item) => item.kind === "request");
		// Every open question ends now, each answered unanswered ahead of the interrupt and its signal aborted.
		this.endQuestions();
		if (this.alive() && turn) {
			// One read, no more: a failed one shows as the cleanup's own `discovery`, never as an error here.
			await this.tree.observe().catch(() => undefined);
			if (this.control("turn/interrupt", { threadId: turn.evidence.threadId, turnId: turn.evidence.turnId })) await this.waitForStop(turn);
		}

		const cleanup = await this.tree.shutdown();
		const closed = await Promise.all([this.out?.closedWithin(this.bounds.shutdownStepMs) ?? Promise.resolve(true), this.err?.closedWithin(this.bounds.shutdownStepMs) ?? Promise.resolve(true)]);
		this.tally.streamsUnclosed = closed.filter((done) => !done).length;
		this.writer.close();
		if (this.out?.finished !== true) this.endStdout();
		this.endStderr();
		const stderr = this.stderrTail.record;
		const exit = cleanup.exit;

		if (this.trailing && !this.explained(exit)) this.failure ??= codexFailure("protocol", { reason: TRAILING_RECORD });
		if (!this.ready) {
			const excerpt = keepLastBytes(stderr.tail, this.bounds.maxDiagnosticBytes).text;
			if (this.spawnRefused) this.failure = codexFailure("spawn", { exit });
			else if (this.failure === undefined || this.failure.kind === "exited" || this.failure.kind === "timeout") this.failure = codexFailure("handshake", { exit, excerpt });
			else if (excerpt.trim()) this.failure = { ...this.failure, message: `${this.failure.message}\n\nChild stderr:\n${excerpt.trimEnd()}` };
		}
		if (cleanup.root === "unstoppable") this.failure = codexFailure("unstoppable", { exit });

		// What the root actually did, apart from whether this host asked it to stop: status 0, or a signal this tree sent.
		// Any other end — a crash signal, a nonzero status — is not a clean stop however it was asked for, and with no
		// other failure recorded it is this run's failure. Generic over the signal: nothing here lists crash signals.
		const spawned = cleanup.root !== "unspawned";
		const cleanExit = spawned && ((exit.code === 0 && exit.signal === null) || this.tree.stoppedBy(exit));
		const crashed = spawned && !cleanExit && cleanup.root !== "unstoppable";
		if (crashed) this.failure ??= codexFailure("exited", { exit, reason: "it ended in a way this host did not cause" });

		this.correlator.settleAll(this.failure ?? codexFailure("closed"));
		for (const record of this.turns.values()) {
			if (record.done) continue;
			// A turn still running when the root crashed ended with the child, whatever stop had been asked for it.
			if (crashed && record.fixed !== "transport") record.fixed = "exited";
			this.finishTurn(record, record.fixed ?? (this.failure?.kind === "exited" ? "exited" : this.failure ? "transport" : "aborted"));
		}
		this.state = "ended";
		return {
			exit,
			cleanup,
			stderr,
			...(this.failure === undefined ? {} : { failure: this.failure }),
			stopRequested: this.requestedStop,
			cleanExit,
			counters: { ...this.tally },
			...(this.lastUnmatchedDenial === undefined ? {} : { lastUnmatchedDenial: this.lastUnmatchedDenial }),
		};
	}

	private explained(exit: ExitOutcome): boolean {
		return this.failure !== undefined || exit.signal !== null || (exit.code !== null && exit.code !== 0);
	}

	/** A shutdown's own request: sent if there is a slot and room, never retried, never waited on beyond one step. */
	private control(method: string, params: unknown): boolean {
		if (!this.alive() || !this.writer.open) return false;
		let id: number;
		try {
			id = this.correlator.issue(method, { settle: () => {} });
		} catch {
			return false;
		}
		const framed = this.frame({ id, method, params });
		if (!framed || !this.writer.enqueue({ kind: "control", owner: id, text: framed.text, bytes: framed.bytes })) {
			this.correlator.settle(id, { ok: false, failure: codexFailure("refused") });
			return false;
		}
		return true;
	}

	/** One bounded step for an interrupted turn to complete, or the child to exit. */
	private waitForStop(turn: TurnRecord): Promise<void> {
		if (!this.alive() || turn.done) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const timer = setTimeout(finish, this.bounds.shutdownStepMs);
			function finish(): void {
				clearTimeout(timer);
				resolve();
			}
			this.stopWaiters.push(finish);
		});
	}

	private detachAbort(): void {
		const signal = this.options.signal;
		if (!signal || !this.abortListener) return;
		signal.removeEventListener("abort", this.abortListener);
		this.abortListener = undefined;
	}
}

/**
 * One Codex app-server, spawned from the launch it is handed and brought through its handshake. A startup that fails
 * rejects with a `CodexTransportError` carrying the whole finished `CodexExit`, because nobody else holds that child.
 */
export async function startCodexChild(options: CodexChildOptions): Promise<CodexChild> {
	if (!options || typeof options !== "object" || !options.launch) throw new TypeError("a codex child is started from the launch it is handed");
	if (options.killGraceMs !== undefined) positiveTimer("killGraceMs", options.killGraceMs);
	const bounds = codexBounds(options.bounds);
	return new CodexChildImpl(options, bounds).start();
}
