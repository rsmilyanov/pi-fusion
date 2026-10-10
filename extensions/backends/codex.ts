import { readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedCleanup } from "../process-tree.ts";
import type { CodexRole } from "./codex-binding.ts";
import { type CodexLaunch, type CodexLaunchRequest, codexLaunch } from "./codex-launch.ts";
import {
	baselineOf,
	callUsage,
	type CodexEnding,
	type CodexRun,
	type CodexSession,
	type CodexStage,
	type CodexSteerReport,
	type CodexVerdict,
	CWD_READ_MISMATCH,
	codexFeed,
	codexSession,
	FORK_NO_TIP,
	FORK_SAME_THREAD,
	FORK_TIP_UNSETTLED,
	FORK_WRONG_SOURCE,
	finishCodexRun,
	HOME_MISMATCH,
	isCodexSession,
	NO_FINAL,
	NO_USAGE,
	newCodexRun,
	RESUME_MOVED,
	RESUME_UNSETTLED,
	RUN_ABORTED,
	RUN_UNVERIFIED,
	TERMINAL_ERROR,
	threadStartProblem,
	turnFailure,
	USAGE_BASELINE_INCONSISTENT,
	verifySelection,
} from "./codex-outcome.ts";
import type { CodexLatestTurn, CodexThreadResume, CodexThreadStart } from "./codex-protocol.ts";
import { type CodexBounds, type CodexChild, type CodexChildOptions, type CodexClientInfo, CODEX_CLIENT_INFO, type CodexSteerResult, CodexTransportError, type CodexTurnEvidence, startCodexChild } from "./codex-transport.ts";
import { type Backend, type ChildControl, type ChildEvent, failed, type RunRequest } from "./types.ts";

/**
 * One Codex call composed out of the parts that already exist: the role binding, the launch, the transport and the
 * outcome mapping. It decides the order and owns the child between its start and its one shutdown; every judgement of
 * evidence is `codex-outcome.ts`'s, and every wire and process concern the transport's.
 *
 * **Qualification scope.** Every shape this reads is a source reading of Codex 0.160.0's
 * app-server. Native qualification, on one host under its default model, covers only a fresh `implement` and `ask` (G1),
 * an `ask` resume, current-tip fork, moved-tip refusal, one steer and per-call usage on connections with no question
 * callback (G2), and `ask` questions on fresh, resumed and forked threads plus a cancellation while one waited (G3); the
 * rest is exercised only against `test/fake-codex.mjs` (see docs/codex-backend.md#evidence). The host registers one
 * backend from `createCodexBackend` when the extension loads, and neither importing this module nor that construction
 * starts, locates or reads anything: the contract, the binary and the client version are all looked for only when a
 * run is requested.
 *
 * **The order.** A cancelled signal ends the call before anything is read; a missing question callback refuses it
 * before any contract read or launch. Then the shared role contract, the launch — the host's own cwd and inherited
 * environment, the binary located only now — and the client's version, and only then a child: spawn, `initialize`, `initialized`.
 * The home the child reports must be the one the launch predicted. One thread is opened — `thread/start`, `thread/resume` of the recorded thread or `thread/fork` of it through its
 * checkpoint — naming the role's sandbox mode, approval `never`, the role's instructions and only the model and provider
 * the call named or the record repeats; its answer must name the right thread, this run's working directory, the
 * requested sandbox and a model and provider, the named ones exactly. A continued thread's latest turn is then read: a
 * resumed one must still end at its checkpoint, completed, and a fork's new thread must end at a completed turn, which
 * is its starting checkpoint. One `turn/start` carries the prompt and only an effort the call named or the record
 * repeats. The turn's own scoped end is what ends it; a `thread/read` after it is the barrier late usage lands before,
 * and its answer is where the configured selection is verified. Then the child's one shutdown, and the mapping.
 *
 * **Steers.** The control a run is handed is open from its admission: what is pushed before the turn is admitted waits,
 * and is then sent to that turn, one `turn/steer` per message, in order, each once. It closes when the turn ends, the
 * call ends or it is cancelled, and what is still queued then is dropped and counted. Nothing is resent, replayed or
 * sent to a guessed turn.
 *
 * **Questions.** Every admitted run has `onQuestion`, passed to the transport as it is: the whole connection opts
 * into Codex's experimental API and a fresh thread registers the question tool. Continuations trust Codex to restore
 * that registration; there is no inventory probe, capability marker or legacy tool-less-thread fallback. Every run
 * gets its shared contract alone. Cancelling a run with a question open ends that question through the transport's
 * own stop: no second stop, notice or retry.
 *
 * **One stop.** The composition calls `shutdown` exactly once on the child it was handed, on every path after the start
 * resolved; a cancellation or a transport failure that already finalized the child makes that call the same memoized
 * finalization rather than a second one. Nothing above the mapping writes a cleanup sentence of its own.
 *
 * **What it never does.** No request names a cwd, a configuration map, base instructions, a dynamic tool other than
 * the question tool on a fresh thread, or an effort on a thread request; no turn/start names a model,
 * provider, cwd or sandbox policy. Nothing rewinds, replays or names a path. Fusion writes no trust entry, configuration or auth file: what the child inherits — the host's Codex home,
 * configuration, MCP servers, multi-agent features — is the host's, and nothing here isolates a run from it.
 */

/** Contracts sit beside the extension, two directories up, where the other backends read theirs from. */
export const CODEX_CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts");

/** This package's own manifest, read for the client version the handshake names, and only when a run asks for it. */
const PACKAGE_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

/** What a caller is told when this install's own contract file could not be read. The value is kept as the cause. */
export const CONTRACT_UNREADABLE = "the codex backend could not read the contract for this role";

/** A shared contract requires a working question bridge; refuse a callback-less call before reading or launching anything. */
export const CODEX_QUESTION_REQUIRED = "the codex backend requires a question callback, so nothing was started";

/** The version a handshake names when this package's manifest cannot be read: a fallback, never a load failure. */
export const CODEX_CLIENT_VERSION_UNKNOWN = "unknown";

/**
 * The client this build says it is: the transport's name and title with this package's own version, read from its
 * manifest when a run is about to start. A manifest that cannot be read gives the fixed fallback rather than failing.
 */
export function codexClientInfo(manifest: string = PACKAGE_JSON): CodexClientInfo {
	let version = CODEX_CLIENT_VERSION_UNKNOWN;
	try {
		const data = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
		if (typeof data.version === "string" && data.version.trim() !== "") version = data.version.trim();
	} catch {}
	return { name: CODEX_CLIENT_INFO.name, version, ...(CODEX_CLIENT_INFO.title === undefined ? {} : { title: CODEX_CLIENT_INFO.title }) };
}

/** Where one call stopped, for a test and nothing else. */
export type CodexCallStage = "aborted-before-start" | "admission" | "contract" | "launch" | "start-rejected" | "startup" | CodexStage | "done";

/**
 * What one call did, handed to `onCall` and never to a user, a record or a card. `shutdowns` counts this composition's
 * own calls of the child's shutdown, which is exactly one on every path where a child was handed over.
 */
export interface CodexCallReport {
	stage: CodexCallStage;
	launchCalled: boolean;
	startCalled: boolean;
	startResolved: boolean;
	shutdowns: number;
	thrown?: { error: unknown };
}

/**
 * The seams one backend is built with, all internal: production leaves them unset and gets the contract files, the
 * real launch over this process's environment, the transport's own start and this package's version. Each default is
 * reached only when a run is requested.
 */
export interface CodexBackendDeps {
	readContract?: (name: string) => string;
	env?: NodeJS.ProcessEnv;
	launch?: (request: CodexLaunchRequest) => CodexLaunch;
	start?: (options: CodexChildOptions) => Promise<CodexChild>;
	cleanup?: OwnedCleanup;
	bounds?: Partial<CodexBounds>;
	clientInfo?: () => CodexClientInfo;
	now?: () => number;
	onCall?: (report: CodexCallReport) => void;
}

const readRoleContract = (name: string): string => readFileSync(path.join(CODEX_CONTRACTS_DIR, name), "utf8");

/** A realpath where there is something to resolve and otherwise the normalized path: both sides of a compare go through it. */
const canonical = (file: string): string => {
	try {
		return realpathSync.native(file);
	} catch {
		return path.normalize(file);
	}
};

/** How many steers may wait unsent at once. A push past it is answered `false` rather than queued or dropped. */
export const CODEX_STEER_QUEUE_MAX = 32;

/** Where one steer goes: the one admitted turn it is meant for, through the transport's one attempt. */
export type CodexSteerSink = (text: string) => Promise<CodexSteerResult>;

/**
 * The steers of one run, in the order they were pushed. It is open from the run's admission, holds what it is handed
 * until a sink is attached — which is when the run's turn is admitted and named — and then sends them one at a time,
 * one attempt each, accounting for every one. It never retries: a steer that was refused, or whose answer never came,
 * was a message about work that may since have moved on, and sending it again could deliver it twice.
 *
 * `end` is final: what is still queued is dropped and counted, an attempt already in flight is left to settle, and
 * `idle` is how a caller waits for it. A push this queue would not take — not text, empty, closed, or no room — is
 * answered `false` and counted nowhere, because it never became a delivery.
 */
export class CodexSteerQueue implements ChildControl {
	private readonly queued: string[] = [];
	private readonly counts: CodexSteerReport = { pushed: 0, accepted: 0, rejected: 0, unconfirmed: 0, unsent: 0, dropped: 0 };
	private closed = false;
	private sink: CodexSteerSink | undefined = undefined;
	private draining: Promise<void> | undefined = undefined;

	get open(): boolean {
		return !this.closed;
	}

	push(text: string): boolean {
		if (typeof text !== "string" || text === "" || this.closed || this.queued.length >= CODEX_STEER_QUEUE_MAX) return false;
		this.queued.push(text);
		this.counts.pushed += 1;
		this.pump();
		return true;
	}

	/** The one sink this queue sends through. A second is one run's steers composed onto another's turn, and is refused. */
	attach(sink: CodexSteerSink): void {
		if (typeof sink !== "function") throw new TypeError("a steer queue sends through a function, and this is not one");
		if (this.sink !== undefined) throw new TypeError("a steer queue sends to one turn, and this one already has one");
		this.sink = sink;
		this.pump();
	}

	end(): void {
		if (this.closed) return;
		this.closed = true;
		this.counts.dropped += this.queued.length;
		this.queued.length = 0;
	}

	/** Resolves when nothing is in flight. It never rejects: an attempt's own end is a count, not a throw. */
	async idle(): Promise<void> {
		while (this.draining !== undefined) await this.draining;
	}

	report(): CodexSteerReport {
		return { ...this.counts };
	}

	private pump(): void {
		if (this.draining !== undefined || this.sink === undefined || this.closed || this.queued.length === 0) return;
		this.draining = this.drain();
	}

	/** One at a time, in order: a steer sent beside the one before it would race it. Nothing is sent once closed. */
	private async drain(): Promise<void> {
		try {
			while (!this.closed) {
				const text = this.queued.shift();
				if (text === undefined) return;
				await this.attempt(text);
			}
		} finally {
			this.draining = undefined;
		}
	}

	private async attempt(text: string): Promise<void> {
		const sink = this.sink;
		if (sink === undefined) return;
		try {
			const result = await sink(text);
			if (result.outcome === "accepted") this.counts.accepted += 1;
			else this.counts.rejected += 1;
		} catch (error) {
			// The transport's own refusal is a steer it never wrote. Anything else — no answer inside the bound, a child that
			// ended or closed with it in flight, an answer that named another turn — leaves whether it arrived unknown.
			if (!(error instanceof CodexTransportError) || error.kind === "refused") this.counts.unsent += 1;
			else this.counts.unconfirmed += 1;
		}
	}
}

/** What driving the child settled, before its one shutdown. */
interface Driven {
	verdict: CodexVerdict;
	thread?: string;
	/** A fork's starting checkpoint: the completed turn its new thread reported as its tip before this call's turn. */
	start?: string;
	evidence?: CodexTurnEvidence;
}

/** Why a run was handed a session no `codexSession` made: refused before anything is read, located or started. */
export const CODEX_SESSION_INVALID = "the codex backend was handed a session it did not map, so nothing was started";

async function runCodexCall(request: RunRequest<CodexRole, CodexSession, ChildControl>, deps: CodexBackendDeps): Promise<CodexRun> {
	const now = deps.now ?? Date.now;
	const started = now();
	const role = request.role;
	const run = newCodexRun(role);
	const report: CodexCallReport = { stage: "aborted-before-start", launchCalled: false, startCalled: false, startResolved: false, shutdowns: 0 };
	const cancelled = (): boolean => request.signal?.aborted === true;
	// Refused before anything is read or located: only a session this backend's own mapping made is run.
	const session: CodexSession = request.session ?? { kind: "new" };
	if (!isCodexSession(session)) throw new Error(CODEX_SESSION_INVALID);
	const baseline = session.kind === "new" ? undefined : session.baseline;
	// Only a queue this backend made can be attached to a turn; any other control is a run that takes no steer.
	const queue = request.input instanceof CodexSteerQueue ? request.input : undefined;
	const closeInput = (): void => queue?.end();
	request.signal?.addEventListener("abort", closeInput, { once: true });

	const progress = (): void => {
		try {
			request.onProgress(run);
		} catch {}
	};
	const emit = (event: ChildEvent): void => {
		try {
			request.onEvent?.(event);
		} catch {}
	};
	const feed = codexFeed(run, { progress, event: emit }, baseline);

	/** The one way a call with a run to report ends: the mapping, its own terminal event and one last progress. */
	const finalize = (ending: CodexEnding): CodexRun => {
		feed.end();
		closeInput();
		const final = finishCodexRun(run, ending, now() - started, queue?.report());
		emit({ type: "turn_result", ok: !failed(final), ...(final.errorMessage === undefined ? {} : { message: final.errorMessage }) });
		progress();
		return final;
	};

	try {
		if (cancelled()) return finalize({ kind: "none" });

		const onQuestion = request.onQuestion;
		if (typeof onQuestion !== "function") {
			report.stage = "admission";
			throw new Error(CODEX_QUESTION_REQUIRED);
		}

		let instructions: string;
		try {
			const read = deps.readContract ?? readRoleContract;
			instructions = `${read(role.contract).trimEnd()}\n`;
		} catch (error) {
			report.stage = "contract";
			report.thrown = { error };
			throw new Error(CONTRACT_UNREADABLE, { cause: error });
		}

		let prepared: CodexLaunch;
		try {
			report.launchCalled = true;
			prepared = (deps.launch ?? codexLaunch)({ cwd: request.cwd, env: deps.env ?? process.env });
		} catch (error) {
			report.stage = "launch";
			report.thrown = { error };
			// Exactly as it came: the launch composes its own actionable sentence about the binary, the cwd or the home.
			throw error;
		}
		const clientInfo = (deps.clientInfo ?? codexClientInfo)();

		let child: CodexChild;
		try {
			report.startCalled = true;
			child = await (deps.start ?? startCodexChild)({
				launch: prepared.launch,
				clientInfo,
				onNotification: (notification) => feed.onNotification(notification),
				onQuestion,
				...(request.signal === undefined ? {} : { signal: request.signal }),
				...(request.killGraceMs === undefined ? {} : { killGraceMs: request.killGraceMs }),
				...(deps.cleanup === undefined ? {} : { cleanup: deps.cleanup }),
				...(deps.bounds === undefined ? {} : { bounds: deps.bounds }),
			});
		} catch (error) {
			report.thrown = { error };
			if (error instanceof CodexTransportError && error.finalExit !== undefined) {
				// The transport finished the child it never handed over and says how; nothing is stopped again from here.
				report.stage = "startup";
				const aborted = error.kind === "aborted" || cancelled();
				return finalize({ kind: "ended", verdict: { ok: false, stage: "startup", message: aborted ? RUN_ABORTED : error.message, aborted }, exit: error.finalExit, unverified: false });
			}
			// A start seam that threw without a report: a child may exist this host was never handed, so nothing is
			// stopped for it and nothing is claimed about it.
			report.stage = "start-rejected";
			return finalize({ kind: "ended", verdict: { ok: false, stage: "startup", message: RUN_UNVERIFIED, aborted: cancelled() }, unverified: true });
		}
		report.startResolved = true;

		let driven: Driven;
		try {
			driven = await drive(child, role, session, prepared, instructions, request, feed, run, queue, { progress, emit, cancelled, report });
		} catch (error) {
			// Nothing in `drive` is meant to throw; a value that does is reported as what it is and the child still stopped once.
			report.thrown = { error };
			driven = { verdict: { ok: false, stage: report.stage === "done" ? "verify" : (report.stage as CodexStage), message: RUN_UNVERIFIED, aborted: cancelled() } };
		}
		// Whatever the drive settled, the run takes no more input; a steer in flight settles with the child's shutdown.
		closeInput();

		let exit;
		let unverified = false;
		try {
			report.shutdowns += 1;
			exit = await child.shutdown(cancelled() ? "aborted" : "host");
		} catch (error) {
			report.thrown ??= { error };
			unverified = true;
		}
		await queue?.idle();
		return finalize({
			kind: "ended",
			verdict: driven.verdict,
			...(driven.thread === undefined ? {} : { thread: driven.thread }),
			...(driven.start === undefined ? {} : { start: driven.start }),
			...(baseline === undefined ? {} : { baseline }),
			...(driven.evidence === undefined ? {} : { evidence: driven.evidence }),
			...(exit === undefined ? {} : { exit }),
			unverified,
		});
	} finally {
		feed.end();
		closeInput();
		request.signal?.removeEventListener("abort", closeInput);
		try {
			deps.onCall?.(report);
		} catch {}
	}
}

interface DriveContext {
	progress(): void;
	emit(event: ChildEvent): void;
	cancelled(): boolean;
	report: CodexCallReport;
}

/** A failure from a stage's own call: the transport's sentence, and a cancellation named as one whichever layer saw it. */
const failedWith = (stage: CodexStage, error: unknown, cancelled: boolean, evidence?: CodexTurnEvidence): Driven => {
	const kind = error instanceof CodexTransportError ? error.kind : undefined;
	const aborted = cancelled || kind === "aborted";
	const message = aborted ? RUN_ABORTED : error instanceof CodexTransportError ? error.message : RUN_UNVERIFIED;
	return { verdict: { ok: false, stage, message, aborted }, ...(evidence === undefined ? {} : { evidence }) };
};

/** A refusal before any turn, with the thread it may name: one whose identity was already verified, and no other. */
const refused = (message: string, thread?: string): Driven => ({ verdict: { ok: false, stage: "thread", message, aborted: false }, ...(thread === undefined ? {} : { thread }) });

/**
 * The handshake check, the thread, the turn and the readback, on a child the caller owns and stops. It returns what it
 * settled and never stops the child itself.
 */
async function drive(
	child: CodexChild,
	role: CodexRole,
	session: CodexSession,
	prepared: CodexLaunch,
	instructions: string,
	request: RunRequest<CodexRole, CodexSession, ChildControl>,
	feed: ReturnType<typeof codexFeed>,
	run: CodexRun,
	queue: CodexSteerQueue | undefined,
	context: DriveContext,
): Promise<Driven> {
	const { report } = context;
	report.stage = "startup";
	if (canonical(child.initialize.codexHome) !== canonical(prepared.expectedCodexHome)) return { verdict: { ok: false, stage: "startup", message: HOME_MISMATCH, aborted: false } };

	report.stage = "thread";
	const fields = {
		...(role.model === undefined ? {} : { model: role.model }),
		...(role.provider === undefined ? {} : { modelProvider: role.provider }),
		sandbox: role.sandboxMode,
		approvalPolicy: role.approvalPolicy,
		developerInstructions: instructions,
	};
	let start: CodexThreadStart | CodexThreadResume;
	try {
		start =
			session.kind === "new"
				? await child.startThread(fields)
				: session.kind === "resume"
					? await child.resumeThread({ threadId: session.id, ...fields })
					: await child.forkThread({ threadId: session.from, lastTurnId: session.at, ...fields });
	} catch (error) {
		return failedWith("thread", error, context.cancelled());
	}
	// A fork's answer must name a thread of its own, forked from the one asked for when it says what it forked from. The
	// transport already holds a resume's answer to the thread it asked for.
	if (session.kind === "fork") {
		if (start.threadId === session.from) return refused(FORK_SAME_THREAD);
		const forkedFrom = (start as CodexThreadResume).forkedFromId;
		if (forkedFrom !== undefined && forkedFrom !== session.from) return refused(FORK_WRONG_SOURCE);
	}
	const problem = threadStartProblem(role, start, canonical(start.cwd), canonical(prepared.expectedCwd));
	if (problem !== undefined) return refused(problem);
	const thread = start.threadId;

	// A continued thread must still be where its record says, or a fork's new thread at a turn of its own that completed:
	// that turn is the fork's starting checkpoint. Its id is the child's, never assumed to be the source's checkpoint.
	let starting: string | undefined;
	if (session.kind !== "new") {
		let tip: CodexLatestTurn;
		try {
			tip = await child.latestTurn(thread);
		} catch (error) {
			return { ...failedWith("thread", error, context.cancelled()), thread };
		}
		if (session.kind === "resume") {
			if (tip.none || tip.turnId !== session.at) return refused(RESUME_MOVED, thread);
			if (tip.status !== "completed") return refused(RESUME_UNSETTLED, thread);
		} else {
			if (tip.none) return refused(FORK_NO_TIP, thread);
			if (tip.status !== "completed") return refused(FORK_TIP_UNSETTLED, thread);
			starting = tip.turnId;
		}
	}
	const at = (driven: Driven): Driven => ({ ...driven, thread, ...(starting === undefined ? {} : { start: starting }) });
	feed.thread(thread);
	run.session = { backend: "codex", sessionId: thread };
	run.sessionId = thread;
	run.modelId = start.model;
	run.activity = "waiting for model";
	context.emit({ type: "init", sessionId: thread });
	context.progress();

	report.stage = "turn";
	let turn;
	try {
		turn = await child.startTurn({ threadId: thread, text: request.prompt, ...(role.effort === undefined ? {} : { effort: role.effort }) });
	} catch (error) {
		return at(failedWith("turn", error, context.cancelled()));
	}
	feed.turn(turn.turnId);
	const key = { threadId: thread, turnId: turn.turnId };
	// The turn is named now, so what was pushed while it was not is sent to it, and only to it.
	queue?.attach((text) => child.steer(key, text));
	const result = await turn.done;
	queue?.end();
	if (result.outcome !== "completed") {
		const { message, aborted } = turnFailure(result, context.cancelled());
		return at({ verdict: { ok: false, stage: "turn", message, aborted }, evidence: turn.snapshot() });
	}
	if (result.terminalErrors > 0) return at({ verdict: { ok: false, stage: "turn", message: TERMINAL_ERROR, aborted: false }, evidence: turn.snapshot() });

	report.stage = "verify";
	run.activity = "verifying";
	context.progress();
	let read;
	try {
		// The barrier: the child's notifications ahead of this answer, late usage among them, are applied before it.
		read = await child.readThread(thread);
	} catch (error) {
		return at(failedWith("verify", error, context.cancelled(), turn.snapshot()));
	}
	const evidence = turn.snapshot();
	const fail = (message: string): Driven => at({ verdict: { ok: false, stage: "verify", message, aborted: false }, evidence });
	const final = evidence.finalMessage;
	if (final === undefined || final.text.trim() === "") return fail(NO_FINAL);
	if (evidence.usage === undefined) return fail(NO_USAGE);
	if (callUsage(evidence.usage.total, session.kind === "new" ? undefined : session.baseline) === undefined) return fail(USAGE_BASELINE_INCONSISTENT);
	if (canonical(read.cwd) !== canonical(prepared.expectedCwd)) return fail(CWD_READ_MISMATCH);
	const verified = verifySelection(role, start, read, evidence);
	if (!verified.ok) return fail(verified.message);
	report.stage = "done";
	// The checkpoint is the turn this call admitted and saw complete, and the baseline the thread's total read at the
	// barrier after it: never a predicted turn, and never a count a notification only displayed.
	return at({ verdict: { ok: true, text: final.text, cut: final.cut, selection: verified.selection, notes: verified.notes, checkpoint: turn.turnId, baseline: baselineOf(evidence.usage.total) }, evidence });
}

/**
 * A Codex backend over these seams. A factory rather than an instance, because a module-level one would be a backend
 * nobody decided to build; constructing one reads, locates and starts nothing, so the host builds its default at load
 * and a machine with no `codex` installed finds out only when a run routed here asks for it.
 */
export function createCodexBackend(deps: CodexBackendDeps = {}): Backend<CodexRole, CodexSession, ChildControl> {
	return {
		name: "codex",
		control: () => new CodexSteerQueue(),
		session: codexSession,
		run: (request) => runCodexCall(request, deps),
	};
}
