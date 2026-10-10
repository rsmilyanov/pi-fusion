import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/*
 * The pure half of `codex-app-server.mjs`, the Codex qualification harness: its command line, its case catalogue, the
 * rules a case's status follows and Q14's usage summary. Node builtins only, and importing it does nothing: no process, no
 * `PATH` lookup, no Codex home, configuration or auth read, no production module loaded. `test/codex-harness.test.ts`
 * imports it directly, which is why it is apart from the entry program.
 *
 * The sandbox and permissions are the user's own Codex configuration, trusted as Claude's and Pi's are: no case
 * re-audits that boundary. The cases measure what Fusion relies on — the handshake, the start checks and readback, a
 * turn's outcome, cancellation and the owned shutdown — and that the user's configuration is left unchanged.
 */

/** Exit codes, the same as the Pi harnesses': every selected case passed, any failed or is unproven, or none ran. */
export const EXIT = Object.freeze({ pass: 0, failure: 1, none: 2 });

/**
 * Every case this harness knows: stage 1's G1 cases, then stage 2's G2 cases (Q10 to Q13 and Q19) and Q14, a stage 2
 * preparation measurement outside G2's gate, and stage 3's G3 cases (Q15, Q16), which script question answers and
 * cancellation. Every current backend call has a callback; other cases fail on an unexpected question. `model` marks a case that starts a turn, which is a provider request on the
 * user's own login and quota with a cost Codex does not report; the others start a child and at most a thread. `fake`
 * marks a case the fake app-server can drive end to end; the rest need a native child that really runs a model. `needs`
 * names the option without which a case skips before anything starts, which it then does in either mode.
 */
export const CASES = Object.freeze([
	{ id: "Q1", model: false, fake: true, title: "initialize: reported Codex home, user agent and platform against the prediction; node and version evidence" },
	{ id: "Q2", model: false, fake: true, title: "thread/start + thread/read with no request cwd: host-default and explicit model/provider/effort readback, implement and both ask modes, cwd realpath binding" },
	{ id: "Q3", model: true, fake: false, title: "implement: a minimal fixture edit and a nonce delivered only in developer instructions, with no commit" },
	{ id: "Q3b", model: true, fake: false, needs: "effort", title: "a named effort (--effort) that differs from the configured default reads back exactly; skipped without one" },
	{ id: "Q4", model: true, fake: true, title: "read-only ask: answer from a fixture file, readOnly reported, no fixture write, no commit and no approval; hosted search items observed, not gating" },
	{ id: "Q6", model: true, fake: true, title: "cancellation through the production signal once the primary turn's first command starts (fake: at turn admission): aborted, stop requested, clean owned shutdown" },
	{ id: "Q7", model: false, fake: true, title: "under the production owned shutdown (SIGTERM to observed descendants first, then stdin end) the root exits by itself: status 0, no root signal, nothing left" },
	{ id: "Q9", model: false, fake: true, title: "an untrusted fixture cwd started with no request cwd: configuration bytes unchanged, sandbox kept" },
	{ id: "Q10", model: true, fake: true, title: "G2: a fresh backend ask, then a backend resume of its reference: tip at the checkpoint, a new checkpoint and baseline, the selection pinned, per-call usage against the baseline" },
	{ id: "Q11", model: true, fake: true, title: "G2: one extra direct-transport turn moves a fresh thread's tip; the backend resume of the original reference is refused with RESUME_MOVED before any turn/start" },
	{ id: "Q12", model: true, fake: true, title: "G2: a fresh backend ask, then a backend fork of its reference: a new thread at a completed starting tip, a new checkpoint and baseline, per-call usage against the source baseline" },
	{ id: "Q13", model: true, fake: true, title: "G2: one steer pushed when the primary turn's first command starts (fake: at turn admission), accepted by the child for that admitted turn, then a clean completion" },
	{ id: "Q14", model: true, fake: true, title: "usage over two sequential turns of one fresh ask thread: every scoped usage counter, absent fields as absent, total-vs-last additivity observed (stage 2 preparation, not G1)" },
	{ id: "Q15", model: true, fake: true, title: "G3: a question on a fresh thread, then on its resume and a fork of that resume, each answered by the callback with a new synthetic answer the report must carry; tool registered on the fresh thread only" },
	{ id: "Q16", model: true, fake: true, title: "G3: cancellation while the first question waits: the question's signal aborts, one failed tool reply, aborted with no checkpoint, clean owned shutdown" },
	{ id: "Q19", model: true, fake: true, title: "G2: a fresh backend ask (--model optional), then a resume naming no model: the recorded model, provider and effort pinned in request and readback (a same-model round trip unless measured otherwise)" },
]);

/** Named selections. `all` is spelled out on purpose: nothing native runs without a `--case`. */
export const GROUPS = Object.freeze({
	"model-free": ["Q1", "Q2", "Q7", "Q9"],
	all: CASES.map((entry) => entry.id),
});

/** The flags that take a value, in either `--flag value` or `--flag=value` spelling. */
const VALUE_FLAGS = Object.freeze({
	"--case": "case",
	"--model": "model",
	"--effort": "effort",
});
const BOOLEAN_FLAGS = Object.freeze({ "--run": "run", "--fake": "fake", "--list": "list", "--help": "help", "-h": "help", "--keep": "keep" });

/** One model id or effort level as Codex takes one: non-empty, bounded, with no whitespace or control character. */
export function isToken(value) {
	if (typeof value !== "string" || value === "" || value.length > 256) return false;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f) return false;
	}
	return true;
}

/**
 * Strict on purpose, as the Pi harnesses are: every spelling reaches the same place, a valueless or repeated flag is a
 * problem rather than a default, and anything unrecognised is collected, because an ignored `--case=nope` must never
 * run a different selection than the one the command line named.
 */
export function parseArgs(args) {
	const parsed = { run: false, fake: false, list: false, help: false, keep: false, unknown: [], problems: [] };
	const seen = new Set();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (Object.hasOwn(BOOLEAN_FLAGS, arg)) {
			parsed[BOOLEAN_FLAGS[arg]] = true;
			continue;
		}
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		if (!Object.hasOwn(VALUE_FLAGS, flag)) {
			parsed.unknown.push(arg);
			continue;
		}
		let value;
		if (eq !== -1) value = arg.slice(eq + 1);
		else if (args[index + 1] !== undefined && !args[index + 1].startsWith("-")) value = args[++index];
		const key = VALUE_FLAGS[flag];
		if (seen.has(key)) parsed.problems.push(`${flag} is given more than once`);
		seen.add(key);
		if (value === undefined || value === "") {
			parsed.problems.push(`${flag} needs a value`);
			continue;
		}
		parsed[key] = value;
	}
	for (const key of ["model", "effort"]) {
		if (parsed[key] !== undefined && !isToken(parsed[key])) parsed.problems.push(`--${key} must be one token with no whitespace`);
	}
	return parsed;
}

/** The cases a `--case` value names: comma-separated ids or group names, case-insensitive, in catalogue order. */
export function selectCases(spec) {
	if (spec === undefined || spec.trim() === "") return { error: "--case needs a case id, a comma-separated list, a group, or all" };
	const wanted = new Set();
	for (const raw of spec.split(",")) {
		const name = raw.trim();
		const group = Object.keys(GROUPS).find((key) => key === name.toLowerCase());
		if (group) {
			for (const id of GROUPS[group]) wanted.add(id);
			continue;
		}
		const entry = CASES.find((candidate) => candidate.id.toLowerCase() === name.toLowerCase());
		if (!entry) return { error: `no case or group is named ${JSON.stringify(name)}` };
		wanted.add(entry.id);
	}
	return { cases: CASES.filter((entry) => wanted.has(entry.id)) };
}

export const WARNING = `NATIVE RUNS USE YOUR OWN CODEX INSTALL AS IT IS.
  The child is the host's codex (PI_FUSION_CODEX_BIN or the first codex on PATH) with this process's environment
  unchanged: your Codex home, configuration, profiles, login, MCP servers, remote-control and multi-agent settings.
  Cases marked [model] start turns: provider requests on your authentication and quota, with a cost Codex does not
  report (USD unknown, never estimated). Every thread may leave rollouts, logs or state in your existing Codex home.
  Nothing is isolated, copied, logged in or overridden; config.toml is hashed before and after and never written.`;

export const USAGE = `node test/spikes/codex-app-server.mjs --list
node test/spikes/codex-app-server.mjs --run --case <ids|group|all> [options]
node test/spikes/codex-app-server.mjs --run --fake --case <ids> [options]

  --run                     required for anything to start; without it nothing is located, read or spawned
  --case Q1,Q2 | model-free | all
                            what runs; there is no default selection
  --fake                    drive test/fake-codex.mjs by path instead of Codex: NOT NATIVE evidence
  --model <id>              Q2 explicit-model leg; Q19's fresh call (its resume names none)
  --effort <level>          Q3b named effort (skipped without one; no catalogue is guessed)
  --keep                    keep the fixture root even when every child ended cleanly
  --list | --help           print and exit 2; nothing runs

Exit 0: every selected case passed (skips allowed). 1: a case failed or is unproven. 2: nothing ran.

${WARNING}`;

/* ------------------------------------------------------------------------------------------------------------------
 * paths
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * The canonical form of an absolute path that may not exist yet: the realpath of its nearest existing ancestor with the
 * rest appended, so a reported path and the one it is compared against go through the same symlinks.
 */
export function canonicalPath(file) {
	let current = path.resolve(file);
	const rest = [];
	for (;;) {
		try {
			const real = fs.realpathSync.native(current);
			return rest.length === 0 ? real : path.join(real, ...rest.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(file);
			rest.push(path.basename(current));
			current = parent;
		}
	}
}

/* ------------------------------------------------------------------------------------------------------------------
 * what the backend sends
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * The shared role contract as `createCodexBackend` sends it, also used by model-free direct-transport cases. Tool
 * registration belongs to the transport, not these fields: only a connection with a question callback adds it.
 */
export function composeInstructions(role, read) {
	return `${read(role.contract).trimEnd()}\n`;
}

/** The thread/start body the backend sends for a role: only the named selection, the sandbox mode, approval never, instructions. */
export function threadParams(role, instructions) {
	return {
		...(role.model === undefined ? {} : { model: role.model }),
		...(role.provider === undefined ? {} : { modelProvider: role.provider }),
		sandbox: role.sandboxMode,
		approvalPolicy: role.approvalPolicy,
		developerInstructions: instructions,
	};
}

/**
 * A case's status from its own measurements and the guards around them. Guards — configuration unchanged, a clean
 * owned shutdown, no approval asked, a preflight child — can fail or leave a case unproven, but never pass it: only a
 * primary measurement can. A case whose measurements were all skipped stays a skip however many guards held.
 */
export function caseStatus(primary, guards) {
	if (primary.includes("fail") || guards.includes("fail")) return "fail";
	if (primary.includes("unproven") || guards.includes("unproven")) return "unproven";
	return primary.includes("pass") ? "pass" : "skip";
}

/** The harness's exit code from every selected case's status. */
export function exitCode(statuses) {
	if (statuses.some((status) => status === "fail" || status === "unproven")) return EXIT.failure;
	return statuses.includes("pass") ? EXIT.pass : EXIT.none;
}

/** What a second interrupt prints before exiting at once: the fixture root left behind, and that nothing was proved over. */
export function forcedExitNotice(root) {
	return [
		"interrupted again: exiting now, without cleanup, without waiting for any child, and without proving anything over",
		`  retained (uncertain): ${root}`,
		"  inspect it and any codex process this harness started yourself; nothing here says they are gone",
	].join("\n");
}

/* ------------------------------------------------------------------------------------------------------------------
 * configuration and version evidence
 * ---------------------------------------------------------------------------------------------------------------- */

/** A file's sha256, `absent` when there is none, or `unreadable`. Bytes are hashed in memory and never kept or shown. */
export function fileDigest(file) {
	try {
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch (error) {
		return error && error.code === "ENOENT" ? "absent" : "unreadable";
	}
}

/** The version a user agent such as `originator/0.160.0 (Linux ...)` names after its first slash, or none. Unverified. */
export function versionFromUserAgent(userAgent) {
	const match = /^[^\s/]+\/(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(userAgent ?? "");
	return match ? match[1] : undefined;
}

/* ------------------------------------------------------------------------------------------------------------------
 * Q14: usage counters
 * ---------------------------------------------------------------------------------------------------------------- */

/** The counters one usage breakdown carries in Codex 0.160.0's shape (source-read), in display order. */
export const USAGE_FIELDS = Object.freeze(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens", "cacheWriteInputTokens"]);

/** The counters a usage summary needs as counts. Cache write is not among them: an absent one is shown absent, never 0. */
const REQUIRED_FIELDS = USAGE_FIELDS.filter((field) => field !== "cacheWriteInputTokens");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * One counter as the child reported it: a count, or `null`, `absent` or `invalid`. Read from the raw params, because
 * the production reader takes an absent cache write for its declared default of zero, and Q14 must not.
 */
export function reportedCount(holder, key) {
	if (!isObject(holder) || !Object.hasOwn(holder, key)) return "absent";
	const value = holder[key];
	if (value === null) return "null";
	return Number.isSafeInteger(value) && value >= 0 ? value : "invalid";
}

/** The counters of one thread/tokenUsage/updated: both breakdowns and the window, nothing else read from it. */
export function usageCounters(params) {
	const usage = isObject(params) ? params.tokenUsage : undefined;
	const breakdown = (part) => Object.fromEntries(USAGE_FIELDS.map((field) => [field, reportedCount(isObject(usage) ? usage[part] : undefined, field)]));
	return { total: breakdown("total"), last: breakdown("last"), modelContextWindow: reportedCount(usage, "modelContextWindow") };
}

/** A breakdown as one line, every field named and an absent or null one spelled out. */
export function describeCounters(breakdown) {
	return USAGE_FIELDS.map((field) => `${field}=${breakdown[field]}`).join(" ");
}

/**
 * Why one turn's usage updates cannot be summarized, or `undefined` when they can: at least one update, and its latest
 * total and last carrying every required field as a count. A null or absent window, or an absent cache write, is shown
 * as such and does not make a turn unusable.
 */
export function usageProblem(updates) {
	if (updates.length === 0) return "no usage update named this turn";
	const latest = updates[updates.length - 1];
	for (const part of ["total", "last"]) {
		const missing = REQUIRED_FIELDS.filter((field) => typeof latest[part][field] !== "number");
		if (missing.length > 0) return `the latest update's ${part} has no count for ${missing.map((field) => `${field} (${latest[part][field]})`).join(", ")}`;
	}
	return undefined;
}

/**
 * Whether the second turn's final cumulative total is the first's plus the sum of every `last` the second turn
 * reported, field by field: `yes`, `no`, or `unknown` when any value it needs is not a count. An observation of how the
 * counters behaved, never a policy for summing `last`: a `no` may mean an update re-sent an unchanged total, or that
 * `total` counts more than the updates show.
 */
export function additivity(previousTotal, currentTotal, lasts) {
	const out = {};
	for (const field of USAGE_FIELDS) {
		const values = [previousTotal[field], currentTotal[field], ...lasts.map((last) => last[field])];
		if (!values.every((value) => typeof value === "number")) {
			out[field] = { previous: previousTotal[field], current: currentTotal[field], sumOfLasts: "unknown", holds: "unknown" };
			continue;
		}
		const sumOfLasts = lasts.reduce((sum, last) => sum + last[field], 0);
		out[field] = { previous: previousTotal[field], current: currentTotal[field], sumOfLasts, holds: previousTotal[field] + sumOfLasts === currentTotal[field] ? "yes" : "no" };
	}
	return out;
}

/**
 * What the reported cache-write counts can and cannot say about their relation to input. Only a positive count is
 * compared, and only as `cached + cacheWrite <= input` held or not: zero, null or absent counts measure no relation.
 */
export function cacheWriteObservation(updates) {
	const tally = { absent: 0, null: 0, invalid: 0, zero: 0, positive: 0, within: 0 };
	for (const update of updates) {
		for (const part of ["total", "last"]) {
			const breakdown = update[part];
			const write = breakdown.cacheWriteInputTokens;
			if (typeof write !== "number") tally[write] += 1;
			else if (write === 0) tally.zero += 1;
			else {
				tally.positive += 1;
				if (typeof breakdown.inputTokens === "number" && typeof breakdown.cachedInputTokens === "number" && breakdown.cachedInputTokens + write <= breakdown.inputTokens) tally.within += 1;
			}
		}
	}
	const counts = `over ${updates.length * 2} breakdowns: ${tally.positive} positive, ${tally.zero} zero, ${tally.absent} absent, ${tally.null} null, ${tally.invalid} invalid`;
	if (tally.positive === 0) return `${counts}; no positive cache write was reported, so this run measures no cache-write vs input relation`;
	return `${counts}; cached + cacheWrite <= input held in ${tally.within} of ${tally.positive} positive breakdowns (an observation, not proof that cache write is part of input)`;
}

/* ------------------------------------------------------------------------------------------------------------------
 * G2: per-call usage, published counters and steers
 * ---------------------------------------------------------------------------------------------------------------- */

/** The five counts a baseline is measured in. Cache write is a diagnostic beside them and never one of them. */
export const CORE_FIELDS = Object.freeze(REQUIRED_FIELDS);

/**
 * One call's share of a thread's cumulative total, field by field over the five core counts: the current total less the
 * baseline the call started from, none on a fresh thread. `holds` is the current count at or above its baseline; the
 * difference is shown even when it does not hold, because that is the measurement, never clamped.
 */
export function coreDelta(baseline, current) {
	return Object.fromEntries(
		CORE_FIELDS.map((field) => {
			const before = baseline === undefined ? 0 : baseline[field];
			const now = current[field];
			const counted = Number.isSafeInteger(before) && Number.isSafeInteger(now);
			return [field, { baseline: before, current: now, delta: counted ? now - before : "unknown", holds: counted && now >= before }];
		}),
	);
}

/**
 * Where a run's published counters differ from a call's delta: input, output and cache read are the SDK fields a run
 * publishes, so only they are compared. Reasoning output and the total have no published field, and cache write is a
 * diagnostic whose 0 may be unobserved, so neither is a problem here.
 */
export function publishedUsageProblems(run, delta) {
	const pairs = [
		["tokensIn", "inputTokens"],
		["tokensOut", "outputTokens"],
		["cacheRead", "cachedInputTokens"],
	];
	return pairs.filter(([published, field]) => run[published] !== delta[field].delta).map(([published, field]) => `${published}=${run[published]} but the ${field} delta is ${delta[field].delta}`);
}

/**
 * Why a run's published context does not follow the rule, or `undefined` when it does: the latest response's input
 * against the window when both are positive, and neither published otherwise. Never the cumulative total or the delta.
 */
export function contextProblem(run, lastInput, window) {
	const positive = typeof lastInput === "number" && lastInput > 0 && typeof window === "number" && window > 0;
	if (positive) return run.contextTokens === lastInput && run.contextWindow === window ? undefined : `context ${run.contextTokens}/${run.contextWindow} is not the latest input ${lastInput} against the window ${window}`;
	return run.contextTokens === undefined && run.contextWindow === undefined ? undefined : `context ${run.contextTokens}/${run.contextWindow} is published although the latest input ${lastInput} or the window ${window} is not positive`;
}

/**
 * Q13's verdict from what the run's own input and the child's answer said, never from the model's reply: the one push
 * taken, exactly one `turn/steer` for the admitted turn, the child's answer accepting it, and the queue counting that
 * one acceptance and nothing else. A steer never pushed, never sent, refused or left unanswered is unproven; a second
 * send or one naming another turn is a failure, because the run sends each message once and only to its own turn.
 */
export function steerProof({ pushed, queued, calls, turn, report }) {
	if (!pushed) return { status: "unproven", why: "no steer was pushed: the trigger never came" };
	if (!queued) return { status: "unproven", why: "the run's input did not take the steer" };
	if (calls.length > 1) return { status: "fail", why: `${calls.length} turn/steer requests were sent for one pushed message` };
	if (calls.length === 0) return { status: "unproven", why: "no turn/steer request was sent" };
	const [call] = calls;
	if (turn === undefined || call.threadId !== turn.threadId || call.turnId !== turn.turnId) return { status: "fail", why: "the turn/steer named another thread or turn than the admitted one" };
	if (call.outcome !== "accepted") return { status: "unproven", why: `the child did not accept the steer (${call.outcome})` };
	if (!report || report.accepted !== 1 || report.rejected + report.unconfirmed + report.unsent + report.dropped !== 0) return { status: "unproven", why: `the run's steer counts do not say one accepted: ${JSON.stringify(report)}` };
	return { status: "pass", why: "one steer, sent once to the admitted turn, accepted by the child" };
}

/* ------------------------------------------------------------------------------------------------------------------
 * G3: question verdicts
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * One Q15 leg's question verdict from the callback's own count, the child's question counters and whether the report
 * carries this leg's answer, never from the report's other prose. A repeated request id, or counters that disagree with
 * the callback, is a failure of the bridge. More than one distinct question is the model asking again, which the host
 * can answer, so it is unproven rather than failed, as are no callback, no counters, a refused call or no echo.
 */
export function questionProof({ callbacks, counters, echoed }) {
	if (counters !== undefined && counters.duplicateServerRequests > 0) return { status: "fail", why: `${counters.duplicateServerRequests} server request ids were asked again` };
	if (counters !== undefined && counters.questions !== callbacks) return { status: "fail", why: `${callbacks} question callbacks, but the child's counters say ${counters.questions} questions were asked` };
	if (callbacks === 0) return { status: "unproven", why: "no question reached the callback" };
	if (counters === undefined) return { status: "unproven", why: "no exit report carries the child's question counters" };
	if (callbacks > 1) return { status: "unproven", why: `the model asked more than once (${callbacks} distinct questions) where one was asked for` };
	if (counters.refusedQuestions > 0) return { status: "unproven", why: `${counters.refusedQuestions} question calls were refused beside the one asked` };
	if (!echoed) return { status: "unproven", why: "the report does not carry this leg's answer" };
	return { status: "pass", why: "one question, asked once through the callback, its answer carried by the report" };
}
