#!/usr/bin/env node
/*
 * Manual qualification harness for the Codex backend, run by hand and one agreed case group at a time. It is
 * not part of `npm test`: the default glob (`test/*.test.ts`) does not reach this directory, and a native run starts
 * the user's own Codex app-server on the user's own login, configuration and quota.
 *
 *   node test/spikes/codex-app-server.mjs --list
 *   node test/spikes/codex-app-server.mjs --run --case Q1,Q2,Q7,Q9            # model-free cases
 *   node test/spikes/codex-app-server.mjs --run --case Q3 --keep              # one model case
 *   node test/spikes/codex-app-server.mjs --run --fake --case Q1,Q2,Q4,Q6,Q7,Q9  # NOT NATIVE
 *   node test/spikes/codex-app-server.mjs --run --fake --case Q14             # NOT NATIVE
 *   node test/spikes/codex-app-server.mjs --run --fake --case Q10,Q11,Q12,Q13,Q19  # G2 cases, NOT NATIVE
 *   node test/spikes/codex-app-server.mjs --run --fake --case Q15,Q16          # G3 cases, NOT NATIVE
 *
 * Nothing runs without `--run` and an explicit `--case` (`all` is a deliberate value, not a default). `--help`,
 * `--list`, an unknown or malformed argument, a missing `--run` or a missing or unmatched `--case` exit 2 before any
 * production module is imported: no `PATH` lookup, no Codex home, configuration or auth read, no child.
 *
 * What a native run is. The production pieces, unchanged: `codexLaunch` over this process's environment (the host's
 * binary, `CODEX_HOME`/`~/.codex`, configuration, login, MCP servers, remote-control and multi-agent settings, all
 * inherited and nothing isolated), `startCodexChild`, and for every turn `createCodexBackend` with only these seams of
 * the harness's own: a launch that calls the production `codexLaunch` and keeps its answer, a start that calls the
 * production `startCodexChild` and records what its child answered (the raw notifications included, for command
 * items), `onCall`, a question callback, and for Q3 alone a contract reader that appends a nonce to the shared contract. Model-free cases
 * drive the transport directly with the thread/start body the backend composes, and so does Q14, which starts two
 * turns on one thread with the production transport because the backend runs one. No request names a cwd, a sandbox
 * policy or a configuration override, and `fusion.ts` and the host runtime take no part.
 *
 * G2's cases (Q10 to Q13, Q19) chain backend calls the way the host does: a later call's session is
 * `backend.session(intent)` over the earlier outcome's own reference, and its role `codexRole` over the earlier verified
 * selection. The start seam forwards the stage 2 methods too (thread/resume, thread/fork, the latest-turn read, a
 * steer) and keeps only safe facts of them: ids, selection fields, byte counts and answers' tags. Q11 alone adds one
 * direct-transport turn between two backend calls, to move the thread's tip with a turn that really completed.
 *
 * Every backend call carries the required question callback and so the shipping experimental connection shape. G3's
 * cases (Q15, Q16) script answers or waiting cancellation; other backend cases fail if a question is unexpectedly
 * asked rather than inventing an answer. Model-free cases and Q14 drive the lower-level transport without a callback.
 * Historical G1/G2 measurements predate this requirement and remain evidence of their stable connections only. G3
 * makes a new random answer per call inside its callback and prints no answer, question or report.
 *
 * What it never does. It copies, reads or prints no credential or auth file, logs in to nothing, injects no API key,
 * prints no environment, and writes no Codex configuration. `config.toml` in the predicted Codex home is hashed in
 * memory before and after every case to report a mutation, and searched only for the fixture's path (Q9), as a yes or
 * no; providers, MCP, profiles and the raw text are never read out or printed. Selection comes from the flags alone:
 * `PI_FUSION_CODEX_<ROLE>_MODEL`/`_EFFORT` are not read, and no model or effort catalogue is guessed.
 *
 * Evidence discipline. The sandbox and permissions are the user's own configuration, trusted as Claude's and Pi's are,
 * and no case re-audits them. A verdict reads the production outcome, the readbacks, the fixture's own state and the
 * child's exit report, never the model's prose. Missing evidence is unproven, never a pass, and a guard never passes a
 * case. The fixture root is removed only after every owned child is proved over with no cleanup concern, and otherwise
 * kept and named.
 *
 * `--fake` swaps the launch for `test/fake-codex.mjs` by path under this host's node: no Codex binary is located. A
 * fake run exercises this harness's flow and the production transport/backend against literals, and is NOT NATIVE
 * evidence of anything a real Codex does. A continuation under `--fake` tells the next fake process what the earlier
 * one left — the turns and the total, read from the record — through the fake's own history variables, which no
 * production request carries and a native run never sets.
 *
 * Exit codes: 0 when every selected case passed (annotated skips allowed), 1 when any failed or is unproven, 2 when no
 * case ran at all.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	additivity,
	CASES,
	cacheWriteObservation,
	canonicalPath,
	caseStatus,
	composeInstructions,
	contextProblem,
	coreDelta,
	CORE_FIELDS,
	describeCounters,
	EXIT,
	exitCode,
	fileDigest,
	forcedExitNotice,
	GROUPS,
	parseArgs,
	publishedUsageProblems,
	questionProof,
	selectCases,
	steerProof,
	threadParams,
	USAGE,
	USAGE_FIELDS,
	usageCounters,
	usageProblem,
	versionFromUserAgent,
	WARNING,
} from "./codex-app-server-cases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FAKE_CODEX = path.join(REPO, "test", "fake-codex.mjs");
const FENCE = path.join(REPO, "test", "sdk-fence.mjs");

/** How long one model case may run before the harness cancels it through the production signal. */
const MODEL_CASE_MS = 10 * 60_000;
/** How long a cancelled run, or a child's exit, is waited for before the root is kept as uncertain. */
const SETTLE_MS = 90_000;
/** Raw notifications one child's record keeps; past it they are counted and dropped. */
const NOTIFICATION_CAP = 20_000;
/** Usage updates Q14 prints per turn; past it they are still counted and summed, and the rest is said. */
const USAGE_PRINT_CAP = 16;

async function main(cli) {
	if (cli.unknown.length > 0 || cli.problems.length > 0) {
		for (const arg of cli.unknown) console.log(`unrecognised argument: ${arg}`);
		for (const problem of cli.problems) console.log(problem);
		console.log("see --help; nothing ran");
		return EXIT.none;
	}
	if (cli.help) {
		console.log(USAGE);
		return EXIT.none;
	}
	if (cli.list) {
		console.log("cases ([model] starts a turn: a provider request on your login, USD unknown; [fake] runs under --fake):");
		for (const entry of CASES) console.log(`  ${entry.id.padEnd(4)} ${entry.model ? "[model]" : "       "} ${entry.fake ? "[fake]" : "      "} ${entry.title}`);
		console.log("groups:");
		for (const [name, members] of Object.entries(GROUPS)) console.log(`  ${name.padEnd(11)} ${members.join(", ")}`);
		console.log("\nG1 needs Q1, Q2, Q3, Q4, Q6, Q7 and Q9 to PASS natively; Q3b is optional named-effort evidence and does not block it.");
		console.log("G2 needed Q10, Q11, Q12, Q13 and Q19 to PASS natively, and they did, once each on one host, on connections with no question callback.");
		console.log("G3 needed Q15 and Q16 to PASS natively, and they did, once each on one host under its default model: ask questions on fresh, resumed and forked threads and a cancellation while one waited, in the experimental question shape.");
		console.log("Q14 is stage 2 preparation, a usage measurement outside G1 and G2; Q14b's per-call usage is folded into Q10 and Q12.");
		console.log("\nNative results so far: docs/codex-backend.md.");
		return EXIT.none;
	}
	if (!cli.run) {
		console.log("nothing runs without --run: no codex is located, no Codex home or configuration is read, no child starts");
		console.log(`\n${WARNING}`);
		return EXIT.none;
	}
	const selection = selectCases(cli.case);
	if (selection.error) {
		console.log(`${selection.error}; nothing ran`);
		return EXIT.none;
	}
	return runSelected(cli, selection.cases);
}

/* ------------------------------------------------------------------------------------------------------------------
 * the run
 * ---------------------------------------------------------------------------------------------------------------- */

/** The production modules, imported only once a run is asked for, so a guard path loads none of them. */
async function loadProduction() {
	const [binding, launch, backend, outcome, transport, protocol, types] = await Promise.all([
		import("../../extensions/backends/codex-binding.ts"),
		import("../../extensions/backends/codex-launch.ts"),
		import("../../extensions/backends/codex.ts"),
		import("../../extensions/backends/codex-outcome.ts"),
		import("../../extensions/backends/codex-transport.ts"),
		import("../../extensions/backends/codex-protocol.ts"),
		import("../../extensions/backends/types.ts"),
	]);
	return { ...binding, ...launch, ...backend, ...outcome, ...transport, ...protocol, failed: types.failed };
}

async function runSelected(cli, cases) {
	const fake = cli.fake;
	const label = fake ? " [FAKE, NOT NATIVE]" : "";
	console.log(`pi-fusion codex app-server qualification harness (${fake ? "FAKE" : "NATIVE"})`);
	if (fake) console.log("FAKE LAUNCH: test/fake-codex.mjs by path under this node. NOT NATIVE EVIDENCE: nothing below says what a real Codex does.");
	else console.log(WARNING);
	console.log(`node ${process.version}, ${process.platform}-${process.arch}, ${new Date().toISOString()}`);
	console.log(`selected: ${cases.map((entry) => entry.id).join(", ")}`);
	const flags = ["model", "effort"].filter((key) => cli[key] !== undefined).map((key) => `${key}=${cli[key]}`);
	console.log(`options: ${flags.length === 0 ? "none" : flags.join(", ")}`);

	const mod = await loadProduction();
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-codex-qual-"));
	fs.chmodSync(root, 0o700);
	const ctx = new Context(cli, mod, root);
	console.log(`fixture root: ${root}`);
	console.log(`protocol shapes: ${mod.CODEX_PROTOCOL_PROVENANCE.evidence} of Codex ${mod.CODEX_PROTOCOL_PROVENANCE.version}, ${mod.CODEX_PROTOCOL_PROVENANCE.runtime}; client ${JSON.stringify(mod.codexClientInfo())}`);

	try {
		ctx.prepare();
	} catch (error) {
		console.log(`setup failed before any case: ${message(error)}`);
		ctx.finish();
		return EXIT.failure;
	}
	console.log(`codex: ${ctx.executable}`);
	console.log(`predicted Codex home: ${ctx.codexHome}`);
	console.log(`config.toml: ${short(ctx.digest())}`);

	const signals = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
		const handler = () => {
			if (ctx.interrupted) {
				// No cleanup, survey or claim from here: only what is left behind, said before the process goes.
				process.stdout.write(`\n${forcedExitNotice(ctx.root)}\n`);
				process.exit(EXIT.failure);
			}
			console.log(`\n${signal}: cancelling the running case through the production signal; again to exit at once`);
			ctx.interrupt();
		};
		process.on(signal, handler);
		return [signal, handler];
	});
	const results = [];
	try {
		for (const entry of cases) {
			const result = new CaseResult(entry);
			console.log(`\n== ${entry.id}${entry.model && !fake ? " [model]" : ""}: ${entry.title} ==`);
			// A case missing its option skips before anything starts, in either mode, so it runs to that skip here too.
			const unmet = entry.needs !== undefined && ctx.cli[entry.needs] === undefined;
			if (ctx.interrupted) result.skip("the harness was interrupted before this case");
			else if (fake && !entry.fake && !unmet) result.skip("needs a native child that really runs a model and commands; the fake app-server cannot");
			else {
				const before = ctx.digest();
				try {
					await RUNNERS[entry.id](ctx, result);
				} catch (error) {
					result.fail(`case threw: ${message(error)}`);
					ctx.keep(`${entry.id} threw`);
				}
				const after = ctx.digest();
				result.fact("config.toml before/after", `${short(before)} / ${short(after)}`);
				result.guard(before === after, "config.toml bytes unchanged by this case");
			}
			results.push(result);
			console.log(`  RESULT ${entry.id}: ${result.status}${result.status === "skip" || result.status === "unproven" ? ` (${result.reason})` : ""}${label}`);
		}
	} finally {
		for (const [signal, handler] of signals) process.removeListener(signal, handler);
		ctx.finish();
	}
	console.log(`\nsummary${label}`);
	for (const result of results) console.log(`  ${result.id.padEnd(4)} ${result.status}${result.status !== "pass" && result.reason ? ` - ${result.reason}` : ""}`);
	const statuses = results.map((result) => result.status);
	const code = ctx.interrupted ? EXIT.failure : exitCode(statuses);
	console.log(`exit ${code}${label}`);
	return code;
}

/**
 * One case's checks and facts, printed as they happen. Its own measurements are kept apart from the guards around them
 * (configuration, shutdown, approvals, preflight): a guard can fail a case or leave it unproven, never pass it.
 */
class CaseResult {
	constructor(entry) {
		this.id = entry.id;
		this.parts = [];
	}
	get status() {
		return caseStatus(this.parts.filter((part) => !part.guard).map((part) => part.status), this.parts.filter((part) => part.guard).map((part) => part.status));
	}
	get reason() {
		const status = this.status;
		// A skipped case is explained by its own skip, never by a guard that held around it.
		return this.parts.find((part) => part.status === status && (status !== "skip" || !part.guard))?.why;
	}
	fact(key, value) {
		console.log(`    ${key}: ${value}`);
	}
	add(status, why, guard = false) {
		this.parts.push({ status, why, guard });
		console.log(`    ${status.toUpperCase()}${guard ? " (guard)" : ""} ${why}`);
	}
	/** A primary measurement of what the case is about. */
	check(ok, what) {
		this.add(ok ? "pass" : "fail", what);
		return ok;
	}
	/** A guard: its failure fails the case, its pass proves nothing about what the case measures. */
	guard(ok, what) {
		this.add(ok ? "pass" : "fail", what, true);
		return ok;
	}
	fail(why) {
		this.add("fail", why);
	}
	skip(why) {
		this.add("skip", why);
	}
	unproven(why) {
		this.add("unproven", why);
	}
}

/** What every case shares: the mode, the root, what is kept and why, and the launch each child gets. */
class Context {
	constructor(cli, mod, root) {
		this.cli = cli;
		this.mod = mod;
		this.root = root;
		this.fake = cli.fake;
		this.keepReasons = [];
		this.abort = new AbortController();
		this.interrupted = false;
	}

	/** Where the binary and home come from. Native: the production launch, which locates codex now. Fake: no lookup. */
	prepare() {
		if (this.fake) {
			this.fakeHome = path.join(this.root, "fake-codex-home");
			fs.mkdirSync(this.fakeHome);
			this.codexHome = this.mod.expectedCodexHome(this.fakeEnv("ok"), this.root);
			this.executable = `${FAKE_CODEX} (fake, by path under ${process.execPath})`;
			return;
		}
		const prepared = this.mod.codexLaunch({ cwd: this.root, env: process.env });
		this.codexHome = prepared.expectedCodexHome;
		this.executable = `${prepared.executable.path} (${prepared.executable.source === "override" ? "PI_FUSION_CODEX_BIN" : "first codex on PATH"})`;
	}

	get configPath() {
		return path.join(this.codexHome, "config.toml");
	}

	digest() {
		return fileDigest(this.configPath);
	}

	/** Whether config.toml mentions a path, as a yes or no; its text is never kept or shown. */
	configMentions(text) {
		try {
			return fs.readFileSync(this.configPath, "utf8").includes(text);
		} catch {
			return false;
		}
	}

	/**
	 * A fake child's environment. The fake's own `FAKE_CODEX_*` variables, when already set, win over the case's scenario
	 * and its extras: a seam for exercising this harness's failure branches under `--fake`, read by the fake alone and
	 * never native. `extra` is a case's fake-only cross-process history.
	 */
	fakeEnv(scenario, extra = {}) {
		const unset = Object.fromEntries(Object.entries(extra).filter(([key]) => process.env[key] === undefined));
		return { ...process.env, ...unset, FAKE_CODEX_SCENARIO: process.env.FAKE_CODEX_SCENARIO ?? scenario, CODEX_HOME: this.fakeHome };
	}

	/** One launch. Native is exactly `codexLaunch` over this process's environment; fake is the fixture by path. */
	launchFor(cwd, scenario = "ok", env) {
		if (!this.fake) return this.mod.codexLaunch({ cwd, env: env ?? process.env });
		const childEnv = env ?? this.fakeEnv(scenario);
		return {
			launch: { command: process.execPath, args: ["--import", pathToFileURL(FENCE).href, FAKE_CODEX, ...this.mod.CODEX_APP_SERVER_ARGS], cwd, env: { ...childEnv } },
			executable: { command: process.execPath, prefix: [FAKE_CODEX], path: FAKE_CODEX, source: "override" },
			expectedCwd: fs.realpathSync(cwd),
			expectedCodexHome: this.mod.expectedCodexHome(childEnv, cwd),
		};
	}

	caseDir(id) {
		const dir = path.join(this.root, "cases", id);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	keep(why) {
		this.keepReasons.push(why);
	}

	interrupt() {
		this.interrupted = true;
		this.abort.abort();
	}

	/** Removes the root, unless something kept it. */
	finish() {
		if (this.keepReasons.length > 0 || this.cli.keep) {
			console.log(`\nkept: ${this.root}${this.keepReasons.length > 0 ? ` (${[...new Set(this.keepReasons)].join("; ")})` : " (--keep)"}`);
			return;
		}
		fs.rmSync(this.root, { recursive: true, force: true });
		console.log(`\nremoved: ${this.root} (every owned child ended with no cleanup concern)`);
	}
}

/* ------------------------------------------------------------------------------------------------------------------
 * shared pieces
 * ---------------------------------------------------------------------------------------------------------------- */

const message = (error) => (error instanceof Error ? error.message : String(error));
const short = (digest) => (/^[0-9a-f]{64}$/.test(digest) ? `sha256:${digest.slice(0, 16)}` : digest);
const token = (id, name) => `pfq-${id.toLowerCase()}-${name}-${randomBytes(6).toString("hex")}`;

async function bounded(promise, ms) {
	let timer;
	try {
		return await Promise.race([promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })), new Promise((resolve) => (timer = setTimeout(() => resolve({ ok: false, timeout: true }), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

/** How a child ended, the way the cases print it. */
function describeExit(exit) {
	if (!exit) return "no exit report";
	return `root=${exit.cleanup.root} code=${exit.exit.code} signal=${exit.exit.signal} cleanExit=${exit.cleanExit} stopRequested=${exit.stopRequested} leftovers=${exit.cleanup.leftovers.length} discovery=${exit.cleanup.discovery} stdio=${exit.cleanup.stdio} streamsUnclosed=${exit.counters.streamsUnclosed} failure=${exit.failure ? `${exit.failure.kind}: ${exit.failure.message}` : "none"}`;
}

/** No cleanup concern: a clean actual exit, nothing left, discovery and pipes settled. `aborted` is a requested stop. */
function cleanlyOver(exit, allowAborted = false) {
	return Boolean(exit && exit.cleanExit && exit.cleanup.leftovers.length === 0 && exit.cleanup.discovery === "ok" && exit.cleanup.stdio === "closed" && exit.counters.streamsUnclosed === 0 && (exit.failure === undefined || (allowAborted && exit.failure.kind === "aborted")));
}

/**
 * Keeps the fixtures whenever a child this harness was handed, or may have spawned, is not proved over: a missing exit
 * report, an unclean actual exit, a leftover, failed discovery, held stdio or an unclosed pipe. A requested stop is not
 * a concern. The two child helpers call this themselves, so no case's early return can skip it.
 */
function retainUnlessOver(ctx, id, exit, what) {
	if (!cleanlyOver(exit, true)) ctx.keep(`${id}: ${what} is not proved over (${describeExit(exit)})`);
}

/** The shutdown check every child gets: reported as a pass or a failure, and the fixtures kept on any concern. */
function checkShutdown(ctx, result, exit, what, allowAborted = false) {
	result.fact(`${what} exit`, describeExit(exit));
	retainUnlessOver(ctx, result.id, exit, what);
	return result.guard(cleanlyOver(exit, allowAborted), `${what}: owned shutdown clean (clean actual exit, no leftovers, discovery ok, pipes closed${allowAborted ? ", a requested abort allowed" : ""})`);
}

/** The reported sandbox mode only: the rest of its policy is the user's own configuration and is not judged here. */
function describeSandbox(sandbox) {
	return sandbox ? `type=${sandbox.type}` : "none reported";
}

function describeStart(start) {
	return `thread=${start.threadId} model=${start.model} provider=${start.modelProvider} effort=${start.reasoningEffort} approvalPolicy=${start.approvalPolicy ?? "unread"} cwd=${start.cwd}`;
}

function describeRead(read) {
	return `model=${read.model} provider=${read.modelProvider} effort=${read.reasoningEffort} status=${read.status.type} cwd=${read.cwd}`;
}

/** A shipped contract file, read the way the backend's default reader does. */
function productionContract(mod, name) {
	return fs.readFileSync(path.join(mod.CODEX_CONTRACTS_DIR, name), "utf8");
}

/** The thread/start body the backend sends for a role, with the shipped contracts (pinned to the backend by a test). */
const roleThreadParams = (mod, role) => threadParams(role, composeInstructions(role, (name) => productionContract(mod, name)));

/**
 * One child driven directly through the production transport: launch, handshake, the body, and one host shutdown.
 * Used where a case must not start a turn, and by Q14, whose two turns on one thread the backend does not run.
 */
async function withChild(ctx, cwd, body, { scenario = "ok", fakeExtra, onNotification } = {}) {
	const prepared = ctx.launchFor(cwd, scenario, ctx.fake && fakeExtra ? ctx.fakeEnv(scenario, fakeExtra) : undefined);
	let child;
	try {
		child = await ctx.mod.startCodexChild({ launch: prepared.launch, clientInfo: ctx.mod.codexClientInfo(), signal: ctx.abort.signal, ...(onNotification ? { onNotification } : {}) });
	} catch (error) {
		const exit = error && error.finalExit ? error.finalExit : undefined;
		retainUnlessOver(ctx, "child start", exit, "a child that failed to start");
		return { prepared, startError: error, ...(exit ? { exit } : {}) };
	}
	let value;
	let thrown;
	try {
		value = await body(child, prepared);
	} catch (error) {
		thrown = error;
	}
	let exit;
	try {
		exit = await child.shutdown("host");
	} catch {}
	retainUnlessOver(ctx, "child", exit, `the child in ${cwd}`);
	return { prepared, child, value, thrown, exit };
}

/** A model-free thread/start for a role, to read the selection a later turn would run under. */
async function preflightStart(ctx, result, cwd, call) {
	const role = ctx.mod.codexRole(call, undefined, {});
	const outcome = await withChild(ctx, cwd, (child) => child.startThread(roleThreadParams(ctx.mod, role)));
	if (outcome.startError || outcome.thrown) {
		result.unproven(`preflight thread/start failed: ${message(outcome.startError ?? outcome.thrown)}`);
		checkShutdown(ctx, result, outcome.exit, "preflight child");
		return undefined;
	}
	result.fact("preflight thread/start (no turn)", describeStart(outcome.value));
	result.fact("preflight sandbox", describeSandbox(outcome.value.sandbox));
	if (!checkShutdown(ctx, result, outcome.exit, "preflight child")) return undefined;
	return outcome.value;
}

/**
 * The production backend over seams that only observe: the production launch (kept), the production start (its child
 * recorded, every raw notification teed), `onCall`, and optionally a contract reader. Cancels through the production
 * signal on the case deadline or an interrupt, and waits for every handed child to exit before answering.
 *
 * A continuation is asked for as the host asks: `intent` goes through `backend.session`, and `recorded`, the selection
 * the earlier run verified, through `codexRole`. The child the backend is handed forwards every method it drives and
 * keeps, of the stage 2 ones, only safe facts: the request's ids and selection fields, the latest-turn answers, and
 * each steer's key, byte count and outcome. `fakeExtra` is a fake child's cross-process history, never native.
 *
 * Every run gets a question callback, `(question, signal)` as the host passes one. A scripted `onQuestion` is handed
 * the run's controller and record beside them; without one an unexpected question fails the case and the callback.
 * The record counts calls and whether their turn had already completed.
 */
async function backendRun(ctx, result, { call, prompt, cwd, leg, scenario = "ok", intent = { kind: "new" }, recorded, fakeExtra, readContract, onNotification, onTurn, onQuestion, deadlineMs = MODEL_CASE_MS, allowAborted = false }) {
	const { mod } = ctx;
	if (leg !== undefined) result.fact("call", leg);
	const record = { notifications: [], dropped: 0, methods: [], tips: [], steers: [], turnStarts: 0, questions: 0, questionAfterCompletion: false };
	const env = ctx.fake ? ctx.fakeEnv(scenario, fakeExtra) : undefined;
	const controller = new AbortController();
	const backend = mod.createCodexBackend({
		...(env === undefined ? {} : { env }),
		launch: (request) => (record.launch = ctx.launchFor(request.cwd, scenario, request.env)),
		start: (options) => startObserved(mod, record, options, { onNotification: (notification) => onNotification?.(notification, controller, record), onTurn: (turn) => onTurn?.(turn, controller, record) }),
		...(readContract === undefined ? {} : { readContract }),
		onCall: (report) => (record.report = report),
	});
	const role = mod.codexRole(call, recorded, {});
	record.role = role;
	let session;
	try {
		session = backend.session(intent);
	} catch (error) {
		result.fail(`the backend's session mapping refused the ${intent.kind} intent before anything started: ${message(error)}`);
		return record;
	}
	record.input = backend.control();
	const cancel = () => controller.abort();
	ctx.abort.signal.addEventListener("abort", cancel, { once: true });
	let deadlineHit = false;
	const timer = setTimeout(() => {
		deadlineHit = true;
		controller.abort();
	}, deadlineMs);
	const ask = (question, signal) => {
		record.questions += 1;
		// The turn/start answer may not have reached the record yet: a question held for it is asked as it lands.
		if (record.turn?.snapshot().completion !== undefined) record.questionAfterCompletion = true;
		if (onQuestion === undefined) {
			result.fail("the child asked a question but this case has no scripted answer");
			throw new Error("no scripted answer for an unexpected question");
		}
		return onQuestion(question, signal, controller, record);
	};
	const running = backend.run({ role, prompt, cwd, session, signal: controller.signal, input: record.input, onQuestion: ask, onProgress: () => {}, onEvent: () => {} });
	let settled = await bounded(running, deadlineMs + SETTLE_MS);
	clearTimeout(timer);
	ctx.abort.signal.removeEventListener("abort", cancel);
	if (settled.timeout) {
		controller.abort();
		settled = await bounded(running, SETTLE_MS);
	}
	if (deadlineHit) result.fact("deadline", `the case deadline of ${deadlineMs}ms cancelled the run`);
	if (!settled.ok) {
		ctx.keep(`${result.id}: the backend run did not come back`);
		result.unproven(settled.timeout ? "the backend run did not come back after cancellation" : `the backend run threw: ${message(settled.error)}`);
		return record;
	}
	record.run = settled.value;
	if (record.child) {
		const exited = await bounded(record.child.exited, SETTLE_MS);
		if (exited.ok) record.exit = exited.value;
	}
	if (record.turn) record.evidence = record.turn.snapshot();
	describeRun(ctx, result, record);
	// Reported here, before any case reads the record, so an early return in a case cannot skip either.
	if (record.report?.startCalled) {
		const declined = (record.evidence?.denialCount ?? 0) + (record.exit?.counters.declinedApprovals ?? 0);
		result.guard(declined === 0, `no approval requested under approval never (declined ${declined})`);
		checkShutdown(ctx, result, record.exit, leg === undefined ? "child" : `${leg} child`, allowAborted);
	}
	return record;
}

/**
 * The production start, with the child it answers recorded and every raw notification teed, handed back as a child
 * that forwards each method the backend drives. Nothing is changed on the way through, and nothing is sent that the
 * backend did not send.
 */
async function startObserved(mod, record, options, hooks) {
	const tee = (notification) => {
		if (record.notifications.length < NOTIFICATION_CAP) record.notifications.push(notification);
		else record.dropped += 1;
		try {
			hooks.onNotification(notification);
		} catch {}
	};
	let child;
	try {
		child = await mod.startCodexChild({ ...options, onNotification: (notification) => (tee(notification), options.onNotification?.(notification)) });
	} catch (error) {
		if (error && error.finalExit) record.exit = error.finalExit;
		record.startError = error;
		throw error;
	}
	record.child = child;
	record.initialize = child.initialize;
	record.questionCallback = typeof options.onQuestion === "function";
	return {
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
		startThread: async (params, timeoutMs) => {
			record.methods.push("thread/start");
			record.threadMethod = "thread/start";
			record.threadParams = params;
			record.thread = await child.startThread(params, timeoutMs);
			return record.thread;
		},
		resumeThread: async (params, timeoutMs) => {
			record.methods.push("thread/resume");
			record.threadMethod = "thread/resume";
			record.threadParams = params;
			record.thread = await child.resumeThread(params, timeoutMs);
			return record.thread;
		},
		forkThread: async (params, timeoutMs) => {
			record.methods.push("thread/fork");
			record.threadMethod = "thread/fork";
			record.threadParams = params;
			record.thread = await child.forkThread(params, timeoutMs);
			return record.thread;
		},
		latestTurn: async (threadId, timeoutMs) => {
			record.methods.push("thread/turns/list");
			const answer = await child.latestTurn(threadId, timeoutMs);
			record.tips.push({ threadId, tip: answer.none ? { none: true } : { none: false, turnId: answer.turnId, status: answer.status } });
			return answer;
		},
		startTurn: async (params, timeoutMs) => {
			record.methods.push("turn/start");
			record.turnStarts += 1;
			record.turnParams = params;
			record.turn = await child.startTurn(params, timeoutMs);
			try {
				hooks.onTurn(record.turn);
			} catch {}
			return record.turn;
		},
		steer: async (key, text, timeoutMs) => {
			record.methods.push("turn/steer");
			const entry = { threadId: key.threadId, turnId: key.turnId, bytes: Buffer.byteLength(text), outcome: "pending" };
			record.steers.push(entry);
			try {
				const answer = await child.steer(key, text, timeoutMs);
				entry.outcome = answer.outcome === "accepted" ? "accepted" : `refused (${answer.failure.kind})`;
				return answer;
			} catch (error) {
				entry.outcome = `no answer (${error instanceof mod.CodexTransportError ? error.kind : "thrown"})`;
				throw error;
			}
		},
		readThread: async (threadId, timeoutMs) => {
			record.methods.push("thread/read");
			record.read = await child.readThread(threadId, timeoutMs);
			return record.read;
		},
		interrupt: (turn, timeoutMs) => child.interrupt(turn, timeoutMs),
		threadStatus: (threadId) => child.threadStatus(threadId),
		shutdown: (reason) => child.shutdown(reason),
	};
}

/** What every backend run prints: the production verdict, the selection, the readbacks and the turn's evidence. */
function describeRun(ctx, result, record) {
	const run = record.run;
	result.fact("production verdict", `${ctx.mod.failed(run) ? "failed" : "success"} stopReason=${run.stopReason}${run.errorMessage ? ` error=${JSON.stringify(run.errorMessage)}` : ""} stage=${record.report?.stage ?? "unknown"}`);
	if (record.initialize) result.fact("initialize", `userAgent=${JSON.stringify(record.initialize.userAgent)} home=${record.initialize.codexHome}`);
	if (record.threadParams) {
		const params = record.threadParams;
		const ids = record.threadMethod === "thread/start" ? "" : `threadId=${params.threadId} ${params.lastTurnId === undefined ? "" : `lastTurnId=${params.lastTurnId} `}`;
		result.fact(`${record.threadMethod} sent`, `${ids}model=${params.model ?? "(host default)"} provider=${params.modelProvider ?? "(none)"} sandbox=${params.sandbox} approvalPolicy=${params.approvalPolicy} instructions=${Buffer.byteLength(params.developerInstructions)}B no cwd${record.threadMethod === "thread/start" ? "" : " (the transport adds excludeTurns: true)"}`);
	}
	if (record.thread) {
		result.fact(`${record.threadMethod} answer`, `${describeStart(record.thread)}${record.threadMethod === "thread/fork" ? ` forkedFromId=${record.thread.forkedFromId ?? "(not reported)"}` : ""}`);
		result.fact("reported sandbox", describeSandbox(record.thread.sandbox));
	}
	for (const { threadId, tip } of record.tips) result.fact("latest turn read", `thread=${threadId} ${tip.none ? "none" : `turn=${tip.turnId} status=${tip.status}`}`);
	if (record.turnParams) result.fact("turn/start sent", `prompt=${Buffer.byteLength(record.turnParams.text)}B effort=${record.turnParams.effort ?? "(none)"}`);
	for (const steer of record.steers) result.fact("turn/steer sent", `thread=${steer.threadId} expectedTurnId=${steer.turnId} input=${steer.bytes}B outcome=${steer.outcome}`);
	if (record.read) result.fact("thread/read answer", describeRead(record.read));
	result.fact("request order", record.methods.length === 0 ? "none" : record.methods.join(" > "));
	if (record.questionCallback !== undefined) {
		const counters = record.exit?.counters;
		result.fact("question callback", `${record.questionCallback ? "handed to the start (the transport opts in)" : "none (no opt-in, no tool)"}; callbacks=${record.questions} child questions=${counters?.questions ?? "unknown"} refused=${counters?.refusedQuestions ?? "unknown"} repeatedRequestIds=${counters?.duplicateServerRequests ?? "unknown"}`);
	}
	if (run.selection) result.fact("verified selection", JSON.stringify(run.selection));
	if (run.session) result.fact("outcome reference", describeRef(run.session));
	const evidence = record.evidence;
	if (evidence) {
		result.fact("turn", `completion=${evidence.completion ? evidence.completion.status : "none"} usage=${evidence.usage ? "reported" : "none"} items=${evidence.items.completed} reroutes=${evidence.rerouteCount} denials=${evidence.denialCount} retryableErrors=${evidence.retryableErrors} terminalErrors=${evidence.terminalErrors}`);
		result.fact("item types (primary turn)", JSON.stringify(itemTypes(record)));
	}
	result.fact("tokens", `in=${run.tokensIn} out=${run.tokensOut} cacheRead=${run.cacheRead} cacheWrite=${run.cacheWrite} (cache write vs input: Q14, unqualified) cost=unknown (Codex reports none; never estimated)`);
	if (record.dropped > 0) result.fact("notifications dropped past the cap", String(record.dropped));
}

/** A Codex outcome reference as one line: the thread, its checkpoint and the five core counts of its baseline. */
function describeRef(ref) {
	const baseline = ref.baseline === undefined ? "none" : `${CORE_FIELDS.map((field) => `${field}=${ref.baseline[field]}`).join(" ")} cacheWriteInputTokens=${ref.baseline.cacheWriteInputTokens ?? "absent"}`;
	return `backend=${ref.backend} thread=${ref.sessionId} checkpoint=${ref.checkpoint ?? "none"} baseline: ${baseline}`;
}

/** Completed item types in the primary turn, counted from the raw notifications. */
function itemTypes(record) {
	const counts = {};
	for (const notification of primaryItems(record)) counts[notification.type] = (counts[notification.type] ?? 0) + 1;
	return counts;
}

function primaryItems(record) {
	const threadId = record.thread?.threadId;
	const turnId = record.turn?.turnId;
	return record.notifications
		.filter((notification) => notification.method === "item/completed" && notification.params?.threadId === threadId && notification.params?.turnId === turnId && typeof notification.params?.item?.type === "string")
		.map((notification) => notification.params.item);
}

/** A command item started in the primary turn, correlated by the ids its own thread and turn/start answers named. */
const primaryCommand = (notification, record) =>
	notification.method === "item/started" && notification.params?.item?.type === "commandExecution" && record.thread !== undefined && record.turn !== undefined && notification.params.threadId === record.thread.threadId && notification.params.turnId === record.turn.turnId;

/* ------------------------------------------------------------------------------------------------------------------
 * G2: continuations as the host chains them
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * What a later fake process is told an earlier one left: its completed turns, oldest first, and the thread's total, read
 * from the record the harness got. Fake-only: the fake's own variables, which no production request carries and a
 * native child never reads, standing in for the persisted thread a real Codex keeps between processes.
 */
const fakeHistory = (turns, seed, prefix) => ({ FAKE_CODEX_HISTORY: JSON.stringify({ turns: turns.map((id) => ({ id, status: "completed" })), seed }), FAKE_CODEX_PREFIX: prefix });

/** The fresh call a G2 case continues from. Under `--fake`, a scenario whose thread reports an effort the continuation then pins. */
const freshScenario = "host-effort";

/** The reference and selection a settled call left, copied: what the host would record, and what a continuation is mapped from. */
const sourceOf = (record) => ({ ref: structuredClone(record.run.session), selection: { ...record.run.selection }, turn: record.turn.turnId });

/** The scoped usage updates of the primary turn, as reported, from the raw notifications. */
function scopedUsage(record) {
	const threadId = record.thread?.threadId;
	const turnId = record.turn?.turnId;
	return record.notifications.filter((notification) => notification.method === "thread/tokenUsage/updated" && notification.params?.threadId === threadId && notification.params?.turnId === turnId).map((notification) => usageCounters(notification.params));
}

/**
 * The checks every settled G2 call gets, fresh or continued: the production success, the admitted turn's own completion,
 * an idle readback at the barrier, a non-empty report (never printed), and the outcome settling on that turn with the
 * thread's total at the barrier as its baseline. Then this call's usage: each core count at or above the baseline it
 * started from, the published SDK counters equal to the delta, and the context rule. False when there is nothing to
 * read usage from, so a case stops before chaining a continuation onto a run that did not settle.
 */
function checkSettled(ctx, result, label, record, baseline) {
	const run = record.run;
	if (!result.check(!ctx.mod.failed(run), `${label}: production verdict: success`)) return false;
	const evidence = record.evidence;
	result.check(evidence?.completion?.status === "completed", `${label}: the admitted turn's own completion says completed`);
	result.check(record.read?.status.type === "idle", `${label}: the thread reads back idle at the post-turn barrier`);
	result.check(run.text.trim() !== "", `${label}: the report is non-empty (its text is not printed)`);
	const ref = run.session;
	result.check(ref?.backend === "codex" && ref.sessionId === record.thread?.threadId && ref.checkpoint === record.turn?.turnId, `${label}: the outcome reference names this thread and this call's admitted turn as its checkpoint`);
	const usage = evidence?.usage;
	if (!usage) {
		result.unproven(`${label}: the turn reported no usage the transport kept`);
		return false;
	}
	const sameTotal = ref?.baseline !== undefined && [...CORE_FIELDS, "cacheWriteInputTokens"].every((field) => ref.baseline[field] === usage.total[field]);
	result.check(sameTotal, `${label}: the outcome baseline is the thread's total at the barrier, exactly`);
	const updates = scopedUsage(record);
	result.fact(`${label}: baseline before`, baseline === undefined ? "none (a fresh thread)" : CORE_FIELDS.map((field) => `${field}=${baseline[field]}`).join(" "));
	result.fact(`${label}: scoped usage updates`, `${updates.length} (transport: ${evidence.usageUpdates}, of which after completion ${evidence.usageAfterCompletion})`);
	if (updates.length > 0) {
		const latest = updates[updates.length - 1];
		result.fact(`${label}: latest update total`, describeCounters(latest.total));
		result.fact(`${label}: latest update last`, `${describeCounters(latest.last)} modelContextWindow=${latest.modelContextWindow}`);
	}
	const delta = coreDelta(baseline, usage.total);
	for (const field of CORE_FIELDS) result.fact(`${label}: ${field}`, `total ${delta[field].current} - baseline ${delta[field].baseline} = ${delta[field].delta}`);
	result.check(CORE_FIELDS.every((field) => delta[field].holds), `${label}: every core count of the total is at or above the baseline`);
	const published = publishedUsageProblems(run, delta);
	result.check(published.length === 0, `${label}: the published in/out/cacheRead are this call's delta${published.length === 0 ? "" : `: ${published.join("; ")}`}`);
	result.fact(`${label}: reasoning and total`, `delta ${delta.reasoningOutputTokens.delta} and ${delta.totalTokens.delta}: measured here, and no published run field carries either`);
	if (updates.length === 1) {
		const last = updates[0].last;
		result.fact(`${label}: delta vs the one update's last`, `${CORE_FIELDS.map((field) => `${field} ${last[field] === delta[field].delta ? "yes" : "no"}`).join(", ")} (an observation, not a summing policy)`);
	} else result.fact(`${label}: delta vs last`, `not compared: ${updates.length} scoped updates, and summing last is no policy`);
	const context = contextProblem(run, usage.last.inputTokens, usage.modelContextWindow);
	result.check(context === undefined, `${label}: context is the latest last.inputTokens against a positive window, or unpublished${context ? `: ${context}` : ""}`);
	result.fact(`${label}: cache write`, `published ${run.cacheWrite} (a diagnostic: 0 may be unobserved, never gating); USD unknown`);
	return true;
}

/** That a continuation ran on the recorded selection: named in its request and turn/start, read back, and verified. */
function checkPinned(result, label, record, selection) {
	const params = record.threadParams;
	result.check(params?.model === selection.model && params?.modelProvider === selection.provider, `${label}: the ${record.threadMethod} request names the recorded model and provider`);
	if (selection.effort !== undefined) result.check(record.turnParams?.effort === selection.effort, `${label}: turn/start names the recorded effort ${selection.effort}`);
	else result.fact(`${label}: effort`, "the record has none, so turn/start names none");
	const read = record.read;
	result.check(read !== undefined && (read.model === selection.model || read.model === null) && read.modelProvider === selection.provider && (selection.effort === undefined || read.reasoningEffort === selection.effort), `${label}: the readback matches the recorded model, provider and effort (a null model kept as the start answer's)`);
	const verified = record.run.selection;
	result.check(verified?.model === selection.model && verified?.provider === selection.provider && verified?.effort === selection.effort, `${label}: the verified selection is the recorded one`);
}

/* ------------------------------------------------------------------------------------------------------------------
 * G3: questions through the run's own callback
 * ---------------------------------------------------------------------------------------------------------------- */

/** What Q15 asks a model for. The answer it must report is made only later, inside the callback, and is in no prompt. */
const QUESTION_PROMPT = "Call the ask_orchestrator tool exactly once to ask the orchestrator which code word to use, wait for its answer, then reply with exactly the answer you received and nothing else.";

/**
 * One Q15 leg's question checks: the callback handed to the start, one question through it and none refused or
 * repeated, the question taken before its turn completed, and the report carrying this leg's own answer. The answer
 * itself is never printed. True when the question part passed, so a case chains the next leg only onto one that did.
 */
function checkQuestionLeg(result, label, record, answer) {
	result.check(record.questionCallback === true, `${label}: the start seam was handed the run's question callback`);
	if (answer !== undefined) result.guard(![record.turnParams?.text, record.threadParams?.developerInstructions].some((text) => text?.includes(answer)), `${label}: the answer was made in the callback and is in no prompt or instruction`);
	if (record.questions > 0) result.check(!record.questionAfterCompletion, `${label}: the question came while the admitted turn had not completed`);
	const echoed = answer !== undefined && record.run.text.includes(answer);
	result.fact(`${label}: the report carries this leg's answer`, `${echoed} (the answer is only in the tool result, so this shows the result was read; never printed)`);
	const proof = questionProof({ callbacks: record.questions, counters: record.exit?.counters, echoed });
	result.add(proof.status, `${label}: question: ${proof.why}`);
	return proof.status === "pass";
}

/** One Q15 leg: a backend call whose callback answers its question with a new synthetic answer, made only then. */
async function questionLeg(ctx, result, label, work, options) {
	const made = {};
	const record = await backendRun(ctx, result, {
		leg: label,
		call: { role: "ask", mode: "answer" },
		prompt: QUESTION_PROMPT,
		cwd: work,
		onQuestion: async () => {
			made.answer = token("Q15", "answer");
			return made.answer;
		},
		...options,
	});
	if (!record.run) return undefined;
	const asked = checkQuestionLeg(result, label, record, made.answer);
	const settled = checkSettled(ctx, result, label, record, options.intent === undefined ? undefined : (options.intent.ref ?? options.intent.from).baseline);
	return asked && settled ? record : undefined;
}

/* ------------------------------------------------------------------------------------------------------------------
 * fixtures
 * ---------------------------------------------------------------------------------------------------------------- */

/** The harness's own git, with its own home and no system, global or hook configuration. The child's env is untouched. */
function git(ctx, cwd, args) {
	const home = path.join(ctx.root, "git-home");
	fs.mkdirSync(home, { recursive: true });
	const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" };
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
}

function fixtureRepo(ctx, dir, files) {
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	git(ctx, dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
	git(ctx, dir, ["add", "-A"]);
	git(ctx, dir, ["-c", "user.name=pi-fusion-harness", "-c", "user.email=harness@invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "qualification fixture"]);
	return dir;
}

const head = (ctx, dir) => git(ctx, dir, ["rev-parse", "HEAD"]).trim();
const status = (ctx, dir) => git(ctx, dir, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean).sort();

/** Every file under a directory but `.git`, with its bytes' digest: the fixture's state, not anyone's report of it. */
function tree(dir) {
	const out = {};
	const walk = (at) => {
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			if (entry.name === ".git" && at === dir) continue;
			const file = path.join(at, entry.name);
			const rel = path.relative(dir, file);
			if (entry.isDirectory()) walk(file);
			else if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(file)}`;
			else out[rel] = fileDigest(file);
		}
	};
	walk(dir);
	return JSON.stringify(out);
}

function fileState(file) {
	try {
		return { exists: true, content: fs.readFileSync(file, "utf8") };
	} catch {
		return { exists: fs.existsSync(file), content: undefined };
	}
}

/* ------------------------------------------------------------------------------------------------------------------
 * the cases
 * ---------------------------------------------------------------------------------------------------------------- */

const RUNNERS = {
	Q1: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q1"), "work");
		fs.mkdirSync(work);
		const outcome = await withChild(ctx, work, async (child) => child.initialize);
		if (outcome.startError) {
			result.fail(`the child did not complete its handshake: ${message(outcome.startError)}`);
			checkShutdown(ctx, result, outcome.exit, "child");
			return;
		}
		const init = outcome.value;
		const version = versionFromUserAgent(init.userAgent);
		result.fact("userAgent", JSON.stringify(init.userAgent));
		result.fact("version", version ? `${version} (parsed from userAgent; reported, not independently verified)` : "none parsed from userAgent");
		result.fact("platform", `${init.platformFamily}/${init.platformOs} (child) vs ${process.platform}-${process.arch} (host), node ${process.version}`);
		result.fact("Codex home", `reported ${init.codexHome}, predicted ${outcome.prepared.expectedCodexHome}`);
		if (!ctx.fake && !(process.platform === "linux" && process.arch === "x64")) result.fact("target", "outside the Linux x64 qualification target: recorded, unqualified");
		if (!ctx.fake && version !== undefined && version !== ctx.mod.CODEX_PROTOCOL_PROVENANCE.version) result.fact("target", `reported version differs from the source-read ${ctx.mod.CODEX_PROTOCOL_PROVENANCE.version}: recorded, unqualified`);
		result.check(canonicalPath(init.codexHome) === canonicalPath(outcome.prepared.expectedCodexHome), "reported Codex home equals the predicted home (canonical)");
		checkShutdown(ctx, result, outcome.exit, "child");
	},

	Q2: async (ctx, result) => {
		const dir = ctx.caseDir("Q2");
		const work = path.join(dir, "work");
		fs.mkdirSync(work);
		// The launch cwd is a symlink to the work directory, so the binding is a realpath comparison and not a string match.
		const link = path.join(dir, "work-link");
		fs.symlinkSync(work, link, "dir");
		result.fact("launch cwd", `${link} -> ${fs.realpathSync(link)} (no request names a cwd)`);
		const legs = [
			{ label: "implement, host default", call: { role: "implement" } },
			{ label: "ask answer, host default", call: { role: "ask", mode: "answer" } },
			{ label: "ask review, host default", call: { role: "ask", mode: "review" } },
		];
		if (ctx.cli.model) legs.push({ label: `implement, explicit model ${ctx.cli.model}`, call: { role: "implement", model: ctx.cli.model } });
		else result.skip("explicit-model leg: no --model given, and this harness guesses no model catalogue");
		for (const leg of legs) {
			const role = ctx.mod.codexRole(leg.call, undefined, {});
			const outcome = await withChild(ctx, link, async (child, prepared) => {
				const start = await child.startThread(roleThreadParams(ctx.mod, role));
				result.fact(`${leg.label}: thread/start`, describeStart(start));
				result.fact(`${leg.label}: sandbox`, describeSandbox(start.sandbox));
				const problem = ctx.mod.threadStartProblem(role, start, canonicalPath(start.cwd), canonicalPath(prepared.expectedCwd));
				result.fact(`${leg.label}: reported cwd`, `${start.cwd} (${start.cwd === prepared.expectedCwd ? "the realpath" : start.cwd === link ? "the symlink as launched" : "neither the realpath nor the launch path"})`);
				if (!result.check(problem === undefined, `${leg.label}: production start checks pass (cwd bound by realpath, ${role.sandboxMode}, approval never, named selection exact)${problem ? `: ${problem}` : ""}`)) {
					result.fact(`${leg.label}`, "halted before any turn; a fallback that names the cwd stays disabled pending the user's consent");
					return;
				}
				let read;
				try {
					read = await child.readThread(start.threadId);
				} catch (error) {
					result.unproven(`${leg.label}: thread/read before any turn failed (${message(error)}); production reads only after a turn`);
					return;
				}
				result.fact(`${leg.label}: thread/read`, describeRead(read));
				result.check(canonicalPath(read.cwd) === canonicalPath(prepared.expectedCwd), `${leg.label}: readback cwd bound by realpath`);
				result.check(read.modelProvider === start.modelProvider, `${leg.label}: readback provider equals the start answer's`);
				if (role.model !== undefined) result.check(read.model === role.model || read.model === null, `${leg.label}: readback model is the named model (or null, which production notes and keeps the start answer's)`);
				else result.fact(`${leg.label}: host default`, `start model ${start.model}, readback model ${read.model}, effort start ${start.reasoningEffort} / read ${read.reasoningEffort}`);
			});
			if (outcome.startError) result.fail(`${leg.label}: the child did not start: ${message(outcome.startError)}`);
			if (outcome.thrown) result.fail(`${leg.label}: thread/start failed: ${message(outcome.thrown)}`);
			if (outcome.child) result.check(canonicalPath(outcome.child.initialize.codexHome) === canonicalPath(outcome.prepared.expectedCodexHome), `${leg.label}: reported home equals the predicted home`);
			checkShutdown(ctx, result, outcome.exit, `${leg.label} child`);
		}
	},

	Q3: async (ctx, result) => {
		const dir = ctx.caseDir("Q3");
		const work = fixtureRepo(ctx, path.join(dir, "work"), { "target.txt": "status: old\n" });
		const before = head(ctx, work);
		const nonce = token("Q3", "nonce");
		const role = ctx.mod.codexRole({ role: "implement" }, undefined, {});
		const readContract = (name) => {
			const text = productionContract(ctx.mod, name);
			return name === role.contract ? `${text.trimEnd()}\n\nHARNESS_NONCE: ${nonce}\nThis manual qualification value appears only in these developer instructions; write it only where a task asks for it.\n` : text;
		};
		const prompt = "In target.txt in the current directory, replace the line `status: old` with `status: new`. Then create a file named nonce.txt in the current directory whose only content is the HARNESS_NONCE value from your developer instructions, followed by a newline. Change nothing else.";
		result.guard(!prompt.includes(nonce), "the prompt does not carry the nonce");
		const record = await backendRun(ctx, result, { call: { role: "implement" }, prompt, cwd: work, readContract });
		if (!record.run) return;
		result.check(record.threadParams?.developerInstructions.includes(nonce) === true && record.turnParams?.text.includes(nonce) === false, "the nonce went out in developerInstructions only");
		result.check(!ctx.mod.failed(record.run), "production verdict: success");
		result.check(fileState(path.join(work, "target.txt")).content === "status: new\n", "target.txt now reads `status: new` (fixture state)");
		const delivered = fileState(path.join(work, "nonce.txt"));
		result.check(delivered.content?.trim() === nonce, "nonce.txt holds the developer-only nonce (fixture state)");
		result.check(head(ctx, work) === before, "HEAD unchanged: no commit");
		const changed = status(ctx, work);
		result.fact("git status", JSON.stringify(changed));
		result.check(JSON.stringify(changed) === JSON.stringify([" M target.txt", "?? nonce.txt"]), "only target.txt changed and nonce.txt was added");
	},

	Q3b: async (ctx, result) => {
		const effort = ctx.cli.effort;
		if (!effort) return result.skip("no --effort given; this harness guesses no effort catalogue");
		const work = path.join(ctx.caseDir("Q3b"), "work");
		fs.mkdirSync(work);
		const start = await preflightStart(ctx, result, work, { role: "ask" });
		if (!start) return;
		result.fact("configured default effort (start answer)", String(start.reasoningEffort));
		if (start.reasoningEffort === effort) return result.skip(`--effort ${effort} equals the configured default, so it measures nothing distinct`);
		const record = await backendRun(ctx, result, { call: { role: "ask", effort }, prompt: "Reply with the single word OK.", cwd: work });
		if (!record.run) return;
		result.check(!ctx.mod.failed(record.run), "production verdict: success (a named effort must read back exactly)");
		result.check(record.read?.reasoningEffort === effort && record.run.selection?.effort === effort, `readback and verified selection name effort ${effort}`);
	},

	Q4: async (ctx, result) => {
		const dir = ctx.caseDir("Q4");
		const codename = token("Q4", "codename");
		const work = fixtureRepo(ctx, path.join(dir, "work"), { "facts.txt": `codename: ${codename}\n` });
		const before = { head: head(ctx, work), tree: tree(work), status: status(ctx, work) };
		const record = await backendRun(ctx, result, { call: { role: "ask", mode: "answer" }, prompt: "What codename is recorded in facts.txt in the current directory? Reply with the codename only.", cwd: work });
		if (!record.run) return;
		result.check(!ctx.mod.failed(record.run), "production verdict: success");
		result.check(record.thread?.sandbox.type === "readOnly", "reported sandbox is readOnly");
		result.check(tree(work) === before.tree, "fixture files unchanged (fixture state)");
		result.check(head(ctx, work) === before.head, "HEAD unchanged: no commit");
		result.check(JSON.stringify(status(ctx, work)) === JSON.stringify(before.status), "git status unchanged");
		result.fact("answer names the codename", `${record.run.text.includes(codename)} (model prose: supporting only, not evidence)`);
		result.fact("hosted search items (observed, not gating)", `${primaryItems(record).filter((item) => item.type === "webSearch").length} webSearch; none is no evidence that search is disabled`);
	},

	Q6: async (ctx, result) => {
		const work = fixtureRepo(ctx, path.join(ctx.caseDir("Q6"), "work"), { "README.txt": "cancellation fixture\n" });
		const prompt = ctx.fake ? "Reply with the single word OK." : "Run the shell command `sleep 60` once and wait for it to finish; then reply with the single word DONE.";
		let cancelledAt;
		const cancel = (controller, why) => {
			if (cancelledAt) return;
			cancelledAt = why;
			controller.abort();
		};
		const record = await backendRun(ctx, result, {
			call: { role: "implement" },
			prompt,
			cwd: work,
			scenario: "forever",
			allowAborted: true,
			// The fake runs no command: its turn being admitted is the cancellation point there. Natively, a command item that
			// arrived before the turn/start answer is already in the record, and is found once the turn is admitted.
			onTurn: (_turn, controller, record) => {
				if (ctx.fake) cancel(controller, "the turn was admitted (fake)");
				else if (record.notifications.some((notification) => primaryCommand(notification, record))) cancel(controller, "the primary turn's first command item started (before the turn/start answer)");
			},
			onNotification: (notification, controller, record) => {
				if (!ctx.fake && primaryCommand(notification, record)) cancel(controller, "the primary turn's first command item started");
			},
		});
		if (!record.run) return;
		if (!cancelledAt) return result.unproven(`the cancellation point never came: ${ctx.fake ? "no turn was admitted" : "no command item started in the primary turn, so no running command was cancelled"}`);
		result.fact("cancelled when", cancelledAt);
		result.fact("child's own turn completion", record.evidence?.completion ? record.evidence.completion.status : "none (the transport ended the turn)");
		result.check(record.run.stopReason === "aborted", "production verdict: aborted");
		result.check(record.exit?.stopRequested === true, "the child's actual exit report says the host requested the stop");
	},

	Q7: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q7"), "work");
		fs.mkdirSync(work);
		const role = ctx.mod.codexRole({ role: "ask" }, undefined, {});
		for (const leg of [{ label: "after initialize", thread: false }, { label: "with an open thread", thread: true }]) {
			const outcome = await withChild(ctx, work, async (child) => (leg.thread ? child.startThread(roleThreadParams(ctx.mod, role)) : undefined));
			if (outcome.startError || outcome.thrown) {
				result.fail(`${leg.label}: ${message(outcome.startError ?? outcome.thrown)}`);
				checkShutdown(ctx, result, outcome.exit, `${leg.label} child`);
				continue;
			}
			const exit = outcome.exit;
			const self = Boolean(exit && exit.cleanup.root === "exited" && exit.exit.code === 0 && exit.exit.signal === null);
			result.check(self, `${leg.label}: under the production owned shutdown (SIGTERM to observed descendants first, then stdin end) the root exited by itself with status 0 and no root signal`);
			checkShutdown(ctx, result, exit, `${leg.label} child`);
		}
	},

	Q9: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q9"), "untrusted");
		fs.mkdirSync(work);
		const real = fs.realpathSync(work);
		const mentionedBefore = ctx.configMentions(real);
		const before = tree(work);
		const role = ctx.mod.codexRole({ role: "implement" }, undefined, {});
		const outcome = await withChild(ctx, work, async (child, prepared) => {
			const start = await child.startThread(roleThreadParams(ctx.mod, role));
			result.fact("thread/start", describeStart(start));
			result.fact("sandbox", describeSandbox(start.sandbox));
			const problem = ctx.mod.threadStartProblem(role, start, canonicalPath(start.cwd), canonicalPath(prepared.expectedCwd));
			result.check(problem === undefined, `production start checks pass in an untrusted cwd: workspace-write kept, approval never, cwd bound${problem ? `: ${problem}` : ""}`);
		});
		if (outcome.startError || outcome.thrown) result.fail(`thread/start in the untrusted fixture failed: ${message(outcome.startError ?? outcome.thrown)}`);
		result.check(!mentionedBefore && !ctx.configMentions(real), "config.toml does not name the fixture before or after (no trust entry written)");
		result.check(tree(work) === before, "the fixture cwd is unchanged by thread/start");
		checkShutdown(ctx, result, outcome.exit, "child");
	},

	Q14: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q14"), "work");
		fs.mkdirSync(work);
		const role = ctx.mod.codexRole({ role: "ask", mode: "answer" }, undefined, {});
		// Kept bounded and typed: a usage update's counters and an item's type and id, read through the production
		// readers, with the ids they name. Nothing of an item's text, a command or the thread's configuration is kept.
		const seen = { usage: [], items: [], malformedItems: 0, dropped: 0 };
		const onNotification = (notification) => {
			if (notification.method !== "thread/tokenUsage/updated" && notification.method !== "item/completed") return;
			if (seen.usage.length + seen.items.length >= NOTIFICATION_CAP) return void (seen.dropped += 1);
			if (notification.method === "thread/tokenUsage/updated") {
				const read = ctx.mod.readTokenUsage(notification.params);
				if (read.ok) seen.usage.push({ threadId: read.value.threadId, turnId: read.value.turnId, counters: usageCounters(notification.params) });
				return;
			}
			const read = ctx.mod.readItem(notification.params, 64);
			if (read.ok) seen.items.push({ threadId: read.value.threadId, turnId: read.value.turnId, itemId: read.value.itemId, type: read.value.type });
			else seen.malformedItems += 1;
		};
		const prompts = ["Reply with the single word OK.", "Reply with the single word OK again."];
		result.fact("limits", `two turns, ${USAGE_PRINT_CAP} usage updates printed per turn, ${NOTIFICATION_CAP} usage and item notifications kept; no item text, prompt reply, command or configuration printed`);
		if (ctx.fake) result.fact("evidence", "the fake's literal counters: NOT NATIVE, and nothing here says how a real Codex counts usage");
		const turns = [];
		const outcome = await withChild(
			ctx,
			work,
			async (child, prepared) => {
				const start = await child.startThread(roleThreadParams(ctx.mod, role));
				result.fact("thread/start", describeStart(start));
				result.fact("sandbox", describeSandbox(start.sandbox));
				const problem = ctx.mod.threadStartProblem(role, start, canonicalPath(start.cwd), canonicalPath(prepared.expectedCwd));
				if (!result.check(problem === undefined, `production start checks pass (cwd bound, read-only, approval never)${problem ? `: ${problem}` : ""}`)) return start;
				for (const [index, text] of prompts.entries()) {
					const label = `turn ${index + 1}`;
					const turn = await child.startTurn({ threadId: start.threadId, text });
					const ended = await bounded(turn.done, MODEL_CASE_MS);
					if (!ended.ok) {
						result.unproven(`${label}: did not end inside ${MODEL_CASE_MS}ms; the owned shutdown interrupts it`);
						return start;
					}
					// Recorded before any readback, so a turn that did not complete is still reported as it ended.
					const entry = { label, turn, done: ended.value, evidence: turn.snapshot() };
					turns.push(entry);
					if (ended.value.outcome !== "completed") return start;
					// The read barrier: what the child sent before answering, late usage included, is applied first.
					entry.read = await child.readThread(start.threadId);
					entry.evidence = turn.snapshot();
				}
				return start;
			},
			{ scenario: "two-turns", onNotification },
		);
		if (outcome.startError) result.fail(`the child did not start: ${message(outcome.startError)}`);
		if (outcome.thrown) result.fail(`a request failed: ${message(outcome.thrown)}`);
		const threadId = outcome.value?.threadId;
		const perTurn = turns.map((entry) => ({
			...entry,
			updates: seen.usage.filter((update) => update.threadId === threadId && update.turnId === entry.turn.turnId).map((update) => update.counters),
			items: seen.items.filter((item) => item.threadId === threadId && item.turnId === entry.turn.turnId),
		}));
		for (const entry of perTurn) {
			const { label, done, read, evidence, updates, items } = entry;
			result.fact(`${label}`, `turn=${entry.turn.turnId} outcome=${done.outcome} completion=${done.completion ? done.completion.status : "none"}${done.failure ? ` failure=${done.failure.kind}` : ""}`);
			// A protocol failure's message is the transport's fixed text and a reader's fixed reason, never a value from the
			// child; other kinds may append the child's own text, so only their kind is shown.
			if (done.failure?.kind === "protocol") {
				result.fact(`${label}: protocol failure`, done.failure.message);
				result.fact(`${label}: limit`, "a notification the production reader rejects, a malformed usage update among them, ends the child before the harness's listener runs: its counters are not observable here");
			}
			result.check(done.outcome === "completed", `${label}: the child's own turn/completed says completed`);
			if (read) {
				result.fact(`${label}: thread/read`, describeRead(read));
				result.check(read.status.type === "idle", `${label}: the thread reads back idle after the turn`);
			}
			result.fact(`${label}: usage updates`, `${updates.length} scoped to this thread and turn (transport: ${evidence.usageUpdates}, of which after completion ${evidence.usageAfterCompletion})`);
			for (const [at, update] of updates.slice(0, USAGE_PRINT_CAP).entries()) {
				result.fact(`${label}: update ${at + 1} total`, describeCounters(update.total));
				result.fact(`${label}: update ${at + 1} last`, `${describeCounters(update.last)} modelContextWindow=${update.modelContextWindow}`);
			}
			if (updates.length > USAGE_PRINT_CAP) result.fact(`${label}: updates not printed`, `${updates.length - USAGE_PRINT_CAP} (still counted and summed)`);
			const distinct = (type) => new Set(items.filter((item) => item.type === type).map((item) => item.itemId)).size;
			result.fact(`${label}: completed items`, `agentMessage=${distinct("agentMessage")} reasoning=${distinct("reasoning")} (distinct ids; observable item counts, not model responses: the protocol names no response identity)`);
			const problem = usageProblem(updates);
			if (problem) result.unproven(`${label}: usage is not usable: ${problem}`);
			else result.check(true, `${label}: usable usage counters (latest total and last carry every required count)`);
		}
		result.fact("malformed items", `${seen.malformedItems} seen by the harness on any thread, ${outcome.exit?.counters.malformedItems ?? "unknown"} by the transport; dropped, never counted as agentMessage or reasoning`);
		if (seen.dropped > 0) result.fact("notifications dropped past the cap", String(seen.dropped));
		if (perTurn.length === 2) {
			const [first, second] = perTurn;
			result.check(second.turn.threadId === first.turn.threadId && second.turn.turnId !== first.turn.turnId, "two turns admitted on the one owned thread, under distinct turn ids");
			if (!usageProblem(first.updates) && !usageProblem(second.updates)) {
				const sums = additivity(first.updates[first.updates.length - 1].total, second.updates[second.updates.length - 1].total, second.updates.map((update) => update.last));
				for (const field of USAGE_FIELDS) {
					const entry = sums[field];
					result.fact(`additivity ${field}`, `turn 2 total ${entry.current} vs turn 1 total ${entry.previous} + turn 2 lasts ${entry.sumOfLasts}: ${entry.holds}`);
				}
				result.fact("additivity", "observed, not required: a `no` or `unknown` is evidence of how the counters behaved, not a failure, and no summing policy follows from it");
			}
		} else if (!outcome.startError && !outcome.thrown && turns.length < 2 && !result.parts.some((part) => part.status === "unproven" || part.status === "fail")) {
			result.unproven(`only ${turns.length} of two turns ran`);
		}
		const all = perTurn.flatMap((entry) => entry.updates);
		result.fact("cache write vs input", cacheWriteObservation(all));
		result.fact("cost", "unknown (Codex reports none; never estimated)");
		const declined = outcome.exit?.counters.declinedApprovals ?? 0;
		result.guard(declined === 0, `no approval requested under approval never (declined ${declined})`);
		checkShutdown(ctx, result, outcome.exit, "child");
	},

	Q10: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q10"), "work");
		fs.mkdirSync(work);
		const call = { role: "ask", mode: "answer" };
		result.fact("limits", "two backend calls, one short reply each; no reply text printed");
		const fresh = await backendRun(ctx, result, { leg: "fresh", call, prompt: "Reply with the single word OK.", cwd: work, scenario: freshScenario });
		if (!fresh.run || !checkSettled(ctx, result, "fresh", fresh, undefined)) return;
		const source = sourceOf(fresh);
		const resumed = await backendRun(ctx, result, { leg: "resume", call, recorded: source.selection, intent: { kind: "resume", ref: source.ref }, prompt: "Reply with the single word OK again.", cwd: work, scenario: "resume-ok", fakeExtra: fakeHistory([source.ref.checkpoint], source.ref.baseline, "b-") });
		if (!resumed.run) return;
		result.check(resumed.threadMethod === "thread/resume" && resumed.threadParams?.threadId === source.ref.sessionId && resumed.threadParams?.lastTurnId === undefined, "resume: thread/resume named the recorded thread and no turn");
		const tip = resumed.tips[0];
		result.check(resumed.tips.length === 1 && tip.threadId === source.ref.sessionId && !tip.tip.none && tip.tip.turnId === source.ref.checkpoint && tip.tip.status === "completed", "resume: the latest-turn read named the recorded thread and found the recorded checkpoint, completed");
		result.check(resumed.methods.indexOf("thread/turns/list") !== -1 && resumed.methods.indexOf("thread/turns/list") < resumed.methods.indexOf("turn/start"), "resume: the tip was read before turn/start");
		if (!checkSettled(ctx, result, "resume", resumed, source.ref.baseline)) return;
		const ref = resumed.run.session;
		result.check(ref.sessionId === source.ref.sessionId && ref.checkpoint !== source.ref.checkpoint, "resume: the same thread, settled on a new checkpoint");
		checkPinned(result, "resume", resumed, source.selection);
	},

	Q11: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q11"), "work");
		fs.mkdirSync(work);
		const call = { role: "ask", mode: "answer" };
		result.fact("limits", "one fresh backend call, one direct-transport turn, and a backend resume refused before any turn: two replies; no reply text printed");
		const fresh = await backendRun(ctx, result, { leg: "fresh", call, prompt: "Reply with the single word OK.", cwd: work, scenario: freshScenario });
		if (!fresh.run || !checkSettled(ctx, result, "fresh", fresh, undefined)) return;
		const source = sourceOf(fresh);
		// One turn this harness starts itself, on its own child, with the record's selection and the role's contract.
		const role = ctx.mod.codexRole(call, source.selection, {});
		const direct = await withChild(
			ctx,
			work,
			async (child, prepared) => {
				const answer = await child.resumeThread({ threadId: source.ref.sessionId, ...roleThreadParams(ctx.mod, role) });
				const problem = ctx.mod.threadStartProblem(role, answer, canonicalPath(answer.cwd), canonicalPath(prepared.expectedCwd));
				if (problem !== undefined) return { problem };
				const turn = await child.startTurn({ threadId: answer.threadId, text: "Reply with the single word EXTRA.", ...(role.effort === undefined ? {} : { effort: role.effort }) });
				const ended = await bounded(turn.done, MODEL_CASE_MS);
				if (!ended.ok) return { turn };
				const read = await child.readThread(answer.threadId);
				return { turn, done: ended.value, evidence: turn.snapshot(), read };
			},
			{ scenario: "resume-ok", fakeExtra: fakeHistory([source.ref.checkpoint], source.ref.baseline, "x-") },
		);
		checkShutdown(ctx, result, direct.exit, "direct child");
		if (direct.startError || direct.thrown) return result.unproven(`the direct extra turn did not run: ${message(direct.startError ?? direct.thrown)}`);
		if (direct.value.problem) return result.unproven(`the direct resume failed the production start checks: ${direct.value.problem}`);
		const extra = direct.value;
		result.fact("extra turn", `turn=${extra.turn.turnId} outcome=${extra.done?.outcome ?? "did not end in time"} vs recorded checkpoint ${source.ref.checkpoint}`);
		if (extra.done?.outcome !== "completed") return result.unproven("the extra turn did not complete, so no moved tip was made by a completed turn");
		result.fact("extra turn readback", describeRead(extra.read));
		const seed = extra.evidence.usage?.total ?? source.ref.baseline;
		const final = await backendRun(ctx, result, { leg: "resume of the original reference", call, recorded: source.selection, intent: { kind: "resume", ref: source.ref }, prompt: "Reply with the single word OK again.", cwd: work, scenario: "resume-ok", fakeExtra: fakeHistory([source.ref.checkpoint, extra.turn.turnId], seed, "y-") });
		if (!final.run) return;
		result.check(final.run.stopReason === "thread" && final.run.errorMessage === ctx.mod.RESUME_MOVED, "the backend resume of the original reference is refused with the fixed RESUME_MOVED");
		result.fact("turn/start requests on the refusing call", String(final.turnStarts));
		result.check(final.turnStarts === 0, "no turn/start was sent on the refusing call");
		const tip = final.tips[0]?.tip;
		result.check(tip !== undefined && !tip.none && tip.turnId === extra.turn.turnId, "the latest-turn read found the extra turn, past the recorded checkpoint");
		result.check(final.run.session?.checkpoint === undefined && final.run.session?.baseline === undefined, "the refusal settles no checkpoint and no baseline");
		result.fact("the refusal's way on", `names a new run without continue: ${final.run.errorMessage?.includes("start a new run without continue") === true}; names fresh true for a plan call: ${final.run.errorMessage?.includes("a plan call takes fresh true") === true} (this case is an ask)`);
	},

	Q12: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q12"), "work");
		fs.mkdirSync(work);
		const call = { role: "ask", mode: "answer" };
		result.fact("limits", "two backend calls, one short reply each; no reply text printed");
		const fresh = await backendRun(ctx, result, { leg: "fresh", call, prompt: "Reply with the single word OK.", cwd: work, scenario: freshScenario });
		if (!fresh.run || !checkSettled(ctx, result, "fresh", fresh, undefined)) return;
		const source = sourceOf(fresh);
		// The intent the host maps a continuation to from another host session: a fork of the reference.
		result.fact("intent", "fork, as the host continues a record from another host session");
		const forked = await backendRun(ctx, result, { leg: "fork", call, recorded: source.selection, intent: { kind: "fork", from: source.ref }, prompt: "Reply with the single word OK again.", cwd: work, scenario: "fork-ok", fakeExtra: { ...fakeHistory([source.ref.checkpoint], source.ref.baseline, "f-"), FAKE_CODEX_FORK_RENAME: "1" } });
		if (!forked.run) return;
		result.check(forked.threadMethod === "thread/fork" && forked.threadParams?.threadId === source.ref.sessionId && forked.threadParams?.lastTurnId === source.ref.checkpoint, "fork: thread/fork named the source thread and its recorded checkpoint as lastTurnId");
		const newThread = forked.thread?.threadId;
		result.check(newThread !== undefined && newThread !== source.ref.sessionId, "fork: the answer names a new thread");
		const forkedFrom = forked.thread?.forkedFromId;
		result.check(forkedFrom === undefined || forkedFrom === source.ref.sessionId, `fork: forkedFromId is the source when reported (${forkedFrom ?? "not reported"})`);
		const tip = forked.tips[0];
		result.check(forked.tips.length === 1 && tip.threadId === newThread && !tip.tip.none && tip.tip.status === "completed", "fork: the new thread's latest turn read is completed: its starting checkpoint");
		if (tip && !tip.tip.none) result.fact("starting tip vs source checkpoint", `${tip.tip.turnId} vs ${source.ref.checkpoint}: ${tip.tip.turnId === source.ref.checkpoint ? "the same id" : "a different id"} (how fork names copied turns is a fact here, not a requirement)`);
		if (!checkSettled(ctx, result, "fork", forked, source.ref.baseline)) return;
		const ref = forked.run.session;
		result.check(ref.sessionId === newThread && ref.checkpoint !== tip?.tip.turnId, "fork: settled on the new thread at this call's admitted turn, not the starting tip");
		checkPinned(result, "fork", forked, source.selection);
	},

	Q13: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q13"), "work");
		fs.mkdirSync(work);
		const marker = token("Q13", "steer");
		const steer = { pushed: false, queued: false, at: undefined };
		const push = (record, why) => {
			if (steer.pushed) return;
			steer.pushed = true;
			steer.at = why;
			steer.queued = record.input.push(`Also include the word ${marker} in your reply.`);
		};
		result.fact("limits", "one backend call, one steer pushed once, no retry or resend; the turn is waited for, not cancelled; no reply or steer text printed");
		const record = await backendRun(ctx, result, {
			call: { role: "ask", mode: "answer" },
			prompt: ctx.fake ? "Reply with the single word OK." : "Run the shell command `sleep 20` once and wait for it to finish; then reply with the single word DONE.",
			cwd: work,
			scenario: "steer-script",
			fakeExtra: { FAKE_CODEX_STEERS: "accept" },
			...(ctx.fake ? { deadlineMs: 30_000 } : {}),
			// As Q6: the fake runs no command, so its turn's admission is the trigger there. Natively, a command item that
			// arrived before the turn/start answer is already in the record, and is found once the turn is admitted.
			onTurn: (_turn, _controller, record) => {
				if (ctx.fake) push(record, "the turn was admitted (fake)");
				else if (record.notifications.some((notification) => primaryCommand(notification, record))) push(record, "the primary turn's first command item started (before the turn/start answer)");
			},
			onNotification: (notification, _controller, record) => {
				if (!ctx.fake && primaryCommand(notification, record)) push(record, "the primary turn's first command item started");
			},
		});
		if (!record.run) return;
		result.fact("steer pushed when", steer.at ?? "never");
		if (!ctx.fake && steer.pushed) result.fact("note", "an item/started for a command is not proof the command ran or how long it took");
		result.fact("the run's input took it", String(steer.queued));
		const counts = record.input.report();
		result.fact("the run's steer counts", JSON.stringify(counts));
		const methods = {};
		for (const notification of record.notifications) if (notification.params?.threadId === record.thread?.threadId) methods[notification.method] = (methods[notification.method] ?? 0) + 1;
		result.fact("notification methods on the primary thread (supporting only)", JSON.stringify(methods));
		result.fact("the request body", "turn/steer { threadId, expectedTurnId, input } is the transport's, pinned by its unit tests");
		const proof = steerProof({ pushed: steer.pushed, queued: steer.queued, calls: record.steers, turn: record.turn ? { threadId: record.turn.threadId, turnId: record.turn.turnId } : undefined, report: counts });
		result.add(proof.status, `steer: ${proof.why}`);
		result.check(!ctx.mod.failed(record.run), "production verdict: success");
		result.check(record.evidence?.completion?.status === "completed", "the admitted turn's own completion says completed");
		result.check(record.run.text.trim() !== "", "the report is non-empty (its text is not printed)");
		result.fact("the report mentions the steer's word", `${record.run.text.includes(marker)} (model prose: supporting only; acceptance is the child's answer, not consumption)`);
	},

	Q15: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q15"), "work");
		fs.mkdirSync(work);
		const spec = ctx.mod.CODEX_QUESTION_TOOL_SPEC;
		result.fact("limits", "three backend calls on three owned children, one question and one short reply each; no question, answer, report or instruction text printed");
		result.fact("question tool", `${spec.type} ${spec.name}, input ${spec.inputSchema.type} requiring ${spec.inputSchema.required.join(", ")}: registered by the transport on a fresh thread of a child with a callback, and on no continued one (the wire is the transport's; this harness sees the requests the backend made)`);
		// The fake's thread/start reports an effort here, so the continuations have one to pin, as the host default does natively.
		const fresh = await questionLeg(ctx, result, "fresh", work, { scenario: "question", fakeExtra: { FAKE_CODEX_START: JSON.stringify({ reasoningEffort: "medium" }) } });
		if (!fresh) return;
		const first = sourceOf(fresh);
		const resumed = await questionLeg(ctx, result, "resume", work, { recorded: first.selection, intent: { kind: "resume", ref: first.ref }, scenario: "question-inherited", fakeExtra: fakeHistory([first.ref.checkpoint], first.ref.baseline, "b-") });
		if (!resumed) return;
		const tip = resumed.tips[0]?.tip;
		result.check(resumed.threadMethod === "thread/resume" && resumed.threadParams?.threadId === first.ref.sessionId && tip !== undefined && !tip.none && tip.turnId === first.ref.checkpoint && tip.status === "completed", "resume: thread/resume of the recorded thread, its tip the recorded checkpoint, completed");
		checkPinned(result, "resume", resumed, first.selection);
		// The fork is through the resumed reference's checkpoint, the source thread's current tip: no older checkpoint.
		const second = sourceOf(resumed);
		result.fact("intent", "fork of the resumed reference, as the host continues it from another host session");
		const forked = await questionLeg(ctx, result, "fork", work, { recorded: second.selection, intent: { kind: "fork", from: second.ref }, scenario: "question-inherited", fakeExtra: fakeHistory([first.ref.checkpoint, second.ref.checkpoint], second.ref.baseline, "f-") });
		if (!forked) return;
		const start = forked.tips[0]?.tip;
		result.check(forked.threadMethod === "thread/fork" && forked.threadParams?.threadId === second.ref.sessionId && forked.threadParams?.lastTurnId === second.ref.checkpoint, "fork: thread/fork named the resumed thread and its current checkpoint");
		result.check(forked.thread?.threadId !== second.ref.sessionId && (forked.thread?.forkedFromId === undefined || forked.thread.forkedFromId === second.ref.sessionId) && start !== undefined && !start.none && start.status === "completed", "fork: a new thread, forked from the source when reported, at a completed starting tip");
		checkPinned(result, "fork", forked, second.selection);
	},

	Q16: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q16"), "work");
		fs.mkdirSync(work);
		const state = { callbacks: 0, aborted: false, cancels: 0 };
		result.fact("limits", "one backend call on one owned child, cancelled while its first question waits; no answer is given, and nothing is retried, steered or replayed");
		const record = await backendRun(ctx, result, {
			call: { role: "ask", mode: "answer" },
			prompt: "Call the ask_orchestrator tool exactly once to ask the orchestrator which code word to use, and wait for its answer before you reply.",
			cwd: work,
			scenario: "question-cancel",
			allowAborted: true,
			...(ctx.fake ? { deadlineMs: 30_000 } : {}),
			// The answer stays pending until the question's own signal aborts. The listener is in place before the one cancel,
			// which goes through the production signal once the callback has handed back its pending answer.
			onQuestion: (_question, signal, controller) =>
				new Promise((_resolve, reject) => {
					state.callbacks += 1;
					const ended = () => {
						state.aborted = true;
						reject(new Error("the question was ended"));
					};
					if (signal.aborted) return ended();
					signal.addEventListener("abort", ended, { once: true });
					if (state.cancels === 0) {
						state.cancels += 1;
						queueMicrotask(() => controller.abort());
					}
				}),
		});
		if (!record.run) return;
		result.fact("child's own turn completion", `${record.evidence?.completion ? record.evidence.completion.status : "none (the transport ended the turn)"} (a diagnostic, never a successful outcome)`);
		if (state.callbacks === 0) return result.unproven("the run ended before any question reached the callback, so no waiting question was cancelled");
		const counters = record.exit?.counters;
		result.check(state.callbacks === 1 && counters?.questions === 1 && counters.refusedQuestions === 0 && counters.duplicateServerRequests === 0, "one question, asked once through the callback, none refused or repeated");
		result.check(state.cancels === 1, "the run was cancelled once, through the production signal");
		result.check(state.aborted, "the waiting question's own signal aborted, so no answer was given");
		result.fact("the question's reply", "the transport's one success: false reply, which no counter separates; the fake tests read it from the request log");
		result.check(record.run.stopReason === "aborted", "production verdict: aborted");
		result.check(record.run.session?.checkpoint === undefined && record.run.session?.baseline === undefined, "the cancelled run settles no checkpoint and no baseline");
		result.check(record.exit?.stopRequested === true, "the child's actual exit report says the host requested the stop");
	},

	Q19: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q19"), "work");
		fs.mkdirSync(work);
		const named = ctx.cli.model;
		const scope = named === undefined ? "SAME-MODEL ROUND TRIP: no --model, so the fresh call ran the host default and the resume pins that same model; this proves no pin against a changed default and no model switch" : `NAMED-MODEL ROUND TRIP (--model ${named}): the resume pins the named model from its record; whether it differs from the host default is not measured here, so this is no model-switch proof`;
		result.fact("scope", scope);
		result.fact("limits", "two backend calls, one short reply each; no model catalogue, configuration override or host configuration change; no reply text printed");
		const fresh = await backendRun(ctx, result, { leg: "fresh", call: { role: "ask", mode: "answer", ...(named === undefined ? {} : { model: named }) }, prompt: "Reply with the single word OK.", cwd: work, scenario: freshScenario });
		if (!fresh.run || !checkSettled(ctx, result, "fresh", fresh, undefined)) return;
		if (named !== undefined) result.check(fresh.run.selection.model === named, `fresh: the verified model is the named ${named}`);
		const source = sourceOf(fresh);
		result.fact("recorded selection", JSON.stringify(source.selection));
		const resumed = await backendRun(ctx, result, { leg: "resume", call: { role: "ask", mode: "answer" }, recorded: source.selection, intent: { kind: "resume", ref: source.ref }, prompt: "Reply with the single word OK again.", cwd: work, scenario: "resume-ok", fakeExtra: fakeHistory([source.ref.checkpoint], source.ref.baseline, "b-") });
		if (!resumed.run) return;
		result.check(resumed.role.model === source.selection.model && resumed.role.provider === source.selection.provider && resumed.role.effort === source.selection.effort, "resume: the call named no model, and the role binding took the recorded model, provider and effort");
		if (!checkSettled(ctx, result, "resume", resumed, source.ref.baseline)) return;
		checkPinned(result, "resume", resumed, source.selection);
		result.check(resumed.run.session.sessionId === source.ref.sessionId && resumed.run.session.checkpoint !== source.ref.checkpoint, "resume: the same thread, settled on a new checkpoint and baseline");
	},
};

// Last, so every class and table above is initialized before the first await reaches them.
process.exitCode = await main(parseArgs(process.argv.slice(2)));
