import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CARD_REPORT_LINES } from "../extensions/cards.ts";
import fusion from "../extensions/fusion.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_FUSION_CLAUDE_BIN = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.FAKE_CLAUDE_SCENARIO = "ok";
process.env.PI_FUSION_DASHBOARD_OPEN = "0";
/** Where this file's runs would be kept if the history were on, so a test can show that nothing writes it. */
const historyHome = path.join(fs.realpathSync(os.tmpdir()), `pi-fusion-history-${process.pid}`);
process.env.PI_FUSION_HISTORY_DIR = historyHome;

/** What a renderer gives back: the component Pi draws in the transcript. */
interface Rendered {
	render: (width: number) => string[];
	invalidate: () => void;
}

type Renderer = (message: any, options: { expanded: boolean; outputPad: number }, theme: any) => Rendered | undefined;

interface RegisteredTool {
	name: string;
	executionMode?: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: any;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
	renderCall?: (args: any, theme: any, context: any) => Rendered;
	renderResult?: (result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) => Rendered;
}

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: any) => Promise<void>;
}

const tools: RegisteredTool[] = [];
const commands = new Map<string, RegisteredCommand>();
const renderers = new Map<string, Renderer>();
const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
let appendedEntries = 0;
const api = {
	registerTool: (tool: RegisteredTool) => {
		tools.push(tool);
	},
	registerCommand: (name: string, options: RegisteredCommand) => {
		commands.set(name, options);
	},
	on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
		handlers.set(event, handler);
	},
	appendEntry: () => {
		appendedEntries++;
	},
	registerMessageRenderer: (customType: string, renderer: Renderer) => {
		renderers.set(customType, renderer);
	},
} as unknown as ExtensionAPI;

fusion(api);

const ctx = {
	cwd: repoRoot,
	ui: { setStatus() {} },
	sessionManager: {
		getSessionFile: () => "/tmp/host-1.jsonl",
		getSessionId: () => "host-1",
		getBranch: () => [],
	},
};

const byName = (name: string): RegisteredTool => {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `tool ${name} not registered`);
	return tool;
};

interface Invocation {
	argv: string[];
	prompt: string;
	appendSystemPrompt?: string;
	env: Record<string, string | undefined>;
	text: string;
}

async function invoke(name: string, params: Record<string, unknown>): Promise<Invocation> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-test-"));
	const out = path.join(dir, "argv.json");
	process.env.FAKE_CLAUDE_ARGV_OUT = out;
	try {
		const result = await byName(name).execute("call-1", params, undefined, undefined, ctx);
		const recorded = JSON.parse(fs.readFileSync(out, "utf8")) as Omit<Invocation, "text">;
		return { ...recorded, text: result.content[0]!.text };
	} finally {
		delete process.env.FAKE_CLAUDE_ARGV_OUT;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function valueOf(argv: string[], flag: string): string | undefined {
	const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
	if (inline) return inline.slice(flag.length + 1);
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

const count = (argv: string[], flag: string) => argv.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)).length;

function assertCommon(run: Invocation, contract: string) {
	assert.equal(valueOf(run.argv, "--output-format"), "stream-json");
	assert.equal(valueOf(run.argv, "--input-format"), "stream-json");
	assert.ok(run.argv.includes("--include-partial-messages"));
	assert.equal(valueOf(run.argv, "--permission-mode"), "bypassPermissions");
	assert.ok(run.argv.includes("--allow-dangerously-skip-permissions"));
	assert.equal(valueOf(run.argv, "--permission-prompts"), "none");
	assert.equal(count(run.argv, "--effort"), 1);
	assert.equal(run.appendSystemPrompt, fs.readFileSync(path.join(repoRoot, "contracts", contract), "utf8"));
	assert.ok(!run.argv.includes("--append-system-prompt"), "the contract goes through the SDK handshake, not argv");
	assert.ok(!run.argv.includes("--setting-sources"), "children load Claude Code's default setting sources");
	assert.equal(run.env.CLAUDE_AGENT_SDK_CLIENT_APP, "pi-fusion");
	assert.equal(run.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "0");
	assert.match(run.text, /\n\n\[.+ · \d+ tool calls · in \d+ out \d+ · context [\d.]+k\/[\d.]+M \(<1%\) · workflow agents 250 tokens · claude --resume [^\]]+\]$/);
}

test("registers the sequential claude and claude_control tools, the fusion command, one session_shutdown handler and one session_before_tree handler", () => {
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["claude", "claude_control"],
	);
	assert.equal(byName("claude").executionMode, "sequential");
	assert.equal(byName("claude_control").executionMode, "sequential");
	assert.deepEqual([...handlers.keys()], ["session_shutdown", "session_before_tree"]);
	const command = commands.get("fusion");
	assert.ok(command, "the fusion command is not registered");
	assert.ok(command.description, "the command needs a description for the command list");
	assert.deepEqual(command.getArgumentCompletions?.(""), [
		{ value: "dashboard", label: "dashboard" },
		{ value: "dashboard stop", label: "dashboard stop" },
		{ value: "status", label: "status" },
		{ value: "cancel", label: "cancel" },
		{ value: "steer", label: "steer" },
		{ value: "wait", label: "wait" },
		{ value: "answer", label: "answer" },
		{ value: "review", label: "review" },
	]);
	assert.deepEqual(command.getArgumentCompletions?.("dashboard s"), [{ value: "dashboard stop", label: "dashboard stop" }]);
	assert.deepEqual(command.getArgumentCompletions?.("s"), [
		{ value: "status", label: "status" },
		{ value: "steer", label: "steer" },
	]);
	assert.equal(command.getArgumentCompletions?.("stop"), null, "a prefix that matches nothing completes nothing");
	assert.equal(command.getArgumentCompletions?.("status "), null, "no run of this Pi process has a handle yet");
});

const renderTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<b>${text}</b>` };

const renderContext = (args: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
	args,
	toolCallId: "call-1",
	invalidate() {},
	lastComponent: undefined,
	state: {},
	cwd: repoRoot,
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	isError: false,
	...over,
});

const noWiderThan = (lines: string[], width: number) => {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
	return lines;
};

test("the claude and claude_control tools render their call and result as cards no wider than the width", () => {
	const claude = byName("claude");
	assert.ok(claude.renderCall && claude.renderResult, "claude renders neither its call nor its result");
	const args = { role: "implement", task: "rename x everywhere it is used, then run the tests\nand report" };
	const call = claude.renderCall(args, renderTheme, renderContext(args));
	assert.match(call.render(200)[0]!, /^<toolTitle><b>claude implement<\/b><\/toolTitle> <muted>rename x everywhere it is used, then run the tests<\/muted>$/);
	noWiderThan(call.render(80), 80);
	const result = {
		content: [{ type: "text", text: "## Changed\nfoo.ts\n\n## Escalation\nthe scope is wider than the task\n\n[run-1 · implement · opus · 3s · 2 tool calls · in 10 out 5]" }],
		details: { handle: "run-1", role: "implement", model: "opus", state: "done", elapsedMs: 3_200, costUsd: 0.25, filesChanged: 1, files: ["foo.ts"] },
	};
	for (const expanded of [false, true]) {
		const card = claude.renderResult(result, { expanded, isPartial: false }, renderTheme, renderContext(args, { expanded }));
		const lines = card.render(200);
		assert.match(lines[0]!, /^<toolTitle><b>claude<\/b><\/toolTitle> implement run-1 · <success>done<\/success> · 3s · 1 files · \$0\.2500$/);
		assert.equal(lines.some((line) => /<warning>## Escalation<\/warning>/.test(line)), expanded, "only the expanded card marks the escalation heading");
		for (const width of [40, 80]) noWiderThan(card.render(width), width);
	}
	const control = byName("claude_control");
	assert.ok(control.renderResult, "claude_control does not render its result");
	const status = { content: [{ type: "text", text: "run-1 · implement · opus · running · 3s\ntool calls: 2" }], details: { handle: "run-1", state: "running", elapsedMs: 3_000 } };
	const args2 = { action: "status", run: "run-1" };
	const card = control.renderResult(status, { expanded: false, isPartial: false }, renderTheme, renderContext(args2));
	assert.match(card.render(200)[0]!, /^<toolTitle><b>claude_control status<\/b><\/toolTitle> run-1 · <warning>running<\/warning> · 3s$/);
	noWiderThan(card.render(80), 80);
	const thrown = control.renderResult({ content: [{ type: "text", text: "unknown run run-9" }] }, { expanded: false, isPartial: false }, renderTheme, renderContext(args2, { isError: true }));
	assert.match(thrown.render(200)[0]!, /<error>failed<\/error>/, "a tool that threw carries no state, so the row's error names one");
});

test("a call renders before its arguments have arrived, and an argument of the wrong type draws nothing", () => {
	const claude = byName("claude");
	const bare = claude.renderCall!(undefined, renderTheme, renderContext({}));
	assert.deepEqual(bare.render(200), ["<toolTitle><b>claude</b></toolTitle>"], "a call with no arguments yet still draws its name");
	const odd = { role: 7, task: { text: "a task the model has not finished streaming" }, continue: [] };
	assert.deepEqual(claude.renderCall!(odd, renderTheme, renderContext(odd)).render(200), ["<toolTitle><b>claude</b></toolTitle>"], "nothing but a string names the role or the task");
	const partial = { role: "implement", task: "rename x" };
	assert.deepEqual(claude.renderCall!(partial, renderTheme, renderContext(partial)).render(200), ["<toolTitle><b>claude implement</b></toolTitle> <muted>rename x</muted>"]);
});

test("a collapsed result card cuts its report lines and says how many are left, and expanding the same card wraps them", () => {
	const claude = byName("claude");
	const args = { role: "implement", task: "rename x" };
	const result = {
		content: [{ type: "text", text: "## Changed\nfoo.ts\n\n## Escalation\nthe scope is wider than the task\n\n[run-1 · implement · opus · 3s · 2 tool calls · in 10 out 5]" }],
		details: { handle: "run-1", role: "implement", state: "done", elapsedMs: 3_000 },
	};
	const collapsed = claude.renderResult!(result, { expanded: false, isPartial: false }, renderTheme, renderContext(args));
	assert.equal(collapsed.render(24).length, 1 + CARD_REPORT_LINES + 1, "a collapsed card is one line per report line, plus the header and the count");
	assert.match(collapsed.render(200).at(-1)!, /^<muted>… 1 more lines, ctrl\+o to expand<\/muted>$/);
	const expanded = claude.renderResult!(result, { expanded: true, isPartial: false }, renderTheme, renderContext(args, { expanded: true, lastComponent: collapsed }));
	assert.equal(expanded, collapsed, "the row refills the card it already has");
	assert.ok(expanded.render(24).length > 1 + CARD_REPORT_LINES + 1, "and the expanded card wraps the whole report");
});

const ESC = "\u001b";
const BEL = "\u0007";

test("a partial result card strips the escape sequences the child's activity carries", () => {
	const claude = byName("claude");
	const args = { role: "implement", task: "rename x" };
	const activity = `run-1 implement · 3s · 2 tool calls · Bash ${ESC}[2Jnpm test ${ESC}]8;;https://evil.test${BEL}click me${ESC}]8;;${BEL}`;
	const card = claude.renderResult!({ content: [{ type: "text", text: activity }] }, { expanded: false, isPartial: true }, renderTheme, renderContext(args, { isPartial: true }));
	const lines = card.render(200);
	assert.deepEqual(lines, ["<muted>run-1 implement · 3s · 2 tool calls · Bash npm test click me</muted>"]);
	for (const line of lines) {
		assert.ok(!line.includes(ESC), `an escape introducer reached the terminal: ${JSON.stringify(line)}`);
		assert.ok(!line.includes(BEL), `a bell reached the terminal: ${JSON.stringify(line)}`);
	}
});

test("the extension registers a renderer for its run notices, and it fits any width", () => {
	const renderer = renderers.get("pi-fusion-run");
	assert.ok(renderer, `no renderer for pi-fusion-run in ${[...renderers.keys()].join(", ") || "none"}`);
	const message = {
		role: "custom",
		customType: "pi-fusion-run",
		content: "Background run run-1 (implement) done.\n\n## Changed\nfoo.ts\n\n[run-1 · implement · opus · 3s · 2 tool calls · in 10 out 5]",
		display: true,
		details: { handle: "run-1", role: "implement", state: "done", elapsedMs: 3_000, costUsd: 0.25, filesChanged: 1, files: ["foo.ts"] },
	};
	for (const expanded of [false, true]) {
		const card = renderer(message, { expanded, outputPad: 0 }, renderTheme);
		assert.ok(card, "the renderer drew nothing");
		for (const width of [40, 80]) noWiderThan(card.render(width), width);
		assert.match(card.render(200)[0]!, /^<customMessageLabel><b>run<\/b><\/customMessageLabel> implement run-1 · <success>done<\/success> · 3s · 1 files · \$0\.2500$/);
	}
	const steer = renderer({ ...message, content: "The user steered run-1 (implement): also update the README", details: { handle: "run-1", role: "implement", state: "running", kind: "steer", by: "user" } }, { expanded: false, outputPad: 0 }, renderTheme);
	assert.match(steer!.render(200)[0]!, /^<customMessageLabel><b>user steer<\/b><\/customMessageLabel> implement run-1 · <warning>running<\/warning>$/);
	for (const kind of ["toString", "constructor", "nothing this knows"]) {
		const odd = renderer({ ...message, details: { handle: "run-1", state: "done", kind } }, { expanded: false, outputPad: 0 }, renderTheme);
		assert.match(odd!.render(200)[0]!, /^<customMessageLabel><b>run<\/b><\/customMessageLabel> run-1 · <success>done<\/success>$/, kind);
	}
});

test("the role and effort parameters are plain string enums", () => {
	const properties = byName("claude").parameters.properties;
	assert.deepEqual(properties.role.enum, ["plan", "implement", "ultracode", "ask"]);
	assert.deepEqual(properties.mode.enum, ["answer", "review"]);
	assert.equal(properties.mode.type, "string");
	assert.equal(properties.role.type, "string");
	assert.deepEqual(properties.effort.enum, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(properties.continue.type, "string");
	assert.deepEqual(byName("claude").parameters.required, ["task"]);
});

test("every prompt guideline names the claude tool, and together they name every role", () => {
	const guidelines = byName("claude").promptGuidelines ?? [];
	assert.ok(guidelines.length, "claude contributes no guidelines");
	for (const guideline of guidelines) assert.ok(guideline.includes("claude"), `a guideline never names claude: ${guideline}`);
	for (const role of ["plan", "implement", "ultracode", "ask"]) {
		assert.ok(guidelines.some((guideline) => guideline.includes(`role ${role}`)), `no guideline names role ${role}`);
	}
	for (const pattern of [/do not edit files yourself/, /choice wins/, /^Report to the user/, /Escalation/, /continue set to its handle/, /background true/]) {
		assert.equal(guidelines.filter((guideline) => pattern.test(guideline)).length, 1, `${pattern} must match one guideline`);
	}
	assert.ok(!guidelines.some((guideline) => /tool list/.test(guideline)), "all roles are always available");
});

test("no tool metadata routes by file count or names the old tools", () => {
	const routing = /multi-file|one small task|non-trivial/i;
	const tool = byName("claude");
	const properties = Object.values(tool.parameters.properties ?? {}) as Array<{ description?: string }>;
	const metadata = [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? []), ...properties.map((property) => property.description ?? "")];
	for (const text of metadata) {
		assert.ok(!routing.test(text), `claude still routes by file count: ${text}`);
		assert.ok(!/fable_consolidate|opus_implement|fable_implement/.test(text), `claude metadata names an old tool: ${text}`);
	}
});

test("role implement takes a direct task and records its run in the host session", async () => {
	const before = appendedEntries;
	const run = await invoke("claude", { role: "implement", task: "rename x", context: "asked directly" });
	assertCommon(run, "implement.md");
	assert.equal(run.prompt, "rename x\n\n## Context\nasked directly");
	assert.equal(appendedEntries, before + 1, "every run records its handle so the host can continue it");
});

test("the contracts carry the escalation and route sections the tool promises", () => {
	const contract = (name: string) => fs.readFileSync(path.join(repoRoot, "contracts", name), "utf8");
	const implement = contract("implement.md");
	assert.match(implement, /^## Escalation$/m);
	assert.ok(!implement.includes("one agreed task"), "role implement takes a bounded task, agreed or direct");
	const plan = contract("plan.md");
	assert.match(plan, /^## Route$/m);
	assert.match(plan, /`implement`/);
	assert.match(plan, /`ultracode`/);
	for (const name of ["ask-answer.md", "ask-review.md"]) {
		assert.match(contract(name), /Do not change files/);
		assert.match(contract(name), /`path:line`/);
	}
	assert.match(contract("ask-review.md"), /^## Findings$/m);
	assert.match(contract("ask-review.md"), /most severe first/);
	for (const name of ["plan.md", "implement.md", "ultracode.md", "ask-answer.md", "ask-review.md"]) {
		assert.ok(!/multi-file|one small task/i.test(contract(name)), `${name} still routes by file count`);
		assert.ok(!/fable_consolidate|opus_implement|fable_implement|workhorse|consolidator/.test(contract(name)), `${name} still uses an old name`);
	}
});

test("role plan runs at xhigh in its own Claude Code session", async () => {
	const run = await invoke("claude", { role: "plan", task: "goal and plan" });
	assertCommon(run, "plan.md");
	assert.equal(valueOf(run.argv, "--model"), "fable");
	assert.equal(valueOf(run.argv, "--effort"), "xhigh");
	assert.equal(valueOf(run.argv, "--tools"), "Read,Bash,Edit,Write,Grep,Glob");
	assert.ok(run.argv.includes("--strict-mcp-config"));
	assert.match(valueOf(run.argv, "--session-id") ?? "", /^[0-9a-f-]{36}$/);
	assert.equal(valueOf(run.argv, "--resume"), undefined);
	assert.ok(!run.argv.includes("--fork-session"));
	assert.equal(run.prompt, "goal and plan");
});

test("role implement runs in a new session with an explicit tool list and no MCP servers", async () => {
	const run = await invoke("claude", { role: "implement", task: "do a thing" });
	assertCommon(run, "implement.md");
	assert.equal(valueOf(run.argv, "--model"), "opus");
	assert.equal(valueOf(run.argv, "--effort"), "high");
	assert.equal(valueOf(run.argv, "--tools"), "Read,Bash,Edit,Write,Grep,Glob");
	assert.ok(run.argv.includes("--strict-mcp-config"));
	assert.match(valueOf(run.argv, "--session-id") ?? "", /^[0-9a-f-]{36}$/);
	assert.equal(valueOf(run.argv, "--resume"), undefined);
	assert.equal(run.prompt, "do a thing");
});

test("a call's model and effort replace the role's defaults and show in the stats line", async () => {
	const run = await invoke("claude", { role: "implement", task: "do a thing", model: "sonnet", effort: "max" });
	assert.equal(valueOf(run.argv, "--model"), "sonnet");
	assert.equal(valueOf(run.argv, "--effort"), "max");
	assert.match(run.text, /\[run-\d+ · implement · sonnet · /);
	const plan = await invoke("claude", { role: "plan", task: "goal", effort: "medium" });
	assert.equal(valueOf(plan.argv, "--effort"), "medium");
	assert.equal(valueOf(plan.argv, "--model"), "fable");
});

test("a parameter the role does not take fails the call before any child starts", async () => {
	for (const [params, message] of [
		[{ role: "ultracode", task: "x", effort: "high" }, "effort is not allowed for role ultracode"],
		[{ role: "ultracode", task: "x", model: "opus" }, "model is not allowed for role ultracode"],
		[{ role: "plan", task: "x", model: "opus" }, "model is not allowed for role plan"],
		[{ role: "implement", task: "x", mode: "review" }, "mode is not allowed for role implement"],
		[{ role: "ultracode", task: "x", mode: "answer" }, "mode is not allowed for role ultracode"],
		[{ role: "plan", task: "x", mode: "review" }, "mode is not allowed for role plan"],
		[{ role: "ask", task: "x", fresh: true }, "fresh is not allowed for role ask"],
		[{ role: "ask", task: "x", mode: "fix" }, "unknown mode fix; use one of answer, review"],
		[{ role: "implement", task: "x", fresh: true }, "fresh is not allowed for role implement"],
		[{ role: "ultracode", task: "x", fresh: false }, "fresh is not allowed for role ultracode"],
		[{ role: "implement", task: "x", effort: "ultracode" }, "unknown effort ultracode; use one of low, medium, high, xhigh, max"],
		[{ role: "review", task: "x" }, "unknown role review; use one of plan, implement, ultracode, ask"],
	] as const) {
		const before = appendedEntries;
		await assert.rejects(byName("claude").execute("call-1", params, undefined, undefined, ctx), { message }, JSON.stringify(params));
		assert.equal(appendedEntries, before);
	}
});

test("role ask runs read-only tools with no Edit or Write and the answer contract by default", async () => {
	const run = await invoke("claude", { role: "ask", task: "where is the retry logic?" });
	assertCommon(run, "ask-answer.md");
	assert.equal(valueOf(run.argv, "--model"), "opus");
	assert.equal(valueOf(run.argv, "--effort"), "high");
	assert.equal(valueOf(run.argv, "--tools"), "Read,Bash,Grep,Glob,WebSearch,WebFetch");
	assert.ok(run.argv.includes("--strict-mcp-config"));
	assert.equal(run.prompt, "where is the retry logic?");
	assert.match(run.text, /\[run-\d+ · ask · opus · /);
});

test("role ask with mode review sends the review contract, and takes a model and effort", async () => {
	const review = await invoke("claude", { role: "ask", mode: "review", task: "review git diff HEAD~1", model: "fable", effort: "xhigh" });
	assertCommon(review, "ask-review.md");
	assert.equal(valueOf(review.argv, "--tools"), "Read,Bash,Grep,Glob,WebSearch,WebFetch");
	assert.equal(valueOf(review.argv, "--model"), "fable");
	assert.equal(valueOf(review.argv, "--effort"), "xhigh");
	const answer = await invoke("claude", { role: "ask", mode: "answer", task: "why?" });
	assertCommon(answer, "ask-answer.md");
});

test("role ultracode runs with Claude Code's own tools and MCP servers", async () => {
	const run = await invoke("claude", { role: "ultracode", task: "do a thing", context: "decided: x" });
	assertCommon(run, "ultracode.md");
	assert.equal(valueOf(run.argv, "--model"), "fable");
	assert.equal(valueOf(run.argv, "--effort"), "ultracode");
	assert.ok(!run.argv.includes("--tools"));
	assert.ok(!run.argv.includes("--disallowedTools"));
	assert.ok(!run.argv.includes("--strict-mcp-config"));
	assert.ok(!run.argv.includes("--settings"));
	assert.equal(run.prompt, "do a thing\n\n## Context\ndecided: x");
	assert.match(run.appendSystemPrompt ?? "", /Run one agent at a time/);
	assert.match(run.text, /^## Changed\nfoo\.ts\n\n\[run-\d+ · ultracode · fable · \d+s · 2 tool calls · in 26 out 8 · context 1\.2k\/1\.00M \(<1%\) · workflow agents 250 tokens · claude --resume [0-9a-f-]{36}\]$/);
});

test("role ultracode is told to run one agent at a time, in its contract and in the host's guidelines", () => {
	const contract = fs.readFileSync(path.join(repoRoot, "contracts", "ultracode.md"), "utf8");
	assert.match(contract, /Run one agent at a time/);
	assert.match(contract, /Promise\.all/);
	assert.ok(!contract.includes("independent pieces in parallel"), "the contract still asks for parallel implementation");
	for (const kept of ["model: 'claude-opus-5'", "effort: 'xhigh'", "did not write the change", "Do not commit."]) {
		assert.ok(contract.includes(kept), `the contract no longer says ${kept}`);
	}
	const tool = byName("claude");
	const metadata = [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])];
	for (const text of metadata) assert.ok(!/parallel agents/i.test(text), `claude metadata still promises parallel agents: ${text}`);
	assert.ok(
		metadata.some((text) => /ultracode/.test(text) && /one at a time|one agent at a time/.test(text)),
		"nothing in claude's metadata tells the host that role ultracode runs its agents one at a time",
	);
});

test("the workflow size guideline reaches the ultracode child as a settings override", async () => {
	process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE = "large";
	try {
		const run = await invoke("claude", { role: "ultracode", task: "do a thing" });
		assert.deepEqual(JSON.parse(valueOf(run.argv, "--settings")!), { workflowSizeGuideline: "large" });
		const implement = await invoke("claude", { role: "implement", task: "do a thing" });
		assert.ok(!implement.argv.includes("--settings"));
	} finally {
		delete process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE;
	}
});

test("the status line ticks every second while the child is silent", async () => {
	const statuses: Array<string | undefined> = [];
	const updates: string[] = [];
	const recording = { ...ctx, ui: { setStatus: (_key: string, line: string | undefined) => statuses.push(line) } };
	process.env.FAKE_CLAUDE_SCENARIO = "slow";
	try {
		await byName("claude").execute(
			"call-1",
			{ role: "implement", task: "do a thing" },
			undefined,
			((partial: { content: Array<{ text: string }> }) => updates.push(partial.content[0]!.text)) as never,
			recording,
		);
	} finally {
		process.env.FAKE_CLAUDE_SCENARIO = "ok";
	}
	assert.match(statuses[0] ?? "", /^run-\d+ implement · 0s · starting$/);
	assert.ok(statuses.some((line) => /^run-\d+ implement · 0s · 1 tool calls · Bash npm test$/.test(line ?? "")), JSON.stringify(statuses));
	assert.ok(statuses.some((line) => /^run-\d+ implement · 1s · 1 tool calls · Bash npm test$/.test(line ?? "")), JSON.stringify(statuses));
	assert.equal(statuses[statuses.length - 1], undefined);
	assert.deepEqual(updates, statuses.slice(0, -1));
});

test("a failed child surfaces the failure as a tool error", async () => {
	process.env.FAKE_CLAUDE_SCENARIO = "error";
	try {
		await assert.rejects(
			invoke("claude", { role: "ultracode", task: "do a thing" }),
			/ultracode model error: boom\n\n\[run-\d+ · ultracode · fable · \d+s · 0 tool calls · in \d+ out \d+ · claude --resume [0-9a-f-]{36}\]$/,
		);
	} finally {
		process.env.FAKE_CLAUDE_SCENARIO = "ok";
	}
});

interface Notice {
	message: string;
	type?: string;
}

const fusionCommand = (): RegisteredCommand => {
	const command = commands.get("fusion");
	assert.ok(command, "the fusion command is not registered");
	return command;
};

function commandCtx(): { ctx: any; notices: Notice[] } {
	const notices: Notice[] = [];
	const ui = { setStatus() {}, notify: (message: string, type?: string) => notices.push({ message, type }) };
	return { ctx: { ...ctx, ui }, notices };
}

async function runCommand(args: string): Promise<Notice[]> {
	const invocation = commandCtx();
	await fusionCommand().handler(args, invocation.ctx);
	return invocation.notices;
}

function urlIn(notices: Notice[]): string {
	const url = notices.filter((notice) => notice.type === "info").map((notice) => /http:\/\/\S+/.exec(notice.message)?.[0])[0];
	assert.ok(url, `no dashboard url in ${JSON.stringify(notices)}`);
	return url;
}

async function getJson(target: string): Promise<any> {
	const response = await fetch(target);
	assert.equal(response.status, 200, `${target} answered ${response.status}`);
	return response.json();
}

/**
 * The dashboard is gone when the port refuses the connection, not when it answers 404. A pooled keep-alive socket
 * that closing destroyed reports a reset instead, so a reset is retried on a fresh connection.
 */
async function refused(target: string): Promise<string> {
	let code = "";
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await fetch(target);
			return "answered";
		} catch (error) {
			code = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
			if (code !== "ECONNRESET") return code;
		}
	}
	return code;
}

let dashboardUrl = "";

test("/fusion dashboard serves this session's runs over loopback", async () => {
	const notices = await runCommand("dashboard");
	dashboardUrl = urlIn(notices);
	assert.match(dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/$/);
	const payload = (await getJson(`${dashboardUrl}api/runs`)) as { cwd: string; runs: Array<{ id: string; role: string; status: string }> };
	assert.equal(payload.cwd, ctx.cwd);
	const roles = payload.runs.map((run) => run.role);
	for (const role of ["plan", "implement", "ultracode"]) assert.ok(roles.includes(role), `${role} is missing from ${JSON.stringify(roles)}`);
	const broken = payload.runs.find((run) => run.role === "ultracode" && run.status === "failed");
	assert.ok(broken, `no failed ultracode run in ${JSON.stringify(payload.runs.map((run) => [run.role, run.status]))}`);
	const detail = (await getJson(`${dashboardUrl}api/runs/${broken.id}`)) as { failure?: string };
	assert.match(detail.failure ?? "", /model error: boom/);
});

test("the dashboard payload carries what this Pi session's runs have cost", async () => {
	const payload = (await getJson(`${dashboardUrl}api/runs`)) as { usage?: { costUsd: number; tokensIn: number; tokensOut: number; workflowTokens: number; calls: number; warnUsd: number[]; limitUsd?: number } };
	const usage = payload.usage;
	assert.ok(usage, "the dashboard reads the session ledger");
	assert.ok(usage.costUsd > 0, `the runs of this file cost something: ${JSON.stringify(usage)}`);
	assert.ok(usage.tokensIn > 0 && usage.tokensOut > 0, "the token counters add up over the calls");
	assert.ok(usage.calls > 1, "every claude call of the file is counted");
	assert.deepEqual(usage.warnUsd, [], "no threshold is configured in this test process");
	assert.equal(usage.limitUsd, undefined);
});

test("a successful ultracode run keeps its report, its workflow task and its log", async () => {
	const payload = (await getJson(`${dashboardUrl}api/runs`)) as {
		runs: Array<{ id: string; role: string; status: string; toolCalls: number; lastEventAt?: number }>;
	};
	const run = payload.runs.find((candidate) => candidate.role === "ultracode" && candidate.status === "done");
	assert.ok(run, "no successful ultracode run was recorded");
	assert.equal(run.toolCalls, 2);
	assert.equal(typeof run.lastEventAt, "number", "the last event time comes from the child, not from a read");
	const detail = (await getJson(`${dashboardUrl}api/runs/${run.id}`)) as {
		prompt: string;
		contract?: string;
		files?: unknown[];
		tool?: string;
		toolCallId?: string;
		hostSessionId?: string;
		text: string;
		textTruncated: boolean;
		tasks: Array<Record<string, any>>;
		log: Array<{ kind: string; text: string }>;
	};
	assert.equal(detail.text, "## Changed\nfoo.ts");
	assert.equal(detail.textTruncated, false);
	assert.match(detail.prompt, /^do a thing/, "the run keeps the prompt the tool sent");
	assert.equal(detail.contract, "contracts/ultracode.md");
	assert.ok(Array.isArray(detail.files), "a run in a git work tree lists the files it changed");
	assert.deepEqual([detail.tool, detail.toolCallId, detail.hostSessionId], ["claude", "call-1", "host-1"]);
	const task = detail.tasks.find((candidate) => candidate.name === "probe");
	assert.ok(task, `no probe task in ${JSON.stringify(detail.tasks)}`);
	assert.equal(task.status, "completed");
	assert.equal(task.tokens, 250);
	assert.equal(task.type, "local_workflow");
	assert.equal(task.phase, "Probe");
	assert.deepEqual(task.agents, [
		{ label: "a", state: "done" },
		{ label: "b", state: "start" },
	]);
	const last = detail.log[detail.log.length - 1];
	assert.equal(last?.kind, "run");
	assert.equal(last?.text, "done");
});

test("a child that leaves a task running fails the run and stops the task with it", async () => {
	process.env.FAKE_CLAUDE_SCENARIO = "wind-down";
	try {
		await assert.rejects(invoke("claude", { role: "ultracode", task: "do a thing" }), /still running/);
	} finally {
		process.env.FAKE_CLAUDE_SCENARIO = "ok";
	}
	const payload = (await getJson(`${dashboardUrl}api/runs`)) as { runs: Array<{ id: string; role: string; status: string; endedAt?: number }> };
	interface Detail {
		failure?: string;
		tasks: Array<{ name: string; status: string; endedAt?: number }>;
		log: Array<{ kind: string; text: string }>;
	}
	let abandoned: { id: string; status: string; endedAt?: number } | undefined;
	let detail: Detail | undefined;
	for (const candidate of payload.runs) {
		if (candidate.role !== "ultracode" || candidate.status !== "failed") continue;
		const found = (await getJson(`${dashboardUrl}api/runs/${candidate.id}`)) as Detail;
		if (/still running/.test(found.failure ?? "")) {
			abandoned = candidate;
			detail = found;
			break;
		}
	}
	assert.ok(abandoned && detail, "no ultracode run failed with a task still running");
	assert.equal(abandoned.status, "failed", "a child that abandons a task fails the run");
	assert.equal(typeof abandoned.endedAt, "number", "a failed run has an end time");
	const task = detail.tasks.find((candidate) => candidate.name === "probe");
	assert.ok(task, `no probe task in ${JSON.stringify(detail.tasks)}`);
	assert.equal(task.status, "stopped", "a task the child left running must not stay running in the store forever");
	assert.equal(task.endedAt, abandoned.endedAt, "the abandoned task ends when the run ends");
	assert.deepEqual(
		detail.log.slice(-2).map((entry) => [entry.kind, entry.text.split(":")[0]]),
		[
			["task", "1 task stopped with the run"],
			["run", "failed"],
		],
		`the log must say the task was stopped before the run's last word: ${JSON.stringify(detail.log.slice(-2))}`,
	);
});

test("a second /fusion dashboard reuses the server and the url", async () => {
	assert.equal(urlIn(await runCommand("dashboard")), dashboardUrl);
});

test("/fusion dashboard stop closes the server", async () => {
	const notices = await runCommand("dashboard stop");
	assert.deepEqual(notices, [{ message: "fusion: dashboard closed", type: "info" }]);
	assert.equal(await refused(`${dashboardUrl}api/runs`), "ECONNREFUSED");
});

test("a later /fusion dashboard gets a fresh url and session_shutdown closes it, twice over", async () => {
	const url = urlIn(await runCommand("dashboard"));
	assert.notEqual(url, dashboardUrl, "a restart must not reuse the closed server's token or port");
	assert.equal(((await getJson(`${url}api/runs`)) as { cwd: string }).cwd, ctx.cwd);
	const shutdown = handlers.get("session_shutdown");
	assert.ok(shutdown, "no session_shutdown handler is registered");
	await shutdown({ reason: "quit" }, ctx);
	assert.equal(await refused(`${url}api/runs`), "ECONNREFUSED");
	await shutdown({ reason: "reload" }, ctx);
});

test("any other argument warns about the usage and starts nothing", async () => {
	const usage = "Usage: /fusion dashboard | /fusion dashboard stop | /fusion status [run-N] | /fusion cancel run-N | /fusion wait run-N | /fusion steer run-N <text> | /fusion answer [run-N] [text] | /fusion review run-N";
	for (const args of ["", "   ", "dashboard start", "status foo", "cancel", "steer run-1"]) {
		const notices = await runCommand(args);
		assert.deepEqual(notices, [{ message: usage, type: "warning" }], `for ${JSON.stringify(args)}`);
	}
});

test("two /fusion dashboard calls at once start one server", async () => {
	const first = commandCtx();
	const second = commandCtx();
	const command = fusionCommand();
	await Promise.all([command.handler("dashboard", first.ctx), command.handler("dashboard", second.ctx)]);
	const url = urlIn(first.notices);
	assert.equal(urlIn(second.notices), url, "both calls must be told about the same server");
	assert.ok(((await getJson(`${url}api/runs`)) as { runs: unknown[] }).runs.length > 0);
	await runCommand("dashboard stop");
	assert.equal(await refused(`${url}api/runs`), "ECONNREFUSED", "one stop must close everything the two calls started");
});

test("a stop while the start is still in flight closes the server the start returns", async () => {
	const starting = commandCtx();
	const stopping = commandCtx();
	const command = fusionCommand();
	const start = command.handler("dashboard", starting.ctx);
	const stop = command.handler("dashboard stop", stopping.ctx);
	await Promise.all([start, stop]);
	assert.deepEqual(stopping.notices, [{ message: "fusion: dashboard closed", type: "info" }]);
	assert.equal(await refused(`${urlIn(starting.notices)}api/runs`), "ECONNREFUSED", "the started server must not be left listening");
});

test("/fusion dashboard stop with nothing running says so", async () => {
	assert.deepEqual(await runCommand("dashboard stop"), [{ message: "fusion: the dashboard is not running", type: "info" }]);
});

test("with PI_FUSION_HISTORY unset a durable host session keeps no run history on disk", () => {
	assert.equal(fs.existsSync(historyHome), false, "the runs of this file's session reached no file");
});
