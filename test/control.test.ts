import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fusion, { parseFusion } from "../extensions/fusion.ts";
import { HISTORY_VERSION } from "../extensions/history.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_FUSION_CLAUDE_BIN = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.FAKE_CLAUDE_SCENARIO = "read";
process.env.PI_FUSION_DASHBOARD_OPEN = "0";

type Result = { content: Array<{ type: string; text: string }>; details: any };

interface Tool {
	name: string;
	execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: undefined, ctx: any) => Promise<Result>;
}

interface Item {
	value: string;
	label: string;
}

interface Command {
	getArgumentCompletions: (prefix: string) => Item[] | null;
	handler: (args: string, ctx: any) => Promise<void>;
}

/** What ctx.ui.custom gives back: the component the extension built for one /fusion wait. */
interface Wait {
	render: (width: number) => string[];
	handleInput: (data: string) => void;
	invalidate: () => void;
	dispose?: () => void;
}

type WaitFactory = (tui: { requestRender: () => void }, theme: any, keybindings: any, done: (escaped: boolean) => void) => Wait;

/** What pi.registerMessageRenderer is given: the renderer of one custom message type. */
type Renderer = (message: any, options: { expanded: boolean; outputPad: number }, theme: any) => { render: (width: number) => string[] } | undefined;

const USAGE =
	"Usage: /fusion dashboard | /fusion dashboard stop | /fusion status [run-N] | /fusion cancel run-N | /fusion wait run-N | /fusion steer run-N <text> | /fusion answer [run-N] [text] | /fusion review run-N";
const ESC = "\u001b";
const BEL = "\u0007";

/** A host whose branch grows with every entry the extension appends, as Pi's does. */
function makeHost(cwd = repoRoot, mode: "tui" | "print" = "print", session: { id?: string; file?: string } = {}) {
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const notices: Array<[string, string]> = [];
	const branch: unknown[] = [];
	const sent: Array<[any, any]> = [];
	const waits: Wait[] = [];
	const renders: number[] = [];
	const finished: boolean[] = [];
	const editors: Array<{ title: string; prefill?: string }> = [];
	const renderers = new Map<string, Renderer>();
	const widgets: Array<[string, string[] | undefined]> = [];
	let openEditor: ((text: string | undefined) => void) | undefined;
	const api = {
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		on: (event: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) => handlers.set(event, handler),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		sendMessage: (message: unknown, options: unknown) => sent.push([message, options]),
		registerMessageRenderer: (customType: string, renderer: Renderer) => renderers.set(customType, renderer),
	} as unknown as ExtensionAPI;
	fusion(api);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, dim: (text: string) => text };
	const ui = {
		setStatus(_key: string, _text: string | undefined) {},
		setWidget: (key: string, lines: string[] | undefined) => widgets.push([key, lines]),
		notify: (text: string, type: string) => notices.push([text, type]),
		editor: (title: string, prefill?: string) =>
			new Promise<string | undefined>((resolve) => {
				editors.push({ title, prefill });
				openEditor = resolve;
			}),
		custom: (factory: WaitFactory) =>
			new Promise<boolean>((resolve) => {
				const component = factory({ requestRender: () => renders.push(Date.now()) }, theme, {}, (escaped: boolean) => {
					finished.push(escaped);
					component.dispose?.();
					resolve(escaped);
				});
				waits.push(component);
			}),
	};
	/** Only a session Pi keeps a file for has a session file, and only such a session keeps a run history. */
	const sessionManager: Record<string, unknown> = { getSessionId: () => session.id ?? "host-1", getBranch: () => branch };
	if (session.file !== undefined) sessionManager.getSessionFile = () => session.file;
	const ctx = { cwd, mode, hasUI: true, ui, sessionManager };
	const call = (name: string, params: Record<string, unknown>, signal?: AbortSignal) => tools.get(name)!.execute("call-1", params, signal, undefined, ctx);
	const claude = (params: Record<string, unknown>, signal?: AbortSignal) => call("claude", params, signal);
	const control = (params: Record<string, unknown>, signal?: AbortSignal) => call("claude_control", params, signal);
	const text = async (result: Promise<Result>) => (await result).content[0]!.text;
	const tree = () => handlers.get("session_before_tree")!({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal }, ctx);
	const command = (args: string) => commands.get("fusion")!.handler(args, ctx);
	/** Pi's sendMessage throws once this extension runtime is no longer the session's. */
	const failSends = () => {
		api.sendMessage = () => {
			throw new Error("extension runtime is stale");
		};
	};
	const completions = (prefix: string) => commands.get("fusion")!.getArgumentCompletions(prefix);
	/** Closes the editor the command opened, as the user does by saving or cancelling it. */
	const closeEditor = (typed: string | undefined) => {
		const resolve = openEditor!;
		openEditor = undefined;
		resolve(typed);
	};
	return { branch, sent, handlers, notices, waits, renders, finished, ctx, ui, editors, widgets, renderers, claude, control, text, tree, command, completions, closeEditor, failSends };
}

/** A run's details without the three a test cannot pin down: how long it ran and what it had changed by then. */
function fixed(details: any): any {
	const { elapsedMs, filesChanged, files, ...rest } = details;
	assert.equal(typeof elapsedMs, "number", `no elapsed time in ${JSON.stringify(details)}`);
	return rest;
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 5_000, every = 20): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, every));
	}
}

/**
 * Waits until the run's state reads terminal, which the /fusion status line says without touching git. The run's end
 * path is then still listing the files it changed, so the call that follows lands inside that window.
 */
async function finishing(host: ReturnType<typeof makeHost>, handle: string, state = "done"): Promise<void> {
	const line = new RegExp(`^${handle} · .* · ${state} ·`, "m");
	await until(
		`${handle} to read ${state}`,
		async () => {
			host.notices.length = 0;
			await host.command("status");
			return line.test(host.notices[0]?.[0] ?? "");
		},
		10_000,
		0,
	);
	host.notices.length = 0;
	assert.equal(host.branch.length, 0, `${handle} finished before the call under test could land inside its end path`);
}

/** Resolves once the child has made its first tool call, so the run has an activity and a session id. */
const started = (host: ReturnType<typeof makeHost>, handle: string) =>
	until(`${handle} to start`, async () => /tool calls: 1/.test(await host.text(host.control({ action: "status", run: handle }))));

async function withScenario<T>(scenario: string, body: () => Promise<T>): Promise<T> {
	process.env.FAKE_CLAUDE_SCENARIO = scenario;
	try {
		return await body();
	} finally {
		process.env.FAKE_CLAUDE_SCENARIO = "read";
	}
}

test("a background run returns its handle at once and ends with a notice Pi delivers as a new turn or a follow-up", async () => {
	const host = makeHost();
	const started = await withScenario("slow", () => host.text(host.claude({ role: "implement", task: "do a thing", background: true })));
	assert.equal(started, "run-1 started in the background; you get the report when it ends");
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · running · background · \d+s$/);
	await until("the completion notice", () => host.sent.length > 0);
	const [message, options] = host.sent[0]!;
	assert.equal(message.customType, "pi-fusion-run");
	assert.equal(message.display, true);
	assert.match(message.content, /^Background run run-1 \(implement\) done\.\n\ndone\n\n\[run-1 · implement · opus · /);
	assert.deepEqual(fixed(message.details), { handle: "run-1", role: "implement", model: "opus", state: "done", background: true });
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" }, "Pi starts a turn when idle and queues a follow-up mid-turn");
	assert.equal((host.branch[0] as any).data.run, "run-1");
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · done · background · \d+s$/);
});

test("a second run that can change files fails while one is active, an ask run does not, and cancel stops the active run", async () => {
	const host = makeHost();
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	await assert.rejects(host.claude({ role: "ultracode", task: "other work" }), {
		message: "run-1 (implement) is still active; wait for it, message it or cancel it with claude_control before you start or continue another run that can change files",
	});
	await assert.rejects(host.claude({ continue: "run-1", task: "more" }), /^Error: run-1 is still active; send it a message with claude_control message/);
	const answer = await host.text(host.claude({ role: "ask", task: "where is x?" }));
	assert.match(answer, /^done\n\n\[run-2 · ask · opus · /);
	assert.equal(await host.text(host.control({ action: "cancel", run: "run-1" })), "run-1 cancelled");
	assert.match(await host.text(host.control({ action: "status", run: "run-1" })), /^run-1 · implement · opus · cancelled · background · \d+s\ntool calls: 1/);
	assert.equal(await host.text(host.control({ action: "cancel", run: "run-1" })), "run-1 has already ended: cancelled. Nothing to cancel.");
	assert.deepEqual(host.sent, [], "a cancelled run sends no notice");
	const next = await host.text(host.claude({ role: "implement", task: "now it can start" }));
	assert.match(next, /\[run-3 · implement · /);
});

test("Esc during wait stops the wait only, and a later wait returns the report instead of a notice", async () => {
	const host = makeHost();
	await withScenario("slow", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	const esc = new AbortController();
	const waiting = host.control({ action: "wait", run: "run-1" }, esc.signal);
	setTimeout(() => esc.abort(), 100);
	await assert.rejects(waiting, { message: "stopped waiting; run-1 goes on in the background" });
	assert.match(await host.text(host.control({ action: "status", run: "run-1" })), /· running · background ·/);
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /^run-1 \(implement\) done\.\n\ndone\n\n\[run-1 · implement · /);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(host.sent, [], "the wait carried the report, so no notice repeats it");
});

test("a wait that lands while the run is still finishing carries the report, so no notice repeats it", async () => {
	const host = makeHost();
	await withScenario("slow", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	await finishing(host, "run-1");
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /^run-1 \(implement\) done\.\n\ndone\n\n\[run-1 · implement · /);
	assert.deepEqual(host.sent, [], "the wait carried the report, so no notice repeats it");
});

test("a continue that lands while the run is still finishing waits for the record instead of missing it", async () => {
	const host = makeHost();
	await withScenario("slow", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	await finishing(host, "run-1");
	const next = await withScenario("ok", () => host.text(host.claude({ continue: "run-1", task: "more" })));
	assert.match(next, /\[run-1 · implement · /, "the continued call found the run's session on the branch");
	assert.equal(host.branch.length, 2, "the finished run recorded its entry, and the continued one its own");
});

test("a message to a running child is a steer the child receives", async () => {
	const host = makeHost();
	await withScenario("steer", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	const sent = await host.control({ action: "message", run: "run-1", message: "also update the README" });
	assert.equal(sent.content[0]!.text, "steer sent to run-1; the child reads it when it next takes input");
	assert.equal(sent.details.sent, "steer");
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /^run-1 \(implement\) done\.\n\nsteered: also update the README\n\n/);
});

test("a message to a run that has ended sends nothing and returns its state and a report summary", async () => {
	const host = makeHost();
	await host.claude({ role: "implement", task: "do a thing" });
	const reply = await host.control({ action: "message", run: "run-1", message: "and the tests" });
	assert.equal(
		reply.content[0]!.text,
		"run-1 (implement) has ended: done. The message was not sent.\n\nReport summary:\ndone\n\nIf the message still applies, continue the run with claude and continue run-1, where you can also set model, effort, context and background. Otherwise take no action.",
	);
	assert.deepEqual(fixed(reply.details), { handle: "run-1", role: "implement", model: "opus", state: "done", background: false, sent: "none" });
	assert.deepEqual(host.sent, []);
});

test("status lists nothing before the first run, and a run recorded before this Pi process is not active", async () => {
	const host = makeHost();
	assert.equal(await host.text(host.control({ action: "status" })), "no claude runs in this Pi session yet");
	host.branch.push({ type: "custom", customType: "pi-fusion", data: { run: "run-4", role: "plan", sessionId: "s-4", hostSessionId: "host-1" } });
	assert.equal(
		await host.text(host.control({ action: "message", run: "run-4", message: "x" })),
		"run-4 (plan) ran before this Pi session started and is not active. The message was not sent. Continue it with claude and continue run-4, or take no action.",
	);
	await assert.rejects(host.control({ action: "wait", run: "run-9" }), { message: "unknown run run-9" });
	await assert.rejects(host.control({ action: "wait" }), { message: "wait needs run" });
	await assert.rejects(host.control({ action: "message", run: "run-4" }), { message: "message needs message" });
	await assert.rejects(host.control({ action: "kill", run: "run-4" }), { message: "unknown action kill; use one of status, wait, message, cancel" });
});

test("a new handle skips every handle this Pi process has used, so a run on another branch keeps its own", async () => {
	const host = makeHost();
	await host.claude({ role: "implement", task: "one" });
	host.branch.length = 0;
	const second = await host.text(host.claude({ role: "implement", task: "two" }));
	assert.match(second, /\[run-2 · implement · /);
});

test("Esc during a foreground run aborts it, as before", async () => {
	const host = makeHost();
	const esc = new AbortController();
	const running = withScenario("hang", () => host.claude({ role: "implement", task: "long work" }, esc.signal));
	setTimeout(() => esc.abort(), 200);
	await assert.rejects(running, /^Error: implement aborted/);
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · aborted · \d+s$/);
	assert.deepEqual(host.sent, []);
});

test("session_shutdown stops active runs without a notice", async () => {
	const host = makeHost();
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	await host.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, host.ctx);
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · cancelled · background · \d+s$/);
	assert.deepEqual(host.sent, []);
});

const asks = (handle: string, role: string, question: string) =>
	`${handle} (${role}) asks:\n\n${question}\n\nThe run waits in the background until you answer with claude_control message and run ${handle}. Ask the user first if the decision is theirs.`;

test("a question in a foreground run returns it at once, the run waits in the background, and the answer reaches the child as the tool result", async () => {
	const host = makeHost();
	const argvOut = path.join(os.tmpdir(), `pi-fusion-question-${process.pid}.json`);
	process.env.FAKE_CLAUDE_ARGV_OUT = argvOut;
	let asked: Result;
	try {
		asked = await withScenario("question", () => host.claude({ role: "implement", task: "name it" }));
	} finally {
		delete process.env.FAKE_CLAUDE_ARGV_OUT;
	}
	assert.equal(asked.content[0]!.text, asks("run-1", "implement", "Which name?"));
	assert.deepEqual(fixed(asked.details), {
		handle: "run-1",
		role: "implement",
		model: "opus",
		background: true,
		state: "waiting",
		question: "Which name?",
		sessionUsage: { costUsd: 0, tokensIn: asked.details.sessionUsage.tokensIn, tokensOut: asked.details.sessionUsage.tokensOut, workflowTokens: 0, calls: 1 },
	});
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · waiting · background · \d+s\n  question: Which name\?$/);
	assert.equal(await host.text(host.control({ action: "wait", run: "run-1" })), asks("run-1", "implement", "Which name?"), "wait returns the open question");
	await assert.rejects(host.claude({ role: "implement", task: "other" }), /^Error: run-1 \(implement\) is still active/);
	const sent = await host.control({ action: "message", run: "run-1", message: "call it foo" });
	assert.equal(sent.content[0]!.text, "answer sent to run-1; the child goes on");
	assert.equal(sent.details.sent, "answer");
	assert.equal(sent.details.answered, "Which name?", "the details name the question the answer landed on");
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /^run-1 \(implement\) done\.\n\nanswered: call it foo; tools: ask_orchestrator\n\n\[run-1 · implement · /);
	assert.deepEqual(host.sent, []);
	const recorded = JSON.parse(fs.readFileSync(argvOut, "utf8"));
	fs.rmSync(argvOut, { force: true });
	assert.deepEqual(recorded.initialize.sdkMcpServers, ["pi-fusion"]);
	assert.deepEqual(recorded.initialize.sdkMcpServerConfigs, { "pi-fusion": { timeout: 2_147_483_647 } });
	assert.deepEqual(recorded.initialize.hooks.PreToolUse.map((matcher: any) => [matcher.matcher, matcher.timeout]), [["AskUserQuestion", 2_147_483]]);
	assert.ok(recorded.argv.includes("--strict-mcp-config"), "the user's MCP servers stay out");
	assert.equal(recorded.argv[recorded.argv.indexOf("--allowedTools") + 1], "mcp__pi-fusion__ask_orchestrator");
});

test("a question in a background run sends a notice, and the answered run ends with a second one", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	const [message, options] = host.sent[0]!;
	assert.equal(message.content, `Background run ${asks("run-1", "implement", "Which name?")}`);
	assert.deepEqual(fixed(message.details), { handle: "run-1", role: "implement", model: "opus", state: "waiting", background: true, question: "Which name?" });
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	await host.control({ action: "message", run: "run-1", message: "bar" });
	await until("the completion notice", () => host.sent.length > 1);
	assert.match(host.sent[1]![0].content, /^Background run run-1 \(implement\) done\.\n\nanswered: bar; /);
});

test("two open questions are answered in order, and the answer to the first returns the second without a notice", async () => {
	const host = makeHost();
	assert.equal(await withScenario("two-questions", () => host.text(host.claude({ role: "ask", task: "q" }))), asks("run-1", "ask", "First?"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(await host.text(host.control({ action: "message", run: "run-1", message: "one" })), "answer sent to run-1; the child goes on\n\nIt has another question:\n\nSecond?");
	assert.equal(await host.text(host.control({ action: "message", run: "run-1", message: "two" })), "answer sent to run-1; the child goes on");
	assert.match(await host.text(host.control({ action: "wait", run: "run-1" })), /\n\nanswered: one \| two; /);
	assert.deepEqual(host.sent, []);
});

test("an AskUserQuestion call takes the same path, and the hook allows it with one answer per question", async () => {
	const host = makeHost();
	const asked = await withScenario("ask-user", () => host.text(host.claude({ role: "ultracode", task: "set it up" })));
	assert.equal(
		asked,
		asks(
			"run-1",
			"ultracode",
			"1. [Store] Which store?\n- sqlite: one file\n- postgres\n\n2. [Checks] Which checks?\n- lint\n- types\n(one or more, separated by commas)\n\nAnswer each question on its own line, in order.",
		),
	);
	await host.control({ action: "message", run: "run-1", message: "1. sqlite\n2. lint, types" });
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	const output = JSON.parse(report.split("\n\n")[1]!);
	assert.equal(output.hookEventName, "PreToolUse");
	assert.equal(output.permissionDecision, "allow");
	assert.deepEqual(output.updatedInput.answers, { "Which store?": "sqlite", "Which checks?": "lint, types" });
	assert.equal(output.updatedInput.questions.length, 2, "the hook keeps the original input");
});

/** The question the question-escape scenario asks: it paints the terminal red and hides a link behind a label. */
const NASTY_QUESTION = `${ESC}[31mWhich name?${ESC}]8;;https://evil.test${BEL}click me${ESC}]8;;${BEL}`;

test("a child's escape sequences reach no /fusion notice, though the host still reads the question as it was asked", async () => {
	const host = makeHost();
	await withScenario("question-escape", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	const read = await host.text(host.control({ action: "status" }));
	assert.ok(read.includes(NASTY_QUESTION), `the host reads the question as data, escape sequences and all: ${JSON.stringify(read)}`);
	await host.command("status");
	await host.command("status run-1");
	await host.command("wait run-1");
	await host.command(`answer run-1 call it ${ESC}[31mfoo`);
	await host.command("wait run-1");
	for (const [text, level] of host.notices) {
		assert.ok(!text.includes(ESC), `an escape introducer reached the terminal: ${JSON.stringify(text)} (${level})`);
		assert.ok(!text.includes(BEL), `a bell reached the terminal: ${JSON.stringify(text)} (${level})`);
	}
	const said = (part: string) => assert.ok(host.notices.some(([text]) => text.includes(part)), `no notice carried ${JSON.stringify(part)}: ${JSON.stringify(host.notices)}`);
	said("\n  question: Which name?click me");
	said("run-1 asks: Which name?click me.");
	said("answered: call it foo;");
});

test("cancel stops a waiting run without a notice", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it" }));
	assert.equal(await host.text(host.control({ action: "cancel", run: "run-1" })), "run-1 cancelled");
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · cancelled · background · \d+s$/);
	assert.deepEqual(host.sent, []);
});

const treeBlocked = (names: string) =>
	`/tree is blocked while claude runs are active: ${names}. A report or run record that arrives after /tree would land on the destination branch. Wait for each run or cancel it with claude_control, then retry /tree.`;

test("/tree is refused while a background run is active and allowed again after cancel, without a new warning", async () => {
	const host = makeHost();
	assert.equal(await host.tree(), undefined);
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	assert.deepEqual(await host.tree(), { cancel: true });
	assert.deepEqual(host.notices, [[treeBlocked("run-1 (implement)"), "warning"]]);
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · running · background · /, "the refusal leaves the run alone");
	await host.control({ action: "cancel", run: "run-1" });
	assert.equal(await host.tree(), undefined);
	assert.equal(host.notices.length, 1);
});

test("/tree is refused while an ask run waits on a question", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "ask", task: "q" }));
	assert.deepEqual(await host.tree(), { cancel: true });
	assert.deepEqual(host.notices, [[treeBlocked("run-1 (ask)"), "warning"]]);
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · ask · opus · waiting · /);
	await host.control({ action: "cancel", run: "run-1" });
});

test("the /tree warning names every active run in start order", async () => {
	const host = makeHost();
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	await withScenario("question", () => host.claude({ role: "ask", task: "q" }));
	assert.deepEqual(await host.tree(), { cancel: true });
	assert.deepEqual(host.notices, [[treeBlocked("run-1 (implement), run-2 (ask)"), "warning"]]);
	await host.control({ action: "cancel", run: "run-1" });
	await host.control({ action: "cancel", run: "run-2" });
});

test("an ask run never lists changed files, even when a concurrent implement run edits the tree while the ask runs", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-control-")));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	fs.writeFileSync(path.join(dir, "base.txt"), "b\n");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	const host = makeHost(dir);
	try {
		await withScenario("hang", async () => {
			await host.claude({ role: "implement", task: "long work", background: true });
			await host.claude({ role: "ask", task: "where is x?", background: true });
		});
		fs.writeFileSync(path.join(dir, "note.txt"), "n\n");
		assert.doesNotMatch(await host.text(host.control({ action: "status", run: "run-2" })), /changed files/);
		assert.match(await host.text(host.control({ action: "status", run: "run-1" })), /\nchanged files:\nA note\.txt/);
		await host.control({ action: "cancel", run: "run-2" });
		assert.doesNotMatch(await host.text(host.control({ action: "status", run: "run-2" })), /changed files/, "an ended ask run lists no files either");
	} finally {
		await host.control({ action: "cancel", run: "run-1" }).catch(() => {});
		await host.control({ action: "cancel", run: "run-2" }).catch(() => {});
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A host in a scratch repository whose git blocks while the hold file exists, so a run that has ended can be held
 * in its final snapshot, before its entry and report are written.
 */
async function withGitHold(body: (host: ReturnType<typeof makeHost>, hold: string) => Promise<void>): Promise<void> {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-control-")));
	const bin = path.join(dir, ".bin");
	const hold = path.join(dir, ".hold");
	const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const git = (...args: string[]) => execFileSync(realGit, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	fs.writeFileSync(path.join(dir, ".gitignore"), ".bin/\n.hold\n");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nwhile [ -f '${hold}' ]; do sleep 0.02; done\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
	const pathBefore = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${pathBefore ?? ""}`;
	const host = makeHost(dir);
	try {
		await body(host, hold);
	} finally {
		fs.rmSync(hold, { force: true });
		if (pathBefore === undefined) delete process.env.PATH;
		else process.env.PATH = pathBefore;
		await host.control({ action: "cancel", run: "run-1" }).catch(() => {});
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Starts a background run, holds git, and lets the run end, so it is done but still in its final snapshot. */
async function heldInFinalSnapshot(host: ReturnType<typeof makeHost>, hold: string): Promise<void> {
	await withScenario("steer", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	fs.writeFileSync(hold, "");
	await host.control({ action: "message", run: "run-1", message: "finish now" });
	const done = async () => /^run-1 · implement · opus · done · /.test(await host.text(host.control({ action: "status" })));
	const deadline = Date.now() + 5_000;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the run to end");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.deepEqual(host.branch, [], "the final snapshot holds the entry back");
	assert.deepEqual(host.sent, [], "the final snapshot holds the report back");
}

test("/tree stays refused after a run ends until its entry and report are delivered, and names the run as finishing", () =>
	withGitHold(async (host, hold) => {
		await heldInFinalSnapshot(host, hold);
		assert.deepEqual(await host.tree(), { cancel: true });
		assert.deepEqual(host.notices, [[treeBlocked("run-1 (implement, finishing)"), "warning"]]);
		assert.deepEqual(host.branch, []);
		assert.deepEqual(host.sent, []);
		fs.rmSync(hold, { force: true });
		await until("the background report", () => host.sent.length > 0);
		assert.equal(host.branch.length, 1);
		assert.equal((host.branch[0] as any).data.run, "run-1");
		assert.equal(await host.tree(), undefined);
		assert.equal(host.notices.length, 1);
	}));

test("session_shutdown waits for a run that has ended but not yet recorded its entry, and sends no notice", () =>
	withGitHold(async (host, hold) => {
		await heldInFinalSnapshot(host, hold);
		let closed = false;
		const shutdown = Promise.resolve(host.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, host.ctx)).then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(closed, false, "shutdown waits while the run is still finishing");
		fs.rmSync(hold, { force: true });
		await shutdown;
		assert.equal(host.branch.length, 1, "the entry is recorded before the session closes");
		assert.equal((host.branch[0] as any).data.run, "run-1");
		assert.deepEqual(host.sent, [], "a closing session sends no notice");
	}));

test("parseFusion reads every /fusion form and answers anything else with the usage", () => {
	const usage = { kind: "usage", message: USAGE };
	for (const [args, expected] of [
		["dashboard", { kind: "dashboard" }],
		["  dashboard  ", { kind: "dashboard" }],
		["dashboard stop", { kind: "dashboard-stop" }],
		["status", { kind: "status" }],
		["status run-2", { kind: "status", handle: "run-2" }],
		["cancel run-1", { kind: "cancel", handle: "run-1" }],
		["wait run-10", { kind: "wait", handle: "run-10" }],
		["steer run-1 also update the README", { kind: "steer", handle: "run-1", text: "also update the README" }],
		["steer run-1   keep  going  ", { kind: "steer", handle: "run-1", text: "keep  going" }],
		["", usage],
		["   ", usage],
		["dashboard start", usage],
		["dashboard stop now", usage],
		["status foo", usage],
		["status run-0", usage],
		["status run-1 run-2", usage],
		["cancel", usage],
		["cancel run-1 now", usage],
		["wait", usage],
		["wait foo", usage],
		["steer", usage],
		["steer run-1", usage],
		["steer foo bar", usage],
		["answer", { kind: "answer" }],
		["answer run-1", { kind: "answer", handle: "run-1" }],
		["answer run-1 yes", { kind: "answer", handle: "run-1", text: "yes" }],
		["answer run-1   call it  foo  ", { kind: "answer", handle: "run-1", text: "call it  foo" }],
		["answer call it foo", { kind: "answer", text: "call it foo" }],
		["review", usage],
		["review run-2", { kind: "review", handle: "run-2" }],
		["review run-1 now", usage],
		["review foo", usage],
	] as const) {
		assert.deepEqual(parseFusion(args), expected, JSON.stringify(args));
	}
});

test("/fusion status lists this Pi session's runs and details the one it is given", async () => {
	const host = makeHost();
	await host.command("status");
	assert.deepEqual(host.notices, [["no claude runs in this Pi session yet\nsession usage: est. $0.0000 · in 0 out 0 tokens · workflow agents 0 tokens · 0 calls", "info"]]);
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	host.notices.length = 0;
	await host.command("status");
	assert.equal(host.notices.length, 1);
	assert.equal(host.notices[0]![1], "info");
	assert.match(host.notices[0]![0], /^run-1 · implement · opus · running · background · \d+s\nsession usage: /);
	await started(host, "run-1");
	host.notices.length = 0;
	await host.command("status run-1");
	const [details, type] = host.notices[0]!;
	assert.equal(type, "info");
	assert.match(details, /^run-1 · implement · opus · running · background · \d+s\nactivity: Read a\.ts\ntool calls: 1\n/);
	assert.match(details, /\nchanged files/);
	assert.match(details, /\nclaude --resume [0-9a-f-]{36}$/);
	await host.control({ action: "cancel", run: "run-1" });
});

test("/fusion names an unknown run and one that ran before this Pi process", async () => {
	const host = makeHost();
	await host.command("status run-9");
	assert.deepEqual(host.notices, [["unknown run run-9; runs in this Pi session: none", "warning"]]);
	await host.claude({ role: "implement", task: "do a thing" });
	host.branch.push({ type: "custom", customType: "pi-fusion", data: { run: "run-4", role: "plan", sessionId: "s-4", hostSessionId: "host-1" } });
	host.notices.length = 0;
	await host.command("cancel run-4");
	assert.deepEqual(host.notices, [["run-4 (plan) ran before this Pi process started and is not active; continue it with claude and continue run-4", "info"]]);
	host.notices.length = 0;
	await host.command("wait run-9");
	assert.deepEqual(host.notices, [["unknown run run-9; runs in this Pi session: run-1", "warning"]]);
});

test("/fusion cancel stops a background run and lets the host learn that the user stopped it", async () => {
	const host = makeHost();
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	await host.command("cancel run-1");
	assert.deepEqual(host.notices, [["run-1 cancelled", "info"]]);
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · cancelled · background · \d+s$/);
	assert.equal(host.sent.length, 1, "the host must hear that the run ended");
	const [message, options] = host.sent[0]!;
	assert.match(message.content, /^Background run run-1 \(implement\) cancelled\.\n\nimplement cancelled by the user\n\n\[run-1 · implement · /);
	assert.deepEqual(fixed(message.details), { handle: "run-1", role: "implement", model: "opus", state: "cancelled", background: true });
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	host.notices.length = 0;
	await host.command("cancel run-1");
	assert.deepEqual(host.notices, [["run-1 has already ended: cancelled", "info"]]);
});

test("/fusion cancel on a run that is still taking its first snapshot waits for the run to end", () =>
	withGitHold(async (host, hold) => {
		fs.writeFileSync(hold, "");
		const starting = withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
		let told = false;
		const cancelling = host.command("cancel run-1").then(() => {
			told = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(told, false, "the cancel waits while the run is still starting");
		assert.deepEqual(host.notices, [], "no notice claims the run is cancelled while it still runs");
		assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · running · background · \d+s$/);
		fs.rmSync(hold, { force: true });
		await cancelling;
		await starting;
		assert.deepEqual(host.notices, [["run-1 cancelled", "info"]]);
		assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · cancelled · background · \d+s$/);
	}));

test("/fusion cancel fails a foreground claude call with the user's cancel", async () => {
	const host = makeHost();
	const running = withScenario("hang", () => host.claude({ role: "implement", task: "long work" }));
	await started(host, "run-1");
	await host.command("cancel run-1");
	await assert.rejects(running, /^Error: implement cancelled by the user\n\n\[run-1 · implement · opus · /);
	assert.deepEqual(host.notices, [["run-1 cancelled", "info"]]);
	assert.deepEqual(host.sent, [], "a foreground run reports through its tool result");
	host.notices.length = 0;
	await host.claude({ role: "implement", task: "do a thing" });
	await host.command("cancel run-2");
	assert.deepEqual(host.notices, [["run-2 has already ended: done", "info"]]);
});

test("/fusion steer reaches the child and tells the host without starting a turn", async () => {
	const host = makeHost();
	await withScenario("steer", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	await host.command("steer run-1 also update the README");
	assert.deepEqual(host.notices, [["steer sent to run-1; the child reads it when it next takes input", "info"]]);
	assert.equal(host.sent.length, 1);
	const [message, options] = host.sent[0]!;
	assert.equal(message.customType, "pi-fusion-run");
	assert.equal(message.content, "The user steered run-1 (implement): also update the README");
	assert.equal(message.display, true);
	assert.deepEqual(message.details, { handle: "run-1", role: "implement", state: "running", kind: "steer", by: "user" });
	assert.deepEqual(options, { triggerTurn: false, deliverAs: "followUp" }, "the host reads the steer at its next turn");
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /^run-1 \(implement\) done\.\n\nsteered: also update the README\n\n/);
	assert.equal(host.sent.length, 1);
});

test("/fusion steer reaches the child even when the host refuses the message", async () => {
	const host = makeHost();
	await withScenario("steer", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	host.failSends();
	await host.command("steer run-1 also update the README");
	assert.deepEqual(host.notices, [["steer sent to run-1; the child reads it when it next takes input", "info"]]);
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /^run-1 \(implement\) done\.\n\nsteered: also update the README\n\n/);
});

test("/fusion steer is refused while the run waits for an answer, and after it has ended", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	await host.command("steer run-1 do something else");
	assert.deepEqual(host.notices, [["run-1 is waiting for an answer, not a steer; answer it with /fusion answer run-1 <text>", "warning"]]);
	assert.equal(host.sent.length, 1, "a refused steer tells the host nothing");
	await host.control({ action: "message", run: "run-1", message: "foo" });
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /\n\nanswered: foo; tools: ask_orchestrator\n\n/);
	assert.ok(!report.includes("do something else"), "the refused steer never reached the child");
	host.notices.length = 0;
	await host.command("steer run-1 one more thing");
	assert.deepEqual(host.notices, [["run-1 has ended: done; nothing was sent", "warning"]]);
});

const answered = (host: ReturnType<typeof makeHost>) => host.sent.filter(([message]) => message.details?.kind === "answer");

test("/fusion answer reaches the child, tells the host once, and turns the host's late answer away from the child", async () => {
	const host = makeHost();
	await withScenario("question-then-steer", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	await host.command("answer run-1 call it foo");
	assert.deepEqual(host.notices, [["answer sent to run-1; the child goes on", "info"]]);
	const late = await host.control({ action: "message", run: "run-1", message: "call it bar" });
	assert.equal(
		late.content[0]!.text,
		"The user already answered run-1's question with: call it foo. Your message was not sent; the child goes on with the user's answer. If it still applies, send it again with claude_control message and it goes to the child as a steer, or as the answer if it has asked another question by then.",
	);
	assert.deepEqual(fixed(late.details), { handle: "run-1", role: "implement", model: "opus", state: "running", background: true, sent: "none", answeredBy: "user" });
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /\n\nanswered: call it foo; steered: nothing\n\n/, "the refused message never reached the child");
	assert.equal(answered(host).length, 1, "the user's answer reaches the host exactly once");
	const [message, options] = answered(host)[0]!;
	assert.equal(message.customType, "pi-fusion-run");
	assert.equal(message.content, "The user answered run-1 (implement): call it foo\n\nQuestion: Which name?");
	assert.equal(message.display, true);
	assert.equal(message.details.by, "user");
	assert.equal(typeof message.details.questionId, "string");
	assert.deepEqual(options, { triggerTurn: false, deliverAs: "followUp" }, "the host reads the answer at its next turn");
});

test("once claude_control status has shown the user's answer, the host's next message is a steer again", async () => {
	const host = makeHost();
	await withScenario("question-then-steer", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	await host.command("answer run-1 call it foo");
	assert.match(await host.text(host.control({ action: "status", run: "run-1" })), /\nanswered by the user: call it foo$/);
	const steer = await host.control({ action: "message", run: "run-1", message: "also x" });
	assert.equal(steer.content[0]!.text, "steer sent to run-1; the child reads it when it next takes input");
	assert.equal(steer.details.sent, "steer");
	assert.match(await host.text(host.control({ action: "wait", run: "run-1" })), /\n\nanswered: call it foo; steered: also x\n\n/);
});

test("an answer typed while the host answers the same question is not sent", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it" }));
	const answering = host.command("answer run-1");
	await until("the editor", () => host.editors.length > 0);
	assert.equal(host.editors[0]!.title, "Answer run-1: Which name?");
	assert.equal(host.editors[0]!.prefill, undefined, "the editor opens empty");
	await host.control({ action: "message", run: "run-1", message: "bar" });
	host.closeEditor("foo");
	await answering;
	assert.deepEqual(host.notices, [["run-1's question was already answered by the host: bar; your answer was not sent", "warning"]]);
	assert.match(await host.text(host.control({ action: "wait", run: "run-1" })), /\n\nanswered: bar; /);
	assert.deepEqual(answered(host), [], "an answer that was not sent is not reported to the host");
});

test("an answer typed while the run is cancelled is not sent", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it" }));
	const answering = host.command("answer run-1");
	await until("the editor", () => host.editors.length > 0);
	const cancelling = host.control({ action: "cancel", run: "run-1" });
	host.closeEditor("foo");
	await answering;
	await cancelling;
	assert.deepEqual(host.notices, [["run-1 has ended: cancelled; your answer was not sent", "warning"]]);
	assert.deepEqual(answered(host), [], "a run that has ended hears no answer and the host is told of none");
});

test("an answer typed while the run ends is not sent, and the ended run stays ended", () =>
	withGitHold(async (host, hold) => {
		await withScenario("question-then-end", () => host.claude({ role: "implement", task: "name it", background: true }));
		fs.writeFileSync(hold, "");
		await until("the question notice", () => host.sent.length > 0);
		const answering = host.command("answer run-1");
		await until("the editor", () => host.editors.length > 0);
		await until("the run to end", async () => /^run-1 · implement · opus · done · /.test(await host.text(host.control({ action: "status" }))));
		host.closeEditor("foo");
		await answering;
		assert.deepEqual(host.notices, [["run-1 has ended: done; your answer was not sent", "warning"]]);
		assert.deepEqual(answered(host), [], "a run whose questions outlive its end hears no answer and the host is told of none");
		fs.rmSync(hold, { force: true });
		await until("the background report", () => host.sent.length > 1);
		assert.match(host.sent[1]![0].content, /^Background run run-1 \(implement\) done\.\n\nended while asking\n\n/, "the run reports what the child said");
		assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · done · background · \d+s$/, "no late answer puts the run back to running");
	}));

test("an answer that arrives while a cancel is in flight is refused, not thrown", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	const cancelling = host.control({ action: "cancel", run: "run-1" });
	await host.command("answer run-1 call it foo");
	await host.command("answer run-1");
	await cancelling;
	const refusal: [string, string] = ["run-1 is not waiting for an answer (state: cancelled)", "warning"];
	assert.deepEqual(host.notices, [refusal, refusal]);
	assert.deepEqual(host.editors, [], "no editor opens for a run whose question the abort took away");
	assert.deepEqual(answered(host), []);
});

test("a cancelled editor leaves the run waiting and tells the host nothing", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it" }));
	const answering = host.command("answer");
	await until("the editor", () => host.editors.length > 0);
	host.closeEditor(undefined);
	await answering;
	assert.deepEqual(host.notices, [["answer cancelled; run-1 still waits", "info"]]);
	assert.match(await host.text(host.control({ action: "status", run: "run-1" })), /^run-1 · implement · opus · waiting · /);
	assert.deepEqual(host.sent, []);
	await host.control({ action: "cancel", run: "run-1" });
});

test("without an editor the answer must come on the command line", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it" }));
	const hint = "run-1 needs the answer on the command line: /fusion answer run-1 <text>";
	host.ctx.hasUI = false;
	await host.command("answer run-1");
	assert.deepEqual(host.notices, [[hint, "warning"]]);
	host.notices.length = 0;
	host.ctx.hasUI = true;
	delete (host.ui as { editor?: unknown }).editor;
	await host.command("answer run-1");
	assert.deepEqual(host.notices, [[hint, "warning"]]);
	assert.deepEqual(host.editors, [], "no editor was opened");
	assert.deepEqual(host.sent, []);
	await host.control({ action: "cancel", run: "run-1" });
});

test("two open questions take the user's answer and then the host's, each exactly once", async () => {
	const host = makeHost();
	assert.equal(await withScenario("two-questions", () => host.text(host.claude({ role: "ask", task: "q" }))), asks("run-1", "ask", "First?"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	await host.command("answer one");
	assert.deepEqual(host.notices, [["answer sent to run-1; the child goes on\nIt has another question: Second?", "info"]]);
	const sent = await host.control({ action: "message", run: "run-1", message: "two" });
	assert.equal(sent.content[0]!.text, "answer sent to run-1; the child goes on");
	assert.equal(sent.details.answered, "Second?", "the details name the question, so the host sees when its answer met a newer one");
	assert.match(await host.text(host.control({ action: "wait", run: "run-1" })), /\n\nanswered: one \| two; /);
	assert.equal(answered(host).length, 1);
	assert.equal(answered(host)[0]![0].content, "The user answered run-1 (ask): one\n\nQuestion: First?");
});

test("the user's answer that uncovers a queued question tells the host about that question", async () => {
	const host = makeHost();
	await withScenario("two-questions", () => host.claude({ role: "ask", task: "q", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	await new Promise((resolve) => setTimeout(resolve, 300));
	await host.command("answer run-1 one");
	assert.equal(host.sent.length, 3);
	assert.equal(host.sent[0]![0].content, `Background run ${asks("run-1", "ask", "First?")}`);
	const [message, options] = host.sent[1]!;
	assert.equal(message.details.kind, "answer");
	assert.deepEqual(options, { triggerTurn: false, deliverAs: "followUp" });
	const [second, secondOptions] = host.sent[2]!;
	assert.ok(second.content.includes("Second?"), "the host hears the question the answer uncovered");
	assert.deepEqual(secondOptions, { triggerTurn: true, deliverAs: "followUp" }, "the notice starts a turn, unlike the answer message");
	assert.equal(await host.text(host.control({ action: "message", run: "run-1", message: "two" })), "answer sent to run-1; the child goes on");
	assert.match(await host.text(host.control({ action: "wait", run: "run-1" })), /\n\nanswered: one \| two; /);
});

test("an answer typed for the first question is never sent to the second", async () => {
	const host = makeHost();
	assert.equal(await withScenario("two-questions", () => host.text(host.claude({ role: "ask", task: "q" }))), asks("run-1", "ask", "First?"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	const answering = host.command("answer run-1");
	await until("the editor", () => host.editors.length > 0);
	assert.equal(host.editors[0]!.title, "Answer run-1: First?");
	assert.equal(await host.text(host.control({ action: "message", run: "run-1", message: "one" })), "answer sent to run-1; the child goes on\n\nIt has another question:\n\nSecond?");
	host.closeEditor("late");
	await answering;
	assert.deepEqual(host.notices, [["run-1's question was already answered by the host: one; your answer was not sent", "warning"]]);
	assert.equal(await host.text(host.control({ action: "message", run: "run-1", message: "two" })), "answer sent to run-1; the child goes on");
	assert.match(await host.text(host.control({ action: "wait", run: "run-1" })), /\n\nanswered: one \| two; /, "the typed answer reached neither question");
	assert.deepEqual(answered(host), [], "an answer that was not sent is not reported to the host");
});

test("a question the child asks after the user's answer clears that answer, so the host's next message answers the new question", async () => {
	const host = makeHost();
	await withScenario("question-then-question", () => host.claude({ role: "ask", task: "q", background: true }));
	try {
		await until("the question notice", () => host.sent.length > 0);
		await host.command("answer run-1 alpha");
		let status = "";
		await until("the second question", async () => {
			status = await host.text(host.control({ action: "status", run: "run-1" }));
			return status.includes("question: Second?");
		});
		assert.ok(!status.includes("answered by the user"), "the new question is not the one the user answered");
		assert.equal(await host.text(host.control({ action: "message", run: "run-1", message: "beta" })), "answer sent to run-1; the child goes on");
		assert.match(await host.text(host.control({ action: "wait", run: "run-1" })), /\n\nanswered: alpha >> beta\n\n/);
	} finally {
		await host.control({ action: "cancel", run: "run-1" }).catch(() => {});
	}
});

test("claude_control wait reports the user's answer, as claude_control status does", async () => {
	const host = makeHost();
	assert.equal(await withScenario("two-questions", () => host.text(host.claude({ role: "ask", task: "q" }))), asks("run-1", "ask", "First?"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	await host.command("answer run-1 one");
	assert.equal(
		await host.text(host.control({ action: "wait", run: "run-1" })),
		`${asks("run-1", "ask", "Second?")}\n\nanswered by the user: one`,
		"a wait that meets the next question still names what the user answered",
	);
	assert.equal(await host.text(host.control({ action: "message", run: "run-1", message: "two" })), "answer sent to run-1; the child goes on");
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /\n\nanswered: one \| two; /);
	assert.ok(!report.includes("answered by the user"), "the host answered the newer question itself, so no user answer is left to report");
});

test("a wait that carries the report names the user's answer under it", async () => {
	const host = makeHost();
	await withScenario("question-then-steer", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	await host.command("answer run-1 call it foo");
	const report = await host.text(host.control({ action: "wait", run: "run-1" }));
	assert.match(report, /^run-1 \(implement\) done\./);
	assert.ok(report.endsWith("\n\nanswered by the user: call it foo"), report);
	assert.equal(answered(host).length, 1, "the answer still reaches the host exactly once");
});

test("/fusion answer without a handle needs exactly one waiting run", async () => {
	const host = makeHost();
	await host.command("answer hello");
	assert.deepEqual(host.notices, [["no run is waiting for an answer", "info"]]);
	host.notices.length = 0;
	await withScenario("question", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	await withScenario("question", () => host.claude({ role: "ask", task: "q" }));
	await host.command("answer hello");
	assert.deepEqual(host.notices, [["several runs are waiting for an answer: run-1, run-2; name one with /fusion answer run-N [text]", "warning"]]);
	await host.control({ action: "cancel", run: "run-1" });
	await host.control({ action: "cancel", run: "run-2" });
});

test("/fusion answer on a run that is not waiting is refused", async () => {
	const host = makeHost();
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	await host.command("answer run-1 hello");
	assert.deepEqual(host.notices, [["run-1 is not waiting for an answer (state: running)", "warning"]]);
	assert.deepEqual(host.sent, []);
	await host.control({ action: "cancel", run: "run-1" });
});

test("/fusion wait shows the run's activity, ticks, and leaves the run running on Esc", async () => {
	const host = makeHost(repoRoot, "tui");
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	const waiting = host.command("wait run-1");
	await until("the wait component", () => host.waits.length > 0);
	const component = host.waits[0]!;
	const elapsed = (lines: string[]) => Number(/· (\d+)s ·/.exec(lines[0]!)![1]);
	const first = component.render(80);
	assert.match(first[0]!, /^run-1 implement · \d+s · /);
	assert.equal(first[1], "Esc leaves run-1 running");
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	const later = component.render(80);
	assert.ok(elapsed(later) > elapsed(first), `${JSON.stringify(later)} is no later than ${JSON.stringify(first)}`);
	assert.ok(host.renders.length >= 1, "the wait asks the TUI to render once a second");
	component.handleInput(ESC);
	await waiting;
	assert.deepEqual(host.notices, [["stopped waiting; run-1 goes on", "info"]]);
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · running · background · \d+s$/);
	assert.deepEqual(host.sent, []);
	await host.control({ action: "cancel", run: "run-1" });
});

test("/fusion wait reports the run's end and still lets the host hear it", async () => {
	const host = makeHost(repoRoot, "tui");
	await withScenario("slow", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	await host.command("wait run-1");
	assert.equal(host.waits.length, 1);
	assert.equal(host.notices.length, 1);
	const [report, type] = host.notices[0]!;
	assert.equal(type, "info");
	assert.match(report, /^run-1 \(implement\) done\.\n\ndone\n\n\[run-1 · implement · /);
	assert.equal(host.sent.length, 1, "a watcher never takes the report away from the host");
	assert.match(host.sent[0]![0].content, /^Background run run-1 \(implement\) done\./);
});

test("/fusion wait on a run that asks a question points at the answer", async () => {
	const host = makeHost(repoRoot, "tui");
	await withScenario("question", () => host.claude({ role: "implement", task: "name it", background: true }));
	await host.command("wait run-1");
	assert.deepEqual(host.notices, [["run-1 asks: Which name?. Answer it with /fusion answer run-1 <text>", "warning"]]);
	assert.equal(host.sent.length, 1, "the host hears the question too");
	await host.control({ action: "message", run: "run-1", message: "foo" });
	assert.match(await host.text(host.control({ action: "wait", run: "run-1" })), /\n\nanswered: foo; /);
});

test("/fusion wait outside the TUI awaits the report with no component", async () => {
	const host = makeHost(repoRoot, "print");
	await withScenario("slow", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	await host.command("wait run-1");
	assert.deepEqual(host.waits, [], "print mode shows no component");
	assert.equal(host.notices.length, 1);
	assert.match(host.notices[0]![0], /^run-1 \(implement\) done\.\n\ndone\n\n\[run-1 · implement · /);
	host.notices.length = 0;
	await host.command("wait run-1");
	assert.equal(host.notices.length, 1);
	assert.equal(host.notices[0]![1], "info");
	assert.match(host.notices[0]![0], /^run-1 \(implement\) done\./);
});

test("session_shutdown takes an open /fusion wait down", async () => {
	const host = makeHost(repoRoot, "tui");
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	const waiting = host.command("wait run-1");
	await until("the wait component", () => host.waits.length > 0);
	const shutdown = host.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, host.ctx);
	assert.deepEqual(host.finished, [false], "the wait came down before the shutdown awaited the run");
	await shutdown;
	await waiting;
	assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · cancelled · background · \d+s$/);
	assert.deepEqual(host.notices, [], "a dismissed wait reports nothing about the run the shutdown cancelled");
	assert.deepEqual(host.sent, []);
});

test("/fusion completes the first word, and then the runs each command can still name", async () => {
	const host = makeHost();
	assert.deepEqual(host.completions(""), [
		{ value: "dashboard", label: "dashboard" },
		{ value: "dashboard stop", label: "dashboard stop" },
		{ value: "status", label: "status" },
		{ value: "cancel", label: "cancel" },
		{ value: "steer", label: "steer" },
		{ value: "wait", label: "wait" },
		{ value: "answer", label: "answer" },
		{ value: "review", label: "review" },
	]);
	assert.equal(host.completions("status "), null, "nothing has run yet");
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	await withScenario("question", () => host.claude({ role: "ask", task: "q" }));
	await host.claude({ role: "ask", task: "where is x?" });
	const items = (kind: string, handles: string[]) => handles.map((handle) => ({ value: `${kind} ${handle}`, label: `${kind} ${handle}` }));
	assert.deepEqual(host.completions("status "), items("status", ["run-1", "run-2", "run-3"]));
	assert.deepEqual(host.completions("cancel "), items("cancel", ["run-1", "run-2"]), "cancel names the active runs");
	assert.deepEqual(host.completions("wait "), items("wait", ["run-1", "run-2"]));
	assert.deepEqual(host.completions("steer "), items("steer", ["run-1"]), "a waiting run takes an answer, not a steer");
	assert.deepEqual(host.completions("answer "), items("answer", ["run-2"]), "only a waiting run takes an answer");
	assert.deepEqual(host.completions("status run-1"), items("status", ["run-1"]));
	assert.equal(host.completions("steer run-2"), null);
	assert.equal(host.completions("cancel run-9"), null);
	assert.equal(host.completions("steer run-1 text"), null, "a steer with text is complete");
	await host.control({ action: "cancel", run: "run-1" });
	await host.control({ action: "cancel", run: "run-2" });
});

/** Runs the body with the budget variables set, as a Pi session that started with them in its environment does. */
async function withBudget<T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> {
	Object.assign(process.env, vars);
	try {
		return await body();
	} finally {
		for (const name of Object.keys(vars)) delete process.env[name];
	}
}

test("a budget variable that names no amount is reported once, and the control it names stays off", () =>
	withBudget({ PI_FUSION_BUDGET_LIMIT_USD: "1,000", PI_FUSION_BUDGET_WARN_USD: "5" }, async () => {
		const host = makeHost();
		await host.command("status");
		assert.deepEqual(host.notices, [
			["fusion: PI_FUSION_BUDGET_LIMIT_USD=1,000 is not a dollar amount; no limit is set", "warning"],
			["no claude runs in this Pi session yet\nsession usage: est. $0.0000 · in 0 out 0 tokens · workflow agents 0 tokens · 0 calls · warn at $5.00", "info"],
		]);
		host.notices.length = 0;
		await host.command("status");
		assert.equal(host.notices.length, 1, "the variable is reported once per Pi process, and the usage line stands alone after it");
		assert.match(await withScenario("ok", () => host.text(host.claude({ role: "implement", task: "do a thing" }))), /\[run-1 · implement · /, "no limit was set, so no call is refused");
	}));

const BLOCKED =
	"the claude runs of this Pi session have cost an estimated $0.2500, at or over the PI_FUSION_BUDGET_LIMIT_USD limit of $0.1000; no new run starts and no run is continued. Active runs are not cancelled; wait for them, message them or cancel them with claude_control. The estimate uses list prices and updates when a child turn ends, so it can lag; raise or unset the variable and restart Pi to start runs again";

const warning = (total: string, threshold: string) =>
	`fusion: the claude runs of this Pi session have cost an estimated ${total} so far, past the ${threshold} warning threshold (list prices; the estimate updates when a child turn ends, so it lags)`;

test("PI_FUSION_BUDGET_LIMIT_USD stops the next new, ask and continued call and leaves the run that spent it alone", () =>
	withBudget({ PI_FUSION_BUDGET_LIMIT_USD: "0.1" }, async () => {
		const host = makeHost();
		const first = await withScenario("ok", () => host.text(host.claude({ role: "implement", task: "do a thing" })));
		assert.match(first, /^## Changed\nfoo\.ts\n\n\[run-1 · implement · /, "the run that goes over the limit still returns its report");
		await assert.rejects(host.claude({ role: "implement", task: "more" }), { message: BLOCKED });
		await assert.rejects(host.claude({ role: "ask", task: "where is x?" }), { message: BLOCKED }, "an ask run costs money too");
		await assert.rejects(host.claude({ continue: "run-1", task: "again" }), { message: BLOCKED });
		const status = await host.control({ action: "status" });
		assert.match(status.content[0]!.text, /^run-1 · implement · opus · done · \d+s( · context <1%)?$/, "nothing was cancelled");
		assert.equal(status.details.usage.costUsd, 0.25);
		assert.equal(status.details.usage.calls, 1);
		assert.deepEqual(host.sent, []);
	}));

test("PI_FUSION_BUDGET_WARN_USD warns the user once for each threshold the session total passes", () =>
	withBudget({ PI_FUSION_BUDGET_WARN_USD: "0.1, 0.2" }, async () => {
		const host = makeHost();
		await withScenario("ok", () => host.claude({ role: "implement", task: "do a thing" }));
		assert.deepEqual(host.notices, [
			[warning("$0.2500", "$0.1000"), "warning"],
			[warning("$0.2500", "$0.2000"), "warning"],
		]);
		host.notices.length = 0;
		await withScenario("ok", () => host.claude({ role: "implement", task: "another thing" }));
		assert.deepEqual(host.notices, [], "a threshold warns once for the life of the Pi session");
		assert.equal((await host.control({ action: "status" })).details.usage.costUsd, 0.5);
	}));

test("a warning notice that throws leaves its threshold pending, so a later run warns about it again", () =>
	withBudget({ PI_FUSION_BUDGET_WARN_USD: "0.1, 0.2" }, async () => {
		const host = makeHost();
		const notify = host.ui.notify;
		let broken: string | undefined = "$0.1000";
		host.ui.notify = (text: string, type: string) => {
			if (broken !== undefined && text.includes(broken)) throw new Error("the TUI is gone");
			return notify(text, type);
		};
		await withScenario("ok", () => host.claude({ role: "implement", task: "do a thing" }));
		assert.deepEqual(host.notices, [], "a threshold whose notice threw reached nobody");
		broken = "$0.2000";
		await withScenario("ok", () => host.claude({ role: "implement", task: "another thing" }));
		assert.equal(host.notices.length, 1, "the threshold the first run could not warn about is still pending");
		assert.match(host.notices[0]![0], /past the \$0\.1000 warning threshold/);
		host.notices.length = 0;
		broken = undefined;
		await withScenario("ok", () => host.claude({ role: "implement", task: "a third thing" }));
		assert.equal(host.notices.length, 1, "only the threshold whose notice never returned comes back");
		assert.match(host.notices[0]![0], /past the \$0\.2000 warning threshold/);
	}));

test("the session usage shows in /fusion status and claude_control details with no budget variable set", async () => {
	const host = makeHost();
	await host.command("status");
	assert.deepEqual(host.notices, [["no claude runs in this Pi session yet\nsession usage: est. $0.0000 · in 0 out 0 tokens · workflow agents 0 tokens · 0 calls", "info"]]);
	await withScenario("ok", () => host.claude({ role: "implement", task: "do a thing" }));
	host.notices.length = 0;
	await host.command("status");
	const [line, type] = host.notices[0]!;
	assert.equal(type, "info");
	assert.match(line, /^run-1 · implement · opus · done · \d+s · context <1%\nsession usage: est\. \$0\.2500 · in \d+ out \d+ tokens · workflow agents 250 tokens · 1 calls$/);
	assert.ok(!line.includes("warn at") && !line.includes("· limit"), "with no threshold and no limit the line names neither");
	const status = await host.control({ action: "status" });
	assert.match(status.content[0]!.text, /^run-1 · implement · opus · done · \d+s( · context <1%)?$/, "the text the host reads is unchanged");
	assert.equal(status.details.usage.costUsd, 0.25);
	assert.equal(status.details.usage.workflowTokens, 250);
	assert.equal((await host.control({ action: "status", run: "run-1" })).details.usage.calls, 1);
});

test("/fusion status names the thresholds the budget variables set", () =>
	withBudget({ PI_FUSION_BUDGET_WARN_USD: "0.2,0.1", PI_FUSION_BUDGET_LIMIT_USD: "5" }, async () => {
		const host = makeHost();
		await host.command("status");
		assert.deepEqual(host.notices, [
			["no claude runs in this Pi session yet\nsession usage: est. $0.0000 · in 0 out 0 tokens · workflow agents 0 tokens · 0 calls · warn at $0.1000, $0.2000 · limit $5.00", "info"],
		]);
	}));

test("a continued run is a second call, so the session total adds its cost to the first", async () => {
	const host = makeHost();
	const first = await withScenario("ok", () => host.claude({ role: "implement", task: "do a thing" }));
	assert.deepEqual(first.details.sessionUsage, { costUsd: 0.25, tokensIn: first.details.tokensIn, tokensOut: first.details.tokensOut, workflowTokens: 250, calls: 1 });
	const second = await withScenario("ok", () => host.claude({ continue: "run-1", task: "more" }));
	assert.equal(second.details.sessionUsage.costUsd, 0.5, "the continued call's own total_cost_usd restarts, so it adds");
	assert.equal(second.details.sessionUsage.calls, 2);
	const third = await withScenario("ok", () => host.claude({ role: "implement", task: "a third thing", background: true }));
	assert.equal(third.details.sessionUsage.calls, 2, "a background run reports the totals as they stand when it starts");
	await until("the completion notice", () => host.sent.length > 0);
	const usage = (await host.control({ action: "status" })).details.usage;
	assert.equal(usage.costUsd, 0.75);
	assert.equal(usage.calls, 3);
});

/** Every widget line the host was given, oldest first, with the clears left out. */
const widgetLines = (host: ReturnType<typeof makeHost>): string[] => host.widgets.flatMap(([, lines]) => lines ?? []);

test("the widget names the active runs over the editor and goes when the last one ends", async () => {
	const host = makeHost();
	await withScenario("slow", () => host.claude({ role: "implement", task: "do a thing", background: true }));
	assert.ok(host.widgets.length, "nothing was set over the editor");
	assert.ok(host.widgets.every(([key]) => key === "fusion"), `another key reached the editor: ${JSON.stringify(host.widgets)}`);
	assert.match(host.widgets[0]![1]?.[0] ?? "", /^run-1 implement · \d+s · \d+ tool calls/);
	await until("the completion notice", () => host.sent.length > 0);
	assert.equal(host.widgets.at(-1)![1], undefined, `the widget stayed after the last run ended: ${JSON.stringify(host.widgets.at(-1))}`);
	assert.ok(!widgetLines(host).some((line) => line.startsWith("session usage:")), "with no budget threshold the widget names only the runs");
});

test("a waiting run's widget line carries its question and how to answer it", async () => {
	const host = makeHost();
	await withScenario("question", () => host.claude({ role: "implement", task: "name it", background: true }));
	await until("the question notice", () => host.sent.length > 0);
	await until("the waiting widget line", () => widgetLines(host).some((line) => line.includes("waiting:")));
	assert.equal(widgetLines(host).find((line) => line.includes("waiting:")), "run-1 implement · waiting: Which name? · answer: /fusion answer run-1 <text>");
	await host.control({ action: "message", run: "run-1", message: "call it foo" });
	await until("the completion notice", () => host.sent.length > 1);
});

test("the widget carries what the session has cost when a budget threshold is set", () =>
	withBudget({ PI_FUSION_BUDGET_WARN_USD: "0.1", PI_FUSION_BUDGET_LIMIT_USD: "5" }, async () => {
		const host = makeHost();
		await withScenario("slow", () => host.claude({ role: "implement", task: "do a thing", background: true }));
		await until("the usage line", () => widgetLines(host).some((line) => line.startsWith("session usage:")));
		assert.match(widgetLines(host).find((line) => line.startsWith("session usage:")) ?? "", /^session usage: est\. \$\d+\.\d{4} · warn at \$0\.1000 · limit \$5\.00$/);
		await until("the completion notice", () => host.sent.length > 0);
	}));

test("PI_FUSION_WIDGET=0 leaves the editor alone and changes nothing else", async () => {
	process.env.PI_FUSION_WIDGET = "0";
	try {
		const host = makeHost();
		const report = await withScenario("ok", () => host.text(host.claude({ role: "implement", task: "do a thing" })));
		assert.match(report, /^## Changed\nfoo\.ts\n\n\[run-1 · implement · /);
		assert.deepEqual(host.widgets, [], "nothing was set over the editor");
	} finally {
		delete process.env.PI_FUSION_WIDGET;
	}
});

test("session_shutdown takes the widget down with the session", async () => {
	const host = makeHost();
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	await until("the widget", () => host.widgets.length > 0);
	host.widgets.length = 0;
	await host.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, host.ctx);
	assert.ok(host.widgets.some(([key, lines]) => key === "fusion" && lines === undefined), `the widget stayed: ${JSON.stringify(host.widgets)}`);
});

/** A host in a scratch repository whose git logs every invocation, so a test can count the calls a run makes. */
async function withGitCount(body: (host: ReturnType<typeof makeHost>, calls: (command: string) => number) => Promise<void>): Promise<void> {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-sample-")));
	const bin = path.join(dir, ".bin");
	const log = path.join(dir, ".git-calls");
	const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const git = (...args: string[]) => execFileSync(realGit, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	fs.writeFileSync(path.join(dir, ".gitignore"), ".bin/\n.git-calls\n");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
	const pathBefore = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${pathBefore ?? ""}`;
	const calls = (command: string) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith(command)).length : 0);
	const host = makeHost(dir);
	try {
		await body(host, calls);
	} finally {
		if (pathBefore === undefined) delete process.env.PATH;
		else process.env.PATH = pathBefore;
		await host.control({ action: "cancel", run: "run-1" }).catch(() => {});
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("a running run's changed files are sampled once, however many times the status renders, and never for an ask run", () =>
	withGitCount(async (host, calls) => {
		await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
		await until("the first sample", () => calls("status") > 1);
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		assert.equal(calls("status"), 2, "one snapshot when the run starts and one sample, whatever the render ticks do");
		const sampled = calls("status");
		assert.match(await host.text(host.claude({ role: "ask", task: "where is x?" })), /^done\n\n\[run-2 · ask · /);
		assert.equal(calls("status"), sampled, "an ask run changes no files, so nothing samples it");
		assert.match(widgetLines(host).at(-1) ?? "", /^run-1 implement · \d+s · \d+ tool calls.* · 0 files$/);
	}));

test("every result about a run carries what became of it, how long it took, what it cost and what it changed", () =>
	withRepo(async (host) => {
		const done = await withScenario("ok", () => host.claude({ role: "implement", task: "do a thing" }));
		assert.equal(done.details.state, "done");
		assert.equal(done.details.costUsd, 0.25);
		assert.equal(done.details.filesChanged, 0, "the ok child changes no file");
		assert.equal(typeof done.details.elapsedMs, "number");
		const status = await host.control({ action: "status", run: "run-1" });
		assert.equal(status.details.state, "done");
		assert.equal(typeof status.details.elapsedMs, "number");
		const edited = await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		assert.equal(edited.details.filesChanged, 1);
		assert.deepEqual(edited.details.files, ["edited.txt"]);
		await withScenario("ok", () => host.claude({ role: "implement", task: "and again", background: true }));
		await until("the completion notice", () => host.sent.length > 0);
		assert.deepEqual(fixed(host.sent[0]![0].details), { handle: "run-3", role: "implement", model: "opus", state: "done", background: true, costUsd: 0.25 });
	}));

/** A host in a scratch git repository, so a child that edits a file leaves changed files a review can be given. */
async function withRepo(body: (host: ReturnType<typeof makeHost>, dir: string) => Promise<void>, session: { id?: string; file?: string } = {}): Promise<void> {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-review-")));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	fs.writeFileSync(path.join(dir, "base.txt"), "b\n");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	const host = makeHost(dir, "print", session);
	try {
		await body(host, dir);
	} finally {
		const status = await host.text(host.control({ action: "status" })).catch(() => "");
		for (const handle of status.match(/^run-\d+/gm) ?? []) await host.control({ action: "cancel", run: handle }).catch(() => {});
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Runs the body with PI_FUSION_AUTO_REVIEW set, as a Pi session that started with it in its environment does. */
async function withAutoReview<T>(body: () => Promise<T>): Promise<T> {
	process.env.PI_FUSION_AUTO_REVIEW = "1";
	try {
		return await body();
	} finally {
		delete process.env.PI_FUSION_AUTO_REVIEW;
	}
}

function argvValue(argv: string[], flag: string): string | undefined {
	const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
	if (inline) return inline.slice(flag.length + 1);
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

const reviewLink = "run-2 reviews this run in the background; its report arrives as a message.";

test("/fusion review starts an ask review child on the run's tree, tells the host once, and reports when it ends", () =>
	withRepo(async (host) => {
		await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		const out = path.join(os.tmpdir(), `pi-fusion-review-argv-${process.pid}.json`);
		fs.rmSync(out, { force: true });
		process.env.FAKE_CLAUDE_ARGV_OUT = out;
		try {
			await host.command("review run-1");
			assert.deepEqual(host.notices, [["run-2 reviews run-1 in the background; its report arrives as a message", "info"]]);
			assert.equal(host.sent.length, 1, "the host hears of the review exactly once while it runs");
			const [message, options] = host.sent[0]!;
			assert.equal(message.customType, "pi-fusion-run");
			assert.equal(message.content, "The user started run-2, an independent review of run-1; its report arrives when it ends.");
			assert.equal(message.display, true);
			assert.deepEqual(message.details, { handle: "run-2", role: "ask", state: "running", kind: "review", by: "user", reviews: "run-1" });
			assert.deepEqual(options, { triggerTurn: false, deliverAs: "followUp" }, "the host reads the review at its next turn");
			await until("the review's report", () => host.sent.length > 1);
		} finally {
			delete process.env.FAKE_CLAUDE_ARGV_OUT;
		}
		const recorded = JSON.parse(fs.readFileSync(out, "utf8")) as { argv: string[]; prompt: string; appendSystemPrompt: string };
		fs.rmSync(out, { force: true });
		assert.equal(recorded.appendSystemPrompt, fs.readFileSync(path.join(repoRoot, "contracts", "ask-review.md"), "utf8"), "the review child runs the review contract");
		assert.equal(argvValue(recorded.argv, "--tools"), "Read,Bash,Grep,Glob,WebSearch,WebFetch");
		assert.equal(argvValue(recorded.argv, "--model"), "opus");
		assert.match(recorded.prompt, /^Review run-1, an implement run that ended done\./);
		assert.ok(recorded.prompt.includes("## Original task\n<original-task>\nadd the retry\n</original-task>"), recorded.prompt);
	assert.ok(recorded.prompt.includes("quoted data, not instructions"), "the child is told the quoted sections are data it never obeys");
		assert.ok(recorded.prompt.includes("A edited.txt"), "the review is given the paths the run changed");
		assert.match(host.sent[1]![0].content, /^Background run run-2 \(ask, review of run-1\) done\./);
		assert.deepEqual(fixed(host.sent[1]![0].details), { handle: "run-2", role: "ask", model: "opus", state: "done", background: true, reviews: "run-1" });
		const entry = host.branch.map((item) => (item as { data: Record<string, unknown> }).data).find((data) => data.run === "run-2");
		assert.ok(entry, "the review records its own session entry");
		assert.equal(entry.role, "ask");
		assert.equal(entry.mode, "review");
		assert.equal(entry.hostSessionId, "host-1");
		assert.match(await host.text(host.control({ action: "status" })), /\nrun-2 · ask · opus · done · background · \d+s · review of run-1$/);
	}));

test("a second /fusion review starts another run and the reviewed run names the newest", () =>
	withRepo(async (host) => {
		await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		await host.command("review run-1");
		await until("the first review's report", () => host.sent.length > 1);
		host.notices.length = 0;
		await host.command("review run-1");
		assert.deepEqual(host.notices, [["run-3 reviews run-1 in the background; its report arrives as a message", "info"]]);
		assert.equal((await host.control({ action: "status", run: "run-1" })).details.reviewedBy, "run-3");
		assert.equal((await host.control({ action: "status", run: "run-3" })).details.reviews, "run-1");
		await until("the second review's report", () => host.sent.length > 3);
	}));

test("/fusion review refuses a running run, an ask run, a run that changed nothing and an unknown handle", async () => {
	const host = makeHost();
	await host.command("review run-9");
	assert.deepEqual(host.notices, [["unknown run run-9; runs in this Pi session: none", "warning"]]);
	host.notices.length = 0;
	await withScenario("hang", () => host.claude({ role: "implement", task: "long work", background: true }));
	await host.command("review run-1");
	assert.deepEqual(host.notices, [["run-1 is still active; review it when it has ended", "warning"]]);
	await host.control({ action: "cancel", run: "run-1" });
	host.notices.length = 0;
	await host.command("review run-1");
	assert.deepEqual(host.notices, [["run-1 ended cancelled without a report to review", "warning"]]);
	host.notices.length = 0;
	await host.claude({ role: "ask", task: "where is x?" });
	await host.command("review run-2");
	assert.deepEqual(host.notices, [["run-2 is an ask run; only implement and ultracode runs are reviewed", "warning"]]);
	host.notices.length = 0;
	await host.claude({ role: "implement", task: "read something" });
	await host.command("review run-3");
	assert.deepEqual(host.notices, [["run-3 changed no files", "warning"]]);
	assert.deepEqual(host.sent.filter(([message]) => message.details?.kind === "review"), [], "a refused review tells the host nothing");
	assert.ok(!(await host.text(host.control({ action: "status" }))).includes("run-4"), "no refusal started a run");
});

test("the budget block refuses a review and leaves the run that spent it alone", () =>
	withBudget({ PI_FUSION_BUDGET_LIMIT_USD: "0.1" }, () =>
		withRepo(async (host) => {
			await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
			await host.command("review run-1");
			assert.deepEqual(host.notices, [[BLOCKED, "warning"]]);
			assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · done · \d+s( · context <1%)?$/, "no run-2 exists and nothing was cancelled");
			assert.deepEqual(host.sent, []);
		}),
	));

test("PI_FUSION_AUTO_REVIEW reviews an implement run that changed files and points its tool result at the review", () =>
	withAutoReview(() =>
		withRepo(async (host) => {
			const done = await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
			assert.ok(done.content[0]!.text.endsWith(`\n\n${reviewLink}`), done.content[0]!.text);
			assert.equal(done.details.reviewedBy, "run-2");
			await until("the review's report", () => host.sent.length > 0);
			assert.match(host.sent[0]![0].content, /^Background run run-2 \(ask, review of run-1\) done\./);
			assert.equal(host.sent.length, 1, "an automatic review tells the host only when it ends");
			const status = await host.text(host.control({ action: "status" }));
			assert.match(status, /\nrun-2 · ask · opus · done · background · \d+s · review of run-1$/);
			assert.ok(!status.includes("run-3"), "a review never starts a review");
			assert.deepEqual(host.notices, []);
		}),
	));

test("the end notice of a background run carries the link to its automatic review", () =>
	withAutoReview(() =>
		withRepo(async (host) => {
			await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry", background: true }));
			await until("both reports", () => host.sent.length > 1);
			assert.match(host.sent[0]![0].content, /^Background run run-1 \(implement\) done\./);
			assert.ok(host.sent[0]![0].content.endsWith(reviewLink), host.sent[0]![0].content);
			assert.match(host.sent[1]![0].content, /^Background run run-2 \(ask, review of run-1\) done\./);
		}),
	));

test("without PI_FUSION_AUTO_REVIEW a run that changed files starts no review", () =>
	withRepo(async (host) => {
		const done = await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		assert.ok(!done.content[0]!.text.includes("reviews this run"), done.content[0]!.text);
		assert.equal(done.details.reviewedBy, undefined);
		assert.match(await host.text(host.control({ action: "status" })), /^run-1 · implement · opus · done · \d+s( · context <1%)?$/);
		assert.deepEqual(host.sent, []);
	}));

test("a failed run and an ask run never start an automatic review", () =>
	withAutoReview(() =>
		withRepo(async (host) => {
			await assert.rejects(withScenario("error", () => host.claude({ role: "implement", task: "break it" })), /^Error: implement model error: boom/);
			await host.claude({ role: "ask", task: "where is x?" });
			const status = await host.text(host.control({ action: "status" }));
			assert.match(status, /^run-1 · implement · opus · failed · \d+s\nrun-2 · ask · opus · done · \d+s$/);
			assert.deepEqual(host.sent, []);
		}),
	));

test("a review that lands while the run is still finishing waits for its file list instead of refusing", () =>
	withRepo(async (host) => {
		await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry", background: true }));
		await finishing(host, "run-1");
		await host.command("review run-1");
		assert.deepEqual(host.notices, [["run-2 reviews run-1 in the background; its report arrives as a message", "info"]]);
		await until("the review's report", () => host.sent.length > 2);
		assert.match(host.sent.at(-1)![0].content, /^Background run run-2 \(ask, review of run-1\) done\./);
	}));

test("/fusion review completes only the runs that can be reviewed", () =>
	withRepo(async (host) => {
		assert.equal(host.completions("review "), null, "nothing has run yet");
		await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		await host.claude({ role: "ask", task: "where is x?" });
		assert.deepEqual(host.completions("review "), [{ value: "review run-1", label: "review run-1" }]);
		assert.deepEqual(host.completions("review run-1"), [{ value: "review run-1", label: "review run-1" }]);
		assert.equal(host.completions("review run-2"), null, "an ask run takes no review");
	}));

test("continuing a review run keeps it naming the run it reviews", () =>
	withRepo(async (host) => {
		await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		await host.command("review run-1");
		await until("the review's report", () => host.sent.length > 1);
		await host.claude({ continue: "run-2", task: "and the error paths?" });
		const status = await host.control({ action: "status", run: "run-2" });
		assert.match(status.content[0]!.text, /^run-2 · ask · opus · done · \d+s · review of run-1\ntool calls: /);
		assert.equal(status.details.reviews, "run-1");
	}));

test("a question from a review child names the run it reviews", () =>
	withRepo(async (host) => {
		await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		await withScenario("question", async () => {
			await host.command("review run-1");
			await until("the review's question", () => host.sent.length > 1);
		});
		assert.equal(host.sent[1]![0].content, `Background run ${asks("run-2", "ask, review of run-1", "Which name?")}`);
	}));

test("a status render that throws fails neither the run it renders nor a review of another run", () =>
	withRepo(async (host) => {
		await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		host.ui.setStatus = (_key: string, text: string | undefined) => {
			if (text?.includes("ask")) throw new Error("the TUI is gone");
		};
		assert.match(await host.text(host.claude({ role: "ask", task: "where is x?" })), /^done\n\n\[run-2 · ask · opus · /, "the claude tool still returns the report");
		await host.command("review run-1");
		assert.deepEqual(host.notices, [["run-3 reviews run-1 in the background; its report arrives as a message", "info"]]);
		await until("the review's report", () => host.sent.length > 1);
		assert.match(host.sent[1]![0].content, /^Background run run-3 \(ask, review of run-1\) done\./);
	}));

test("a review whose run cannot start is refused and leaves no run behind", () =>
	withRepo(async (host) => {
		await withScenario("edit", () => host.claude({ role: "implement", task: "add the retry" }));
		Object.defineProperty(host.ctx, "cwd", {
			get() {
				throw new Error("the work tree is gone");
			},
		});
		await host.command("review run-1");
		assert.deepEqual(host.notices, [
			["run-2 could not start", "warning"],
			["fusion: run-2 did not start: the work tree is gone", "warning"],
		]);
		const status = await host.text(host.control({ action: "status" }));
		assert.ok(!status.includes("run-2"), status);
		assert.equal((await host.control({ action: "status", run: "run-1" })).details.reviewedBy, undefined, "the run it would have reviewed names no review");
		assert.deepEqual(host.sent, [], "a review that never started tells the host nothing");
	}));

/** Runs the body with the on-disk run history on and a directory of its own, which only the history creates. */
async function withHistory<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-history-"));
	const dir = path.join(root, "history");
	process.env.PI_FUSION_HISTORY = "1";
	process.env.PI_FUSION_HISTORY_DIR = dir;
	try {
		return await body(dir);
	} finally {
		delete process.env.PI_FUSION_HISTORY;
		delete process.env.PI_FUSION_HISTORY_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** A host of a durable Pi session, which is what the run history needs to keep anything at all. */
const durable = (id: string, cwd = repoRoot) => makeHost(cwd, "print", { id, file: path.join(os.tmpdir(), `${id}.jsonl`) });

const heldFile = (dir: string, id: string) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")) as { version: number; records: any[] };

/** The url the /fusion dashboard notice carries, which is the page's only credential. */
const dashboardUrl = (host: ReturnType<typeof makeHost>): string => {
	const notice = host.notices.map(([text]) => /^fusion dashboard: (\S+)$/.exec(text)?.[1]).find(Boolean);
	assert.ok(notice, "the dashboard did not report its url");
	return notice;
};

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

test("a later Pi process on the same host session shows the earlier runs, their reports and what they spent", () =>
	withHistory(async (dir) => {
		const first = durable("host-1");
		await withScenario("ok", () => first.claude({ role: "ultracode", task: "do a thing" }));
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "the history directory is the user's own");
		assert.equal(fs.statSync(path.join(dir, "host-1.json")).mode & 0o777, 0o600, "so is the session file");
		const written = heldFile(dir, "host-1");
		assert.equal(written.records.length, 1, "the start and the end of one run are one record");
		assert.equal(written.records[0].state, "done");
		assert.equal(written.records[0].report, "## Changed\nfoo.ts");
		assert.equal(written.records[0].usage.costUsd, 0.25);

		const second = durable("host-1");
		second.branch.push(...first.branch);
		await second.command("status");
		assert.match(
			second.notices[0]![0],
			/^no claude runs in this Pi session yet\nrun-1 · ultracode · fable · done · earlier Pi process\nsession usage: est\. \$0\.2500 · in \d+ out \d+ tokens · workflow agents 250 tokens · 1 calls$/,
		);
		assert.deepEqual(second.completions("status "), [{ value: "status run-1", label: "status run-1" }], "the earlier run is offered for status, which acts on it");
		second.notices.length = 0;
		await second.command("status run-1");
		assert.deepEqual(second.notices, [
			["run-1 (ultracode) ran in an earlier Pi process: done, 0s, 0 changed files\n## Changed\nfoo.ts\ncontinue it with claude and continue run-1", "info"],
		]);
		const status = await second.control({ action: "status", run: "run-1" });
		assert.equal(status.content[0]!.text, second.notices[0]![0]);
		assert.deepEqual(status.details, { handle: "run-1", state: "done", historical: true });

		second.notices.length = 0;
		await second.command("dashboard");
		try {
			const url = dashboardUrl(second);
			const runs = (await payload(`${url}api/runs`)).runs as any[];
			const restored = runs.find((run) => run.handle === "run-1");
			assert.ok(restored, "the dashboard lists the earlier run");
			assert.equal(restored.restored, true);
			assert.equal((await payload(`${url}api/runs/${restored.id}`)).text, "## Changed\nfoo.ts");
		} finally {
			await second.command("dashboard stop");
		}

		second.notices.length = 0;
		assert.match(await withScenario("ok", () => second.text(second.claude({ role: "ultracode", task: "another thing" }))), /\[run-2 · ultracode · fable · /);
		await second.command("status");
		assert.match(second.notices[0]![0], /^run-2 · ultracode · fable · done · \d+s · context <1%\nrun-1 · ultracode · fable · done · earlier Pi process\nsession usage: est\. \$0\.5000 · .* · 2 calls$/);
		assert.deepEqual(
			second.completions("status "),
			[
				{ value: "status run-2", label: "status run-2" },
				{ value: "status run-1", label: "status run-1" },
			],
			"this process's runs come first, then the ones an earlier process left",
		);
		assert.deepEqual(
			heldFile(dir, "host-1").records.map((held) => [held.handle, held.state]),
			[
				["run-1", "done"],
				["run-2", "done"],
			],
		);
	}));

test("one host session never reads another one's runs", () =>
	withHistory(async (dir) => {
		const first = durable("host-1");
		await withScenario("ok", () => first.claude({ role: "implement", task: "do a thing" }));
		const other = durable("host-9");
		other.branch.push(...first.branch);
		await other.command("status");
		assert.deepEqual(other.notices, [["no claude runs in this Pi session yet\nsession usage: est. $0.0000 · in 0 out 0 tokens · workflow agents 0 tokens · 0 calls", "info"]]);
		assert.equal(fs.existsSync(path.join(dir, "host-9.json")), false, "a session with nothing to keep writes nothing");
	}));

test("nothing reaches the disk with the history off or with a session Pi keeps no file for", async () => {
	await withHistory(async (dir) => {
		const host = makeHost();
		await withScenario("ok", () => host.claude({ role: "implement", task: "do a thing" }));
		await host.command("status");
		assert.equal(fs.existsSync(dir), false, "an in-memory session keeps no history");
	});
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-history-"));
	const dir = path.join(root, "history");
	process.env.PI_FUSION_HISTORY_DIR = dir;
	try {
		const host = durable("host-1");
		await withScenario("ok", () => host.claude({ role: "implement", task: "do a thing" }));
		await host.command("status");
		assert.equal(fs.existsSync(dir), false, "the history stays off until PI_FUSION_HISTORY says 1");
	} finally {
		delete process.env.PI_FUSION_HISTORY_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a run whose Pi process ended while it was going comes back as aborted, in the file too", () =>
	withHistory(async (dir) => {
		const first = durable("host-1");
		try {
			await withScenario("hang", () => first.claude({ role: "implement", task: "long work", background: true }));
			await started(first, "run-1");
			assert.equal(heldFile(dir, "host-1").records[0].state, "running");
			// The run never ended, so its Pi process recorded no branch entry for it: the history is all that names it.
			assert.deepEqual(first.branch, []);
			const second = durable("host-1");
			const held = "run-1 (implement) ran in an earlier Pi process: aborted, 0s, 0 changed files\naborted when the earlier Pi process ended";
			await second.command("status run-1");
			assert.deepEqual(second.notices, [[held, "info"]], "a run with no child session to resume is offered no continue");
			assert.equal(heldFile(dir, "host-1").records[0].state, "aborted");
			const status = await second.control({ action: "status", run: "run-1" });
			assert.equal(status.content[0]!.text, held);
			assert.deepEqual(status.details, { handle: "run-1", state: "aborted", historical: true });
			const sent = await second.control({ action: "message", run: "run-1", message: "go on" });
			assert.equal(
				sent.content[0]!.text,
				"run-1 (implement) ran in an earlier Pi process and is not active. The message was not sent. Read it with claude_control status and run run-1, or take no action.",
			);
			assert.deepEqual(sent.details, { handle: "run-1", state: "aborted", historical: true });
			second.notices.length = 0;
			await second.command("status");
			assert.match(second.notices[0]![0], /^no claude runs in this Pi session yet\nrun-1 · implement · opus · aborted · earlier Pi process\n/);
			assert.match(await withScenario("ok", () => second.text(second.claude({ role: "implement", task: "another thing" }))), /\[run-2 · implement · /, "the interrupted run keeps its name");
			assert.deepEqual(
				heldFile(dir, "host-1").records.map((record) => [record.handle, record.state]),
				[
					["run-1", "aborted"],
					["run-2", "done"],
				],
			);
		} finally {
			await first.control({ action: "cancel", run: "run-1" });
		}
	}));

test("what a run has spent reaches its file while it is still going, so an interrupted run's cost is not lost", () =>
	withHistory(async (dir) => {
		const first = durable("host-1");
		try {
			await withScenario("result-then-hang-exit0", () => first.claude({ role: "implement", task: "long work", background: true }));
			await until("the run's first turn in the file", () => (heldFile(dir, "host-1").records[0]?.usage?.tokensIn ?? 0) > 0);
			const held = heldFile(dir, "host-1").records[0];
			assert.equal(held.state, "running", "the run is still going and its spend is already kept");
			assert.equal(held.usage.tokensIn, 13);
			assert.equal(held.usage.tokensOut, 5);
			const second = durable("host-1");
			await second.command("status");
			assert.match(second.notices[0]![0], /\nsession usage: est\. \$0\.0000 · in 13 out 5 tokens · workflow agents 0 tokens · 1 calls$/, "the later Pi process starts from what the run spent");
		} finally {
			await first.control({ action: "cancel", run: "run-1" });
		}
	}));

test("a run started before the host session id changed still ends in the file it started in", () =>
	withHistory(async (dir) => {
		const session = { id: "host-1", file: path.join(os.tmpdir(), "host-1.jsonl") };
		const host = makeHost(repoRoot, "print", session);
		await withScenario("slow", () => host.claude({ role: "implement", task: "do a thing", background: true }));
		await started(host, "run-1");
		// Pi forked the host session while the run was going, so the id it reports is no longer the run's.
		session.id = "host-2";
		await until("the run's report", () => host.sent.length > 0);
		assert.deepEqual(
			heldFile(dir, "host-1").records.map((record) => [record.handle, record.state, record.report]),
			[["run-1", "done", "done"]],
			"the end of the run lands where its start did",
		);
		assert.equal(fs.existsSync(path.join(dir, "host-2.json")), false, "and nowhere else");
	}));

test("a run of an earlier Pi process can still be reviewed, and the review is kept with it", () =>
	withHistory((dir) =>
		withRepo(
			async (first, cwd) => {
				await withScenario("edit", () => first.claude({ role: "implement", task: "add the retry" }));
				const second = durable("host-1", cwd);
				second.branch.push(...first.branch);
				// A completion is given no ctx, so it lists the earlier runs only once a call has loaded them.
				await second.command("status");
				second.notices.length = 0;
				assert.deepEqual(second.completions("review "), [{ value: "review run-1", label: "review run-1" }], "the earlier run is offered for review");
				const out = path.join(os.tmpdir(), `pi-fusion-history-argv-${process.pid}.json`);
				fs.rmSync(out, { force: true });
				process.env.FAKE_CLAUDE_ARGV_OUT = out;
				try {
					await second.command("review run-1");
					assert.deepEqual(second.notices, [["run-2 reviews run-1 in the background; its report arrives as a message", "info"]]);
					await until("the review's report", () => second.sent.length > 1);
				} finally {
					delete process.env.FAKE_CLAUDE_ARGV_OUT;
				}
				const recorded = JSON.parse(fs.readFileSync(out, "utf8")) as { prompt: string };
				fs.rmSync(out, { force: true });
				assert.match(recorded.prompt, /^Review run-1, an implement run that ended done\./);
				assert.ok(recorded.prompt.includes("A edited.txt"), recorded.prompt);
				const held = new Map(heldFile(dir, "host-1").records.map((record) => [record.handle, record]));
				assert.equal(held.get("run-1").reviewedBy, "run-2");
				assert.equal(held.get("run-2").state, "done");
				assert.equal(held.get("run-2").reviews, "run-1");
			},
			{ id: "host-1", file: path.join(os.tmpdir(), "host-1.jsonl") },
		),
	));

test("a run of an earlier Pi process is reviewed in the working directory it was made in and nowhere else", () =>
	withHistory((dir) =>
		withRepo(
			async (first, cwd) => {
				await withScenario("edit", () => first.claude({ role: "implement", task: "add the retry" }));
				const file = path.join(dir, "host-1.json");
				const kept = JSON.parse(fs.readFileSync(file, "utf8")) as { records: any[] };
				fs.writeFileSync(file, JSON.stringify({ ...kept, records: [{ ...kept.records[0], cwd: "/gone" }] }));
				const second = durable("host-1", cwd);
				second.branch.push(...first.branch);
				await second.command("status run-1");
				assert.ok(!second.notices[0]![0].includes("review it with"), "a run made in another directory is offered for review nowhere here");
				assert.equal(second.completions("review "), null, "and it is completed for review nowhere either");
				second.notices.length = 0;
				await second.command("review run-1");
				assert.deepEqual(second.notices, [["run-1 was made in /gone, not in this working directory; review it from there", "warning"]]);
				assert.deepEqual(second.sent, [], "the review starts nowhere and the host hears nothing of it");
				fs.writeFileSync(file, JSON.stringify(kept));
				const third = durable("host-1", cwd);
				third.branch.push(...first.branch);
				await third.command("review run-1");
				assert.deepEqual(third.notices, [["run-2 reviews run-1 in the background; its report arrives as a message", "info"]], "the same run reviews here once its record names this directory");
				assert.ok(third.notices.every(([text]) => !text.includes("review it with")), "the line the status shows is the one /fusion review acts on");
				await until("the review's report", () => third.sent.length > 1);
			},
			{ id: "host-1", file: path.join(os.tmpdir(), "host-1.jsonl") },
		),
	));

test("a run of an ancestor host session is read from that session's file and never written back to it", () =>
	withHistory(async (dir) => {
		const ancestor = durable("host-1");
		await withScenario("ok", () => ancestor.claude({ role: "implement", task: "do a thing" }));
		const kept = fs.readFileSync(path.join(dir, "host-1.json"), "utf8");
		const forked = durable("host-2");
		forked.branch.push(...ancestor.branch);
		await forked.command("status run-1");
		assert.deepEqual(forked.notices, [
			["run-1 (implement) ran in an earlier Pi process: done, 0s, 0 changed files\n## Changed\nfoo.ts\ncontinue it with claude and continue run-1", "info"],
		]);
		assert.equal(fs.readFileSync(path.join(dir, "host-1.json"), "utf8"), kept, "the ancestor's file is byte for byte what it was");
		assert.equal(fs.existsSync(path.join(dir, "host-2.json")), false, "reading an ancestor's runs writes nothing of them here");

		const left = { id: "id-2", handle: "run-2", role: "implement", model: "opus", hostSessionId: "host-1", cwd: "/work", origin: "tool", state: "running", startedAt: 1_000, prompt: "long work" };
		const going = JSON.stringify({ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records: [left] });
		fs.writeFileSync(path.join(dir, "host-1.json"), going);
		forked.branch.push({ type: "custom", customType: "pi-fusion", data: { run: "run-2", role: "implement", hostSessionId: "host-1" } });
		forked.notices.length = 0;
		await forked.command("status run-2");
		assert.match(forked.notices[0]![0], /^run-2 \(implement\) ran in an earlier Pi process: aborted, /, "a run the ancestor left going ended with the process that left it");
		assert.equal(fs.readFileSync(path.join(dir, "host-1.json"), "utf8"), going, "and the correction is that session's to write, never this one's");
	}));

test("a review of an ancestor host session's run is kept here and never written into that session's file", () =>
	withHistory((dir) =>
		withRepo(
			async (ancestor, cwd) => {
				await withScenario("edit", () => ancestor.claude({ role: "implement", task: "add the retry" }));
				const kept = fs.readFileSync(path.join(dir, "host-1.json"), "utf8");
				const forked = durable("host-2", cwd);
				forked.branch.push(...ancestor.branch);
				await forked.command("review run-1");
				assert.deepEqual(forked.notices, [["run-2 reviews run-1 in the background; its report arrives as a message", "info"]]);
				await until("the review's report", () => forked.sent.length > 1);
				assert.equal(fs.readFileSync(path.join(dir, "host-1.json"), "utf8"), kept, "the ancestor's file names no review of its run");
				assert.deepEqual(
					heldFile(dir, "host-2").records.map((record) => [record.handle, record.state, record.reviews]),
					[["run-2", "done", "run-1"]],
					"this session's file keeps the review it ran and nothing of the run it read",
				);
			},
			{ id: "host-1", file: path.join(os.tmpdir(), "host-1.jsonl") },
		),
	));

test("a record that names another host session is corrected in the file it was read from and opens no file of its own", () =>
	withHistory(async (dir) => {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const held = { id: "id-9", handle: "run-1", role: "implement", model: "opus", hostSessionId: "host-9", cwd: "/work", origin: "tool", state: "running", startedAt: 1_000, prompt: "long work" };
		fs.writeFileSync(path.join(dir, "host-1.json"), JSON.stringify({ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records: [held] }));
		const host = durable("host-1");
		host.branch.push({ type: "custom", customType: "pi-fusion", data: { run: "run-1", role: "implement", hostSessionId: "host-1" } });
		await host.command("status run-1");
		assert.match(host.notices[0]![0], /^run-1 \(implement\) ran in an earlier Pi process: aborted, /);
		assert.equal(heldFile(dir, "host-1").records[0].state, "aborted", "the correction lands in the file the record came from");
		assert.deepEqual(fs.readdirSync(dir), ["host-1.json"], "and never in a file of the session the record names");
	}));

test("a history file this Pi process cannot read is one warning, and the next run replaces it", () =>
	withHistory(async (dir) => {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(dir, "host-1.json"), "{");
		const host = durable("host-1");
		await host.command("status");
		const warnings = host.notices.filter(([, type]) => type === "warning");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]![0], /^fusion history: history file .*host-1\.json is unreadable and will be replaced$/);
		host.notices.length = 0;
		assert.match(await withScenario("ok", () => host.text(host.claude({ role: "implement", task: "do a thing" }))), /^## Changed\nfoo\.ts\n\n\[run-1 · implement · /);
		assert.deepEqual(host.notices, [], "the history is warned about once for the life of the Pi process");
		const written = heldFile(dir, "host-1");
		assert.equal(written.records.length, 1);
		assert.equal(written.records[0].state, "done");
	}));

test("a history file from a newer pi-fusion is left byte for byte as it was", () =>
	withHistory(async (dir) => {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, "host-1.json");
		const text = JSON.stringify({ version: 99, hostSessionId: "host-1", cwd: "/work", records: [] });
		fs.writeFileSync(file, text);
		const host = durable("host-1");
		assert.match(await withScenario("ok", () => host.text(host.claude({ role: "implement", task: "do a thing" }))), /^## Changed\nfoo\.ts\n\n\[run-1 · implement · /);
		assert.equal(fs.readFileSync(file, "utf8"), text, "a file this pi-fusion cannot read is one it never writes");
		assert.deepEqual(fs.readdirSync(dir), ["host-1.json"], "a refused write leaves no temporary file behind");
		const warnings = host.notices.filter(([, type]) => type === "warning");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]![0], /^fusion history: history file .* was written by a newer pi-fusion \(version 99\); it is left alone$/);
	}));
