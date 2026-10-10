import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CARD_REPORT_LINES } from "../extensions/cards.ts";
import { CODEX_CONTRACT_FILES, CODEX_MODES, CODEX_ROLE_NAMES, codexRole } from "../extensions/backends/codex-binding.ts";
import { PI_CONTRACT_FILES, PI_ROLE_NAMES, piRole } from "../extensions/backends/pi-binding.ts";
import { PI_CHILD_MARKER, PI_CHILD_VARIABLE } from "../extensions/backends/pi-launch.ts";
import fusion from "../extensions/fusion.ts";
import { memoryProfileStore } from "../extensions/profile-store.ts";
import { memorySettingsStore } from "../extensions/settings-store.ts";
import { fakeBackend } from "./fake-pi-backend.ts";
import { PRODUCTION_DEFAULT_VARIABLES, productionDefaults, tripwires } from "./tripwire.ts";
import { toolList, turnOn } from "./host-tools.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_FUSION_CLAUDE_BIN = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.FAKE_CLAUDE_SCENARIO = "ok";
process.env.PI_FUSION_DASHBOARD_OPEN = "0";
/** Where this file's runs would be kept if the history were on, so a test can show that nothing writes it. */
const historyHome = path.join(fs.realpathSync(os.tmpdir()), `pi-fusion-history-${process.pid}`);
process.env.PI_FUSION_HISTORY_DIR = historyHome;
// The host below captures the variable when it is made, so the case that says it is unset makes it so, whatever the shell says.
delete process.env.PI_FUSION_HISTORY;

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
const { activeTools: _active, ...toolAccess } = toolList(() => tools.map((tool) => tool.name));
const api = {
	...toolAccess,
	// A tool registered again under its own name replaces the one before it, as the SDK does.
	registerTool: (tool: RegisteredTool) => {
		const at = tools.findIndex((candidate) => candidate.name === tool.name);
		if (at === -1) tools.push(tool);
		else tools[at] = tool;
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

// The tripwires in place of the pi and codex backends: nothing in this file runs a pi or codex child, and the one case
// that reads the production registration makes its own below.
fusion(api, { backends: { ...tripwires() }, profiles: memoryProfileStore(), settings: memorySettingsStore() });
// Fusion starts off; the cases here delegate, so the host turns it on as a user's request for Fusion does.
void turnOn(tools.find((tool) => tool.name === "fusion_activate"));

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

test("registers the sequential fusion and claude tool pairs and the two mode tools, the fusion command and the session and settlement handlers", () => {
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["fusion", "claude", "fusion_control", "claude_control", "fusion_activate", "fusion_deactivate"],
	);
	for (const name of ["fusion", "claude", "fusion_control", "claude_control", "fusion_activate", "fusion_deactivate"]) assert.equal(byName(name).executionMode, "sequential", name);
	assert.deepEqual([...handlers.keys()], ["session_start", "agent_settled", "session_shutdown", "session_before_tree"]);
	const command = commands.get("fusion");
	assert.ok(command, "the fusion command is not registered");
	assert.ok(command.description, "the command needs a description for the command list");
	assert.deepEqual(command.getArgumentCompletions?.(""), [
		{ value: "dashboard", label: "dashboard" },
		{ value: "dashboard stop", label: "dashboard stop" },
		{ value: "dashboard limit", label: "dashboard limit" },
		{ value: "status", label: "status" },
		{ value: "cancel", label: "cancel" },
		{ value: "steer", label: "steer" },
		{ value: "wait", label: "wait" },
		{ value: "answer", label: "answer" },
		{ value: "review", label: "review" },
		{ value: "on", label: "on" },
		{ value: "off", label: "off" },
		{ value: "config", label: "config" },
		{ value: "profile", label: "profile" },
		{ value: "profile list", label: "profile list" },
		{ value: "profile use", label: "profile use" },
		{ value: "profile save", label: "profile save" },
		{ value: "profile default", label: "profile default" },
		{ value: "history", label: "history" },
		{ value: "history on", label: "history on" },
		{ value: "history off", label: "history off" },
	]);
	assert.deepEqual(command.getArgumentCompletions?.("dashboard s"), [{ value: "dashboard stop", label: "dashboard stop" }]);
	assert.deepEqual(command.getArgumentCompletions?.("dashboard l"), [{ value: "dashboard limit", label: "dashboard limit" }]);
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

test("waiting tool cards use the invoking control pair, while background cards preserve the run's pair", () => {
	const result = { content: [{ type: "text", text: "Which name?" }], details: { handle: "run-1", state: "waiting", question: "Which name?", control: "claude_control" } };
	for (const name of ["fusion", "claude", "fusion_control", "claude_control"]) {
		const control = name.startsWith("claude") ? "claude_control" : "fusion_control";
		for (const expanded of [false, true]) {
			const card = byName(name).renderResult!(result, { expanded, isPartial: false }, renderTheme, renderContext({ action: "wait" }, { expanded }));
			assert.equal(card.render(200).at(-1), `<muted>answer: /fusion answer run-1 <text> or ${control} message</muted>`);
		}
	}
	const renderer = renderers.get("pi-fusion-run")!;
	const message = { content: "Background run asks", details: result.details };
	for (const expanded of [false, true]) {
		const card = renderer(message, { expanded, outputPad: 0 }, renderTheme)!;
		assert.equal(card.render(200).at(-1), "<muted>answer: /fusion answer run-1 <text> or claude_control message</muted>");
	}
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

test("the claude tool keeps the exact schema it had: four roles, five efforts and no backend", () => {
	const properties = byName("claude").parameters.properties;
	assert.deepEqual(Object.keys(properties), ["role", "task", "continue", "context", "background", "fresh", "mode", "model", "effort"]);
	assert.deepEqual(properties.role.enum, ["plan", "implement", "ultracode", "ask"]);
	assert.deepEqual(properties.mode.enum, ["answer", "review"]);
	assert.equal(properties.mode.type, "string");
	assert.equal(properties.role.type, "string");
	// Exactly the Claude levels, as a plain string enum: the compatibility tool runs on claude alone, so its schema is that grammar.
	assert.deepEqual(properties.effort.enum, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(properties.effort.type, "string");
	assert.equal(properties.continue.type, "string");
	assert.equal(properties.backend, undefined, "the compatibility tool advertises no backend at all");
	assert.deepEqual(byName("claude").parameters.required, ["task"]);
});

test("the fusion tool advertises every role a backend runs and a backend as plain string enums, and its effort as a string each backend checks", () => {
	const properties = byName("fusion").parameters.properties;
	assert.deepEqual(Object.keys(properties), ["role", "task", "continue", "context", "background", "fresh", "mode", "backend", "model", "effort"]);
	assert.deepEqual(properties.role.enum, ["plan", "implement", "ultracode", "ask", "security"], "the primary tool advertises security, which runs on pi alone");
	assert.deepEqual(byName("claude").parameters.properties.role.enum, ["plan", "implement", "ultracode", "ask"], "and the compatibility tool advertises the four roles claude runs");
	assert.match(properties.role.description, /^plan, implement, ultracode, ask or security\. Required unless continue is set\.$/);
	assert.deepEqual(properties.backend.enum, ["claude", "pi", "codex"]);
	assert.equal(properties.backend.type, "string");
	// No enum: a codex level is the model's own, so the schema cannot list it, and each backend's binding checks its own grammar.
	assert.equal(properties.effort.type, "string");
	assert.equal(properties.effort.enum, undefined, "the fusion effort is not an enum");
	assert.equal(properties.effort.anyOf, undefined, "nor a union of literals");
	for (const named of [/low, medium, high, xhigh or max/, /off, minimal, low, medium, high, xhigh or max/, /codex backend one level with no whitespace/, /codex model or server may still refuse/, /before anything starts/]) {
		assert.match(properties.effort.description, named);
	}
	assert.deepEqual(properties.mode.enum, ["answer", "review"]);
	assert.equal(properties.model.type, "string");
	assert.deepEqual(byName("fusion").parameters.required, ["task"]);
	for (const name of ["fusion_control", "claude_control"]) {
		const control = byName(name).parameters;
		assert.deepEqual(Object.keys(control.properties), ["action", "run", "message"], name);
		assert.deepEqual(control.properties.action.enum, ["status", "wait", "message", "cancel"], name);
		assert.deepEqual(control.required, ["action"], name);
	}
});

/** What one registration advertised and appended. The case below makes two of its own beside this file's. */
interface RecordedHost {
	tools: Map<string, RegisteredTool>;
	entries: number;
}

const recordedHost = (): { into: RecordedHost; api: ExtensionAPI } => {
	const into: RecordedHost = { tools: new Map(), entries: 0 };
	const { activeTools: _active, ...toolAccess } = toolList(() => into.tools.keys());
	const api = {
		...toolAccess,
		registerTool: (tool: RegisteredTool) => into.tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
		appendEntry: () => {
			into.entries++;
		},
		registerMessageRenderer: () => {},
	} as unknown as ExtensionAPI;
	return { into, api };
};

test("the fusion tool says which harness runs what, and the pi backend it registers binds a call before anything starts", async () => {
	const fusionTool = byName("fusion");
	// The generic tool no longer advertises one harness: it names the default, the roles the pi backend runs, where a
	// pi selection comes from and that a call with none is refused. The compatibility tool stays Claude's own.
	assert.doesNotMatch(fusionTool.description, /claude backend only/);
	assert.doesNotMatch(fusionTool.description, /no configuration makes one available here/);
	assert.match(fusionTool.description, /backend pi runs plan, implement, ask and security on the user's own Pi provider configuration/);
	assert.match(fusionTool.description, /PI_FUSION_PI_<ROLE>_MODEL/);
	assert.match(fusionTool.description, /a provider and a model id, such as deepseek\/deepseek-chat/);
	assert.match(fusionTool.description, /refused before anything starts/);
	assert.match(fusionTool.description, /role ultracode runs on the claude backend alone/);
	assert.match(fusionTool.description, /role security on the pi backend alone/);
	assert.match(fusionTool.description, /naming claude for it is refused before anything starts/);
	assert.match(fusionTool.description, /leave backend unset unless the user names one, and a fresh run goes to the backend the configuration above names for its role/);
	// What the configuration is, said in the description rather than as fixed model names a profile would make false.
	assert.match(fusionTool.description, /In this session's configuration plan runs on claude with model fable at effort xhigh; implement runs on claude with model opus at effort high; ultracode runs on claude with model fable; ask runs on claude with model opus at effort high; security is disabled\./);
	assert.doesNotMatch(fusionTool.description, /Claude Fable|Claude Opus with/);
	// The one role whose work the user has to have asked for, said in the description as well as in the guideline.
	assert.match(fusionTool.description, /only when the user asks for a security investigation, audit or fix/);
	assert.doesNotMatch(fusionTool.promptGuidelines?.join("\n") ?? "", /security investigation, audit or fix/, "a disabled role is not recommended in routing guidance");
	assert.match(fusionTool.description, /never puts a secret in its report by value/);
	assert.match(fusionTool.description, /with none it reports findings and changes no application code/);
	assert.doesNotMatch(byName("claude").description, /\bsecurity\b/, "the compatibility tool advertises a role it cannot run nowhere");
	// Pi's tools are Pi's own, so the generic tool says what each pi role actually has rather than letting the claude
	// lists above stand for them. What the sentence promises is read back out of it and compared with the lists the
	// binding itself builds, rather than pinned as a second copy of them: a tool added to or taken from a pi role
	// fails here instead of leaving the help text saying what the roles used to run with.
	const piTools = (role: string): string[] => piRole({ role, model: "deepseek/deepseek-chat" }, undefined, {} as NodeJS.ProcessEnv).tools;
	const named = (prose: string): string[] =>
		prose
			.split(/,\s*|\s+and\s+/)
			.map((tool) => tool.trim())
			.filter((tool) => tool !== "");
	const promised = /roles plan, implement and security run with (.+?), role ask runs with (.+?) and has no web search or web fetch tool at all/.exec(fusionTool.description);
	assert.ok(promised, `the fusion description no longer says what the pi roles run with: ${fusionTool.description}`);
	assert.deepEqual(named(promised[1]), piTools("plan"), "the plan, implement and security sentence promises another tool list than the pi binding builds");
	assert.deepEqual(piTools("implement"), piTools("plan"), "and that sentence says one list for all three of them");
	assert.deepEqual(piTools("security"), piTools("implement"), "a security child investigates and, when its task authorizes one, writes the fix");
	assert.deepEqual(named(promised[2]), piTools("ask"), "the ask sentence promises another tool list than the pi binding builds");
	// Said directly beside the parse, because it is the limitation a caller gets wrong: whatever the prose calls them,
	// no web tool of any name is in what a pi ask child runs with.
	assert.deepEqual(piTools("ask").filter((tool) => /web|fetch|search/i.test(tool)), [], "a pi ask role must have no web search or web fetch tool at all");
	assert.deepEqual([...PI_ROLE_NAMES].sort(), ["ask", "implement", "plan", "security"], "the sentence accounts for four pi roles, so a fifth this build binds has to be written into it");
	assert.match(fusionTool.description, /every pi role also gets ask_orchestrator/);
	assert.doesNotMatch(byName("claude").description, /find and ls/, "the compatibility tool advertises claude's own tools and no pi list");
	const backendParameter = fusionTool.parameters.properties.backend.description as string;
	assert.match(backendParameter, /claude, which runs every role but security/);
	assert.match(backendParameter, /Leave it unset to run the role on the backend this session's configuration names for it/);
	assert.match(backendParameter, /pi, which runs plan, implement, ask and security/);
	assert.match(backendParameter, /role security goes to pi whether or not this names it/);
	assert.ok(
		(fusionTool.promptGuidelines ?? []).some((guideline) => /backend parameter/.test(guideline) && /leave backend unset otherwise/.test(guideline)),
		"no fusion guideline says where the harness the user named goes",
	);
	assert.doesNotMatch(byName("claude").description, /\bbackend\b/, "the compatibility tool advertises no backend and says nothing about one");

	// One of exactly two registrations in the suite that take the production defaults on purpose, the pi backend this
	// build registers included and no tripwire over it; codex keeps its tripwire there, because no missing-model refusal
	// would stop a codex call. With nothing configured for any pi role, an explicit pi call is refused by the binding
	// before that backend is asked for a session, a control or a run: no child of any harness is started and nothing is
	// recorded. Every variable a pi role could resolve a model from, and every codex one, is deleted first, and
	// `productionDefaults` refuses the registration outright if one of them is still set, so the refusal below is the
	// binding's own and never this process's environment.
	const kept = PRODUCTION_DEFAULT_VARIABLES.map((name) => [name, process.env[name]] as const);
	for (const [name] of kept) delete process.env[name];
	try {
		const defaults = recordedHost();
		fusion(defaults.api, productionDefaults());
		void turnOn(defaults.into.tools.get("fusion_activate"));
		const defaultFusion = defaults.into.tools.get("fusion");
		assert.ok(defaultFusion, "the production-default registration advertises no fusion tool");
		await assert.rejects(defaultFusion.execute("call-1", { role: "implement", task: "x", backend: "pi" }, undefined, undefined, ctx), {
			message:
				"role implement has no model for the pi backend: set PI_FUSION_PI_IMPLEMENT_MODEL to a provider and a model id, such as deepseek/deepseek-chat, or name one in the call's model parameter. The pi backend has no default model and resolves none for you",
		});
		// Security is disabled by default and is refused before model binding.
		await assert.rejects(defaultFusion.execute("call-2", { role: "security", task: "audit the token check" }, undefined, undefined, ctx), {
			message:
				"role security is disabled in profile builtin; change /fusion config or select another profile",
		});
		assert.equal(defaults.into.entries, 0, "a call the binding refused records nothing");
	} finally {
		for (const [name, value] of kept) if (value !== undefined) process.env[name] = value;
	}

	// And a host that registers a backend of its own in place of the default runs one explicit pi call through the same
	// lifecycle. The fake is in-memory and starts nothing: no pi child, process, protocol or provider is behind it.
	const fake = fakeBackend();
	const injected = recordedHost();
	fusion(injected.api, { backends: { ...tripwires(), pi: fake.backend }, profiles: memoryProfileStore(), settings: memorySettingsStore() });
	void turnOn(injected.into.tools.get("fusion_activate"));
	const injectedFusion = injected.into.tools.get("fusion");
	assert.ok(injectedFusion, "the registration that injected a pi backend advertises no fusion tool");
	const ran = await injectedFusion.execute("call-1", { role: "implement", task: "do the pi thing", backend: "pi", model: "deepseek/deepseek-chat" }, undefined, undefined, ctx);
	assert.match(ran.content[0]!.text, /^## Changed\nfoo\.ts/);
	assert.equal(fake.starts.length, 1, "one explicit pi call starts exactly one child on the backend the host registered");
	assert.deepEqual([fake.starts[0]!.role.name, fake.starts[0]!.role.model], ["implement", "deepseek/deepseek-chat"]);
	assert.equal(injected.into.entries, 1, "and that run recorded its own handle");
});

test("every prompt guideline names the tool that carries it, and together they name every role", () => {
	for (const [tool, control] of [
		["fusion", "fusion_control"],
		["claude", "claude_control"],
	]) {
		const guidelines = byName(tool).promptGuidelines ?? [];
		assert.ok(guidelines.length, `${tool} contributes no guidelines`);
		for (const guideline of guidelines) assert.ok(guideline.includes(tool), `a ${tool} guideline never names ${tool}: ${guideline}`);
		assert.ok(guidelines.some((guideline) => guideline.includes(control)), `no ${tool} guideline names ${control}`);
		if (tool === "fusion") {
			for (const guideline of guidelines) assert.ok(!/\bclaude\b/.test(guideline), `a fusion guideline still routes through the claude tool: ${guideline}`);
		}
		for (const role of ["plan", "implement", "ultracode", "ask"]) {
			assert.ok(guidelines.some((guideline) => guideline.includes(`role ${role}`)), `no ${tool} guideline names role ${role}`);
		}
		for (const pattern of [/do not edit files yourself/, /choice wins/, /^Report to the user/, /Escalation/, /continue set to its handle/, /background true/, /tasks and context in normal, readable prose\. Preserve spaces between words; do not concatenate words to shorten prompts/]) {
			assert.equal(guidelines.filter((guideline) => pattern.test(guideline)).length, 1, `${pattern} must match one ${tool} guideline`);
		}
		assert.ok(!guidelines.some((guideline) => /tool list/.test(guideline)), "all roles are always available");
	}
});

test("no tool metadata routes by file count or names the old tools", () => {
	const routing = /multi-file|one small task|non-trivial/i;
	for (const name of ["fusion", "claude"]) {
		const tool = byName(name);
		const properties = Object.values(tool.parameters.properties ?? {}) as Array<{ description?: string }>;
		const metadata = [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? []), ...properties.map((property) => property.description ?? "")];
		for (const text of metadata) {
			assert.ok(!routing.test(text), `${name} still routes by file count: ${text}`);
			assert.ok(!/fable_consolidate|opus_implement|fable_implement/.test(text), `${name} metadata names an old tool: ${text}`);
		}
	}
});

test("a fusion call with no backend runs the role's claude defaults and records the run as a claude one", async () => {
	const before = appendedEntries;
	const run = await invoke("fusion", { role: "implement", task: "rename x" });
	assertCommon(run, "implement.md");
	assert.equal(valueOf(run.argv, "--model"), "opus");
	assert.equal(valueOf(run.argv, "--effort"), "high");
	assert.equal(run.prompt, "rename x");
	assert.equal(appendedEntries, before + 1);
	// ultracode runs on claude and nowhere else, whether or not the call says so.
	const ultracode = await invoke("fusion", { role: "ultracode", task: "do a thing", backend: "claude" });
	assert.equal(valueOf(ultracode.argv, "--effort"), "ultracode");
	await assert.rejects(byName("fusion").execute("call-1", { role: "ultracode", task: "x", backend: "pi" }, undefined, undefined, ctx), {
		message: "role ultracode does not run on the pi backend; use one of claude",
	});
	// Security's disabled flag wins over a backend override; the compatibility tool still refuses the role by name.
	await assert.rejects(byName("fusion").execute("call-1", { role: "security", task: "x", backend: "claude" }, undefined, undefined, ctx), {
		message: "role security is disabled in profile builtin; change /fusion config or select another profile",
	});
	await assert.rejects(byName("claude").execute("call-1", { role: "security", task: "x" }, undefined, undefined, ctx), {
		message: "unknown role security; use one of plan, implement, ultracode, ask",
	});
});

test("role implement takes a direct task and records its run in the host session", async () => {
	const before = appendedEntries;
	const run = await invoke("claude", { role: "implement", task: "rename x", context: "asked directly" });
	assertCommon(run, "implement.md");
	assert.equal(run.prompt, "rename x\n\n## Context\nasked directly");
	assert.equal(appendedEntries, before + 1, "every run records its handle so the host can continue it");
});

test("a marked pi child registers nothing at all, and any other value registers the ordinary surface", () => {
	/** What one call of the extension registered, whatever it registered it with. */
	const registered = (marker: string | undefined) => {
		const seen = { tools: [] as string[], commands: [] as string[], events: [] as string[], renderers: [] as string[], entries: 0 };
		const recorder = {
			registerTool: (tool: { name: string }) => seen.tools.push(tool.name),
			registerCommand: (name: string) => seen.commands.push(name),
			on: (event: string) => seen.events.push(event),
			appendEntry: () => {
				seen.entries++;
			},
			registerMessageRenderer: (customType: string) => seen.renderers.push(customType),
		} as unknown as ExtensionAPI;
		const before = process.env[PI_CHILD_VARIABLE];
		if (marker === undefined) delete process.env[PI_CHILD_VARIABLE];
		else process.env[PI_CHILD_VARIABLE] = marker;
		try {
			// What is registered is what this case reads, so the tripwires stand in for pi and codex here too: nothing
			// below runs a call, and a registration that took the production one would still be one more of them.
			fusion(recorder, { backends: { ...tripwires() }, profiles: memoryProfileStore(), settings: memorySettingsStore() });
		} finally {
			if (before === undefined) delete process.env[PI_CHILD_VARIABLE];
			else process.env[PI_CHILD_VARIABLE] = before;
		}
		return seen;
	};
	const host = registered(undefined);
	assert.ok(host.tools.length && host.commands.length && host.events.length && host.renderers.length, "an unmarked host registers the tools, the command, the handlers and the renderer");
	// The marker `piLaunch` sets, read from the module that sets it: nothing is registered and nothing is thrown, which
	// is what a child needs — a throw here would fail the child's own startup instead of leaving it its role's tools.
	assert.deepEqual(registered(PI_CHILD_MARKER), { tools: [], commands: [], events: [], renderers: [], entries: 0 });
	for (const marker of ["", "1", "claude", "PI", "pi ", "0"]) {
		assert.deepEqual(registered(marker), host, `marker ${JSON.stringify(marker)} changed what the extension registers, and only the pi marker means anything`);
	}
});

test("the loader refuses a child, a missing contract and a missing bootstrap in that order, before it builds the pi backend", () => {
	// A static read of the source and no more. It says the four are written in this order; it does not run the loader
	// with a file missing, and nothing in this suite removes a contract or the bootstrap from this repository to watch
	// one throw. A smoke of a real install with one of them gone stays a manual check.
	// The third of them is only reachable because no module of this host imports the program a child runs, which is
	// `test/backends.test.ts`'s own static read: while one did, an install missing that program failed as node's module
	// error at import time instead of here. A missing source of this host's own still fails that way, and the two
	// constants the transport shares with a child are in one of them, `backends/pi-bootstrap-protocol.mjs`.
	const source = fs.readFileSync(path.join(repoRoot, "extensions", "fusion.ts"), "utf8");
	const MISSING_BOOTSTRAP = "throw new Error(`pi-fusion: missing pi bootstrap ${PI_BOOTSTRAP_PATH}`)";
	const steps = [
		["the child marker guard", 'if (process.env.PI_FUSION_CHILD === "pi") return;'],
		["the contract validation", "if (!fs.existsSync(contract)) throw new Error(`pi-fusion: missing contract ${contract}`);"],
		["the bootstrap validation", `if (!fs.existsSync(PI_BOOTSTRAP_PATH)) ${MISSING_BOOTSTRAP};`],
		["the pi backend registration", "hostBackend(createPiBackend())"],
	] as const;
	const found = steps.map(([what, snippet]) => {
		const at = source.indexOf(snippet);
		assert.notEqual(at, -1, `${what} is no longer written in extensions/fusion.ts as ${snippet}`);
		return [what, at] as const;
	});
	for (const [index, [what, at]] of found.entries()) {
		if (index === 0) continue;
		const [earlier, position] = found[index - 1]!;
		assert.ok(position < at, `${what} is written before ${earlier}, and each of these must refuse a broken install before the next one costs anything`);
	}
	assert.equal(source.split(MISSING_BOOTSTRAP).length - 1, 1, "the missing-bootstrap refusal must be written in exactly one place, or one of them can drift");
});

test("the load-time contract check covers every backend's shared role contracts and the pi-only security contract", () => {
	// What the loader adds to the claude roles' own contracts is the binding's own list, so a contract only a pi role
	// names is checked at load for the same reason: it is a broken install whichever backend would have run it. The
	// loader is read here rather than run with a file gone, as the order case above reads it.
	assert.deepEqual([...PI_CONTRACT_FILES].sort(), ["ask-answer.md", "ask-review.md", "implement.md", "plan.md", "security.md"]);
	for (const role of PI_ROLE_NAMES) {
		const bound = piRole({ role, model: "deepseek/deepseek-chat" }, undefined, {} as NodeJS.ProcessEnv);
		assert.ok(PI_CONTRACT_FILES.includes(bound.contract), `the loader never checks the contract role ${role} runs under: ${bound.contract}`);
	}
	for (const name of PI_CONTRACT_FILES) assert.ok(fs.existsSync(path.join(repoRoot, "contracts", name)), `this install ships no contracts/${name}`);
	// Codex names only the shared contracts; questions are an admission requirement, not a prompt-level fallback.
	assert.deepEqual([...CODEX_CONTRACT_FILES].sort(), ["ask-answer.md", "ask-review.md", "implement.md", "plan.md"]);
	for (const role of CODEX_ROLE_NAMES) {
		for (const mode of role === "ask" ? CODEX_MODES : [undefined]) {
			const bound = codexRole({ role, ...(mode === undefined ? {} : { mode }) }, undefined, {} as NodeJS.ProcessEnv);
			assert.ok(CODEX_CONTRACT_FILES.includes(bound.contract), `the loader never checks the contract role ${role} runs under on codex: ${bound.contract}`);
			assert.equal("addendum" in bound, false, "no backend-specific question instructions are injected");
		}
	}
	for (const name of CODEX_CONTRACT_FILES) assert.ok(fs.existsSync(path.join(repoRoot, "contracts", name)), `this install ships no contracts/${name}`);
	const source = fs.readFileSync(path.join(repoRoot, "extensions", "fusion.ts"), "utf8");
	const check = "new Set([...Object.values(ROLES).map((role) => role.contract), ...Object.values(ASK_CONTRACTS), ...PI_CONTRACT_FILES, ...CODEX_CONTRACT_FILES])";
	assert.ok(source.includes(check), "the load-time check no longer reads the pi and codex bindings' own contracts beside the claude roles'");
	// After the internal child's early return, so a pi child registers nothing before any contract is read.
	assert.ok(source.indexOf('if (process.env.PI_FUSION_CHILD === "pi") return;') < source.indexOf(check), "the contract check is written before the internal child guard, which must return first");
});

test("the security contract scopes one investigation, says where the authorization to fix comes from, and fixes its sections", () => {
	const text = fs.readFileSync(path.join(repoRoot, "contracts", "security.md"), "utf8");
	// The exact sections, in this order: a reader of a security report has to find the evidence under each finding.
	const headings = ["## Findings", "## Evidence", "## Changed", "## Verification", "## Unresolved", "## Escalation"];
	let at = -1;
	for (const heading of headings) {
		const found = text.indexOf(`\n${heading}\n`);
		assert.ok(found > at, `${heading} is missing from contracts/security.md or written out of order`);
		at = found;
	}
	assert.match(text, /^## Findings$/m);
	assert.match(text, /The task says whether fixes are authorized/);
	assert.match(text, /reports findings and changes no application code|report what you found and change no application code/);
	assert.match(text, /ask_orchestrator/, "an ambiguous authorization is a question for the orchestrator, not a guess");
	assert.match(text, /severity — high, medium or low — and say whether it is confirmed or inferred/);
	assert.match(text, /Confirm a finding where you can/);
	assert.match(text, /Never put a secret in your report by value/);
	assert.match(text, /`path:line`/);
	assert.match(text, /Do not commit/);
	assert.match(text, /do not widen the task/);
	assert.match(text, /Verify every change you make/);
	assert.match(text, /^## Escalation$/m);
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
	for (const name of ["plan.md", "implement.md", "ultracode.md", "ask-answer.md", "ask-review.md", "security.md"]) {
		assert.ok(!/multi-file|one small task/i.test(contract(name)), `${name} still routes by file count`);
		assert.ok(!/fable_consolidate|opus_implement|fable_implement|workhorse|consolidator/.test(contract(name)), `${name} still uses an old name`);
	}
});

test("the common contracts read as prose any backend's child can run, and say the same things they said", () => {
	const contract = (name: string) => fs.readFileSync(path.join(repoRoot, "contracts", name), "utf8");
	// `security.md` is in this list though only the pi binding names it: it is prose about the job and not about a
	// harness, so the day another backend runs the role it needs no rewrite.
	const common = ["plan.md", "implement.md", "ask-answer.md", "ask-review.md", "security.md"];
	for (const name of common) {
		const text = contract(name);
		// A vendor, a model or a harness's own tool name: a Pi child runs this prose too, and none of these mean
		// anything to it. `contracts/ultracode.md` is Claude's alone and is not in this list.
		for (const named of [/Claude/i, /\bOpus\b/i, /\bFable\b/i, /\bAstra\b/i, /\bGPT/i, /\bGlob\b/, /WebSearch/, /WebFetch/, /AskUserQuestion/]) {
			assert.ok(!named.test(text), `${name} still names ${named.source}`);
		}
		assert.match(text, /ask_orchestrator/, `${name} no longer says how a child asks its question`);
	}
	// What replaced a named tool still names a capability, so no rule lost the thing it was about. `implement.md` is
	// not in this list: it never named a tool, and it still verifies with the commands the task names.
	for (const name of ["plan.md", "ask-answer.md", "ask-review.md"]) {
		assert.match(contract(name), /your (shell|search|file-editing) tools?/, `${name} names no tool a child of any backend has`);
	}
	// The rules each contract is relied on for, kept word for word where a caller or a test reads them.
	assert.match(contract("plan.md"), /Do not implement the plan and do not change the project's source, tests or configuration/);
	assert.match(contract("plan.md"), /scratch files/, "the plan contract still bounds what it may write");
	assert.match(contract("implement.md"), /Stay inside the task's scope/);
	assert.match(contract("implement.md"), /Do not commit\./);
	assert.match(contract("implement.md"), /project's conventions and its agent instruction files/, "the implement contract still points at the project's own rules");
	assert.match(contract("implement.md"), /start another coding session/, "the implement contract still refuses to start another session of its own");
	for (const name of ["ask-answer.md", "ask-review.md"]) {
		assert.match(contract(name), /Do not change files\. Do not use your shell tool to write, move or delete files, to change git state, to install packages or to start anything that keeps running\./, `${name} weakened its read-only rule`);
	}
	assert.match(contract("ask-answer.md"), /name the source/, "the answer contract still requires a source for a fact from outside the project");
	assert.match(contract("ask-review.md"), /`git diff`, `git log`, the tests, a build or a type check/);
	assert.match(contract("ultracode.md"), /AskUserQuestion/, "role ultracode is Claude's own and keeps the tool names it runs with");
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
 * that closing destroyed proves nothing about the port, so the probe opens its own connection every time and reads
 * the code the kernel gives it.
 */
async function refused(target: string): Promise<string> {
	return new Promise<string>((resolve) => {
		const request = http.get(target, { agent: false }, (response) => {
			response.resume();
			resolve("answered");
		});
		request.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
	});
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
	assert.equal(await refused(`${url}api/runs`), "answered", "the refusal probe must answer a live listener, or ECONNREFUSED proves nothing");
	const shutdown = handlers.get("session_shutdown");
	assert.ok(shutdown, "no session_shutdown handler is registered");
	await shutdown({ reason: "quit" }, ctx);
	assert.equal(await refused(`${url}api/runs`), "ECONNREFUSED");
	await shutdown({ reason: "reload" }, ctx);
});

test("bare /fusion also shows status, while invalid arguments only warn about usage", async () => {
	const usage =
		"Usage: /fusion dashboard | /fusion dashboard stop | /fusion dashboard limit [N] | /fusion status [run-N] | /fusion cancel run-N | /fusion wait run-N | /fusion steer run-N <text> | /fusion answer [run-N] [text] | /fusion review run-N | /fusion on | /fusion off | /fusion config | /fusion profile [list | use <name> | save <name> | default <name>] | /fusion history [on | off]";
	for (const args of ["", "   "]) {
		const notices = await runCommand(args);
		assert.equal(notices.length, 2, `for ${JSON.stringify(args)}`);
		assert.deepEqual(notices[0], { message: usage, type: "warning" });
		assert.equal(notices[1]!.type, "info");
		assert.match(notices[1]!.message, /^fusion: on\nprofile: builtin\n/);
	}
	for (const args of ["dashboard start", "status foo", "cancel", "steer run-1", "config now"]) {
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
