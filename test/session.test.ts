import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fusion, { nextSession, runRecords } from "../extensions/fusion.ts";
import { planContextPct, planProblems } from "../extensions/handoff.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_FUSION_CLAUDE_BIN = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.FAKE_CLAUDE_SCENARIO = "read";

const tempDirs: string[] = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Tool {
	name: string;
	execute: (toolCallId: string, params: any, signal: undefined, onUpdate: undefined, ctx: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface Command {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface Extension {
	tools: Map<string, Tool>;
	commands: Map<string, Command>;
	handlers: Map<string, (event: any, ctx: any) => Promise<void> | void>;
	appended: Array<[string, any]>;
}

function makeExtension(): Extension {
	const ext: Extension = { tools: new Map(), commands: new Map(), handlers: new Map(), appended: [] };
	const api = {
		registerTool: (tool: Tool) => {
			ext.tools.set(tool.name, tool);
		},
		registerCommand: (name: string, options: Command) => {
			ext.commands.set(name, options);
		},
		on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
			ext.handlers.set(event, handler);
		},
		appendEntry: (customType: string, data: unknown) => {
			ext.appended.push([customType, data]);
		},
		registerMessageRenderer: () => {},
	} as unknown as ExtensionAPI;
	fusion(api);
	return ext;
}

function makeCtx(options: { sessionId?: string; branch?: unknown[] }) {
	const branch = options.branch ?? [];
	const id = options.sessionId ?? "host-1";
	return {
		cwd: repoRoot,
		ui: { setStatus() {} },
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => id,
			getBranch: () => branch,
		},
	};
}

async function invoke(ext: Extension, params: Record<string, unknown>, ctx: any): Promise<{ argv: string[]; prompt?: string; text?: string; error?: string }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-argv-"));
	tempDirs.push(dir);
	const out = path.join(dir, "argv.json");
	process.env.FAKE_CLAUDE_ARGV_OUT = out;
	try {
		const tool = ext.tools.get("claude");
		assert.ok(tool, "claude not registered");
		let text: string | undefined;
		let error: string | undefined;
		try {
			text = (await tool.execute("call-1", params, undefined, undefined, ctx)).content[0]!.text;
		} catch (err) {
			error = (err as Error).message;
		}
		const written = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, "utf8")) as { argv: string[]; prompt?: string }) : undefined;
		return { argv: written?.argv ?? [], ...(written?.prompt === undefined ? {} : { prompt: written.prompt }), text, error };
	} finally {
		delete process.env.FAKE_CLAUDE_ARGV_OUT;
	}
}

function valueOf(argv: string[], flag: string): string | undefined {
	const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
	if (inline) return inline.slice(flag.length + 1);
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function entry(data: Record<string, unknown>) {
	return { type: "custom", customType: "pi-fusion", data };
}

const recorded = (run: string, role: string, sessionId: string | undefined, hostSessionId: string, checkpoint?: string) => ({
	run,
	role,
	hostSessionId,
	...(sessionId ? { sessionId } : {}),
	...(checkpoint ? { checkpoint } : {}),
});

const legacy = (generation: number, sessionId: string, hostSessionId: string, checkpoint?: string) => ({
	consolidatorGeneration: generation,
	consolidatorSessionId: sessionId,
	hostSessionId,
	...(checkpoint ? { consolidatorCheckpoint: checkpoint } : {}),
});

const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The `read` scenario's last assistant message: a tool call, then the text "done". */
const CHECKPOINT = "asst-2";

async function withScenario<T>(scenario: string, body: () => Promise<T>): Promise<T> {
	process.env.FAKE_CLAUDE_SCENARIO = scenario;
	try {
		return await body();
	} finally {
		process.env.FAKE_CLAUDE_SCENARIO = "read";
	}
}

test("the first plan call starts run-1 in a new session and records it once Claude Code reports it", async () => {
	const ext = makeExtension();
	const { argv, text } = await invoke(ext, { role: "plan", task: "goal and plan" }, makeCtx({}));
	const id = valueOf(argv, "--session-id");
	assert.match(id ?? "", UUID);
	assert.equal(valueOf(argv, "--resume"), undefined);
	assert.equal(valueOf(argv, "--resume-session-at"), undefined);
	assert.ok(!argv.includes("--fork-session"));
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-1", "plan", id, "host-1", CHECKPOINT)]]);
	assert.match(text ?? "", /\[run-1 · plan · /);
	assert.match(text ?? "", new RegExp(`claude --resume ${id}\\]$`));
});

test("a later plan call resumes the last plan run at its checkpoint and records the new one", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "plan", S1, "host-1", "ckpt-1"))];
	const { argv, text } = await invoke(ext, { role: "plan", task: "follow-up" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-1");
	assert.equal(valueOf(argv, "--session-id"), undefined);
	assert.ok(!argv.includes("--fork-session"));
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-1", "plan", S1, "host-1", CHECKPOINT)]]);
	assert.match(text ?? "", /\[run-1 · plan · /);
});

test("an entry without a checkpoint resumes the whole session and records a checkpoint", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "plan", S1, "host-1"))];
	const { argv } = await invoke(ext, { role: "plan", task: "follow-up" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(valueOf(argv, "--resume-session-at"), undefined);
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-1", "plan", S1, "host-1", CHECKPOINT)]]);
});

test("a failed call in a recorded session records nothing, so the next call continues from before it", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "plan", S1, "host-1", "ckpt-1"))];
	await withScenario("error", async () => {
		const { argv, error } = await invoke(ext, { role: "plan", task: "follow-up" }, makeCtx({ branch }));
		assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-1");
		assert.match(error ?? "", /plan model error: boom/);
		assert.match(error ?? "", /\[run-1 · plan · /);
		assert.deepEqual(ext.appended, []);
	});
});

test("fresh starts a new plan run with the next handle", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "plan", S1, "host-1")), entry(recorded("run-2", "implement", S2, "host-1"))];
	const { argv } = await invoke(ext, { role: "plan", task: "new topic", fresh: true }, makeCtx({ branch }));
	const id = valueOf(argv, "--session-id");
	assert.match(id ?? "", UUID);
	assert.notEqual(id, S1);
	assert.equal(valueOf(argv, "--resume"), undefined);
	assert.equal(valueOf(argv, "--resume-session-at"), undefined);
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-3", "plan", id, "host-1", CHECKPOINT)]]);
});

test("another host session, which is what a fork is, gets its own fork of the recorded session under the same handle", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "plan", S1, "parent-host", "ckpt-1"))];
	const { argv } = await invoke(ext, { role: "plan", task: "follow-up in the fork" }, makeCtx({ sessionId: "forked-host", branch }));
	const id = valueOf(argv, "--session-id");
	assert.match(id ?? "", UUID);
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-1");
	assert.ok(argv.includes("--fork-session"));
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-1", "plan", id, "forked-host", CHECKPOINT)]]);
});

test("a fork that fails after Claude Code reports it is recorded with the checkpoint it forked at", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "plan", S1, "parent-host", "ckpt-1"))];
	await withScenario("error", async () => {
		const { argv, error } = await invoke(ext, { role: "plan", task: "follow-up in the fork" }, makeCtx({ sessionId: "forked-host", branch }));
		const id = valueOf(argv, "--session-id");
		assert.match(error ?? "", /plan model error: boom/);
		assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-1", "plan", id, "forked-host", "ckpt-1")]]);
	});
});

test("a plan call continues the plan run with the last entry on the branch, whatever runs came after it", async () => {
	const ext = makeExtension();
	const branch = [
		entry(recorded("run-2", "plan", S2, "host-1", "ckpt-b")),
		entry(recorded("run-1", "plan", S1, "host-1", "ckpt-a")),
		entry(recorded("run-3", "implement", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "host-1", "ckpt-c")),
	];
	const { argv } = await invoke(ext, { role: "plan", task: "follow-up" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-a");
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-1", "plan", S1, "host-1", CHECKPOINT)]]);
});

test("entries from before handles existed read as plan runs, one handle per generation", async () => {
	const ext = makeExtension();
	const branch = [entry(legacy(0, S1, "host-1", "ckpt-a")), entry(legacy(1, S2, "host-1", "ckpt-b"))];
	const { argv } = await invoke(ext, { role: "plan", task: "after upgrade" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S2);
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-b");
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-2", "plan", S2, "host-1", CHECKPOINT)]]);

	const older = await invoke(makeExtension(), { continue: "run-1", task: "back to the first plan" }, makeCtx({ branch }));
	assert.equal(valueOf(older.argv, "--resume"), S1);
	assert.equal(valueOf(older.argv, "--resume-session-at"), "ckpt-a");
});

test("an entry from before sessions were recorded keeps its handle and starts a new session", async () => {
	const ext = makeExtension();
	const { argv } = await invoke(ext, { role: "plan", task: "after upgrade" }, makeCtx({ branch: [entry({ consolidatorGeneration: 2 })] }));
	const id = valueOf(argv, "--session-id");
	assert.match(id ?? "", UUID);
	assert.equal(valueOf(argv, "--resume"), undefined);
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-3", "plan", id, "host-1", CHECKPOINT)]]);
});

test("a new run that fails before its session exists keeps its handle, and the next plan call starts its session", async () => {
	const ext = makeExtension();
	const branch: unknown[] = [entry(recorded("run-1", "plan", S1, "host-1", "ckpt-1"))];
	await withScenario("no-init-exit1", async () => {
		const { error } = await invoke(ext, { role: "plan", task: "goal", fresh: true }, makeCtx({ branch }));
		assert.match(error ?? "", /plan exited 1: Not logged in/);
		assert.match(error ?? "", /\[run-2 · plan · /);
		assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-2", "plan", undefined, "host-1")]]);
	});
	branch.push(entry(ext.appended[0]![1]));
	const next = await invoke(makeExtension(), { role: "plan", task: "goal again" }, makeCtx({ branch }));
	assert.match(valueOf(next.argv, "--session-id") ?? "", UUID);
	assert.equal(valueOf(next.argv, "--resume"), undefined);
});

test("implement and ultracode calls without continue start a new run with the next handle", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "plan", S1, "host-1", "ckpt-1")), entry(recorded("run-2", "implement", S2, "host-1", "ckpt-2"))];
	const { argv, text } = await invoke(ext, { role: "implement", task: "task 1" }, makeCtx({ branch }));
	const id = valueOf(argv, "--session-id");
	assert.match(id ?? "", UUID);
	assert.equal(valueOf(argv, "--resume"), undefined);
	assert.match(text ?? "", /\[run-3 · implement · /);
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-3", "implement", id, "host-1", CHECKPOINT)]]);
});

test("continue after a successful run resumes it at its checkpoint and takes its role", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "implement", S1, "host-1", "ckpt-1"))];
	const { argv, text } = await invoke(ext, { continue: "run-1", task: "the test still fails, fix it" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-1");
	assert.ok(!argv.includes("--fork-session"));
	assert.equal(valueOf(argv, "--model"), "opus");
	assert.match(text ?? "", /\[run-1 · implement · /);
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-1", "implement", S1, "host-1", CHECKPOINT)]]);
});

test("continue after a failed run resumes from its last good checkpoint", async () => {
	const ext = makeExtension();
	const branch: unknown[] = [entry(recorded("run-1", "implement", S1, "host-1", "ckpt-1"))];
	await withScenario("error", async () => {
		const { error } = await invoke(ext, { continue: "run-1", task: "try again" }, makeCtx({ branch }));
		assert.match(error ?? "", /implement model error: boom/);
	});
	assert.deepEqual(ext.appended, []);
	const { argv } = await invoke(makeExtension(), { continue: "run-1", task: "try again" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-1");
});

test("continue after /tree to an older branch resumes at the checkpoint that branch recorded", async () => {
	const older = [entry(recorded("run-1", "implement", S1, "host-1", "ckpt-1"))];
	const newer = [...older, entry(recorded("run-1", "implement", S1, "host-1", "ckpt-2"))];
	const onNewer = await invoke(makeExtension(), { continue: "run-1", task: "next" }, makeCtx({ branch: newer }));
	assert.equal(valueOf(onNewer.argv, "--resume-session-at"), "ckpt-2");
	const onOlder = await invoke(makeExtension(), { continue: "run-1", task: "next" }, makeCtx({ branch: older }));
	assert.equal(valueOf(onOlder.argv, "--resume-session-at"), "ckpt-1");
});

test("the first continue in a forked host forks the run's session and records the fork under the same handle", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-2", "ultracode", S1, "parent-host", "ckpt-1"))];
	const { argv } = await invoke(ext, { continue: "run-2", task: "follow-up in the fork" }, makeCtx({ sessionId: "forked-host", branch }));
	const id = valueOf(argv, "--session-id");
	assert.match(id ?? "", UUID);
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-1");
	assert.ok(argv.includes("--fork-session"));
	assert.equal(valueOf(argv, "--effort"), "ultracode");
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-2", "ultracode", id, "forked-host", CHECKPOINT)]]);
});

test("continue on a plan handle goes back to that older plan run", async () => {
	const ext = makeExtension();
	const branch = [entry(recorded("run-1", "plan", S1, "host-1", "ckpt-1")), entry(recorded("run-2", "plan", S2, "host-1", "ckpt-2"))];
	const { argv } = await invoke(ext, { role: "plan", continue: "run-1", task: "revisit" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-1");
	assert.deepEqual(ext.appended, [["pi-fusion", recorded("run-1", "plan", S1, "host-1", CHECKPOINT)]]);
});

test("an ask run records its mode, and continue keeps it unless the call names another", async () => {
	const ext = makeExtension();
	const { argv } = await invoke(ext, { role: "ask", mode: "review", task: "review the diff" }, makeCtx({}));
	const id = valueOf(argv, "--session-id");
	assert.deepEqual(ext.appended, [["pi-fusion", { ...recorded("run-1", "ask", id, "host-1", CHECKPOINT), mode: "review" }]]);

	const branch = [entry({ ...recorded("run-1", "ask", S1, "host-1", "ckpt-1"), mode: "review" })];
	const kept = makeExtension();
	await invoke(kept, { continue: "run-1", task: "and the tests?" }, makeCtx({ branch }));
	assert.equal(kept.appended[0]![1].mode, "review");
	const changed = makeExtension();
	await invoke(changed, { continue: "run-1", mode: "answer", task: "why this design?" }, makeCtx({ branch }));
	assert.equal(changed.appended[0]![1].mode, "answer");
});

test("continue rejects an unknown handle, another role, fresh, and a parameter the run's role does not take", async () => {
	const branch = [entry(recorded("run-1", "implement", S1, "host-1", "ckpt-1")), entry(recorded("run-2", "ultracode", S2, "host-1", "ckpt-2"))];
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{ continue: "run-9", task: "x" }, /^unknown run run-9; the runs on this branch are run-1, run-2$/],
		[{ continue: "run-1", role: "plan", task: "x" }, /^run-1 has role implement; omit role or use implement$/],
		[{ continue: "run-1", fresh: true, task: "x" }, /^fresh is not allowed with continue$/],
		[{ continue: "run-2", effort: "high", task: "x" }, /^effort is not allowed for role ultracode$/],
		[{ task: "x" }, /^role is required unless continue is set$/],
	];
	for (const [params, expected] of cases) {
		const ext = makeExtension();
		const { argv, error } = await invoke(ext, params, makeCtx({ branch }));
		assert.match(error ?? "", expected);
		assert.deepEqual(argv, [], "no child starts");
		assert.deepEqual(ext.appended, []);
	}
	const { error } = await invoke(makeExtension(), { continue: "run-1", task: "x" }, makeCtx({}));
	assert.match(error ?? "", /^unknown run run-1; the runs on this branch are none$/);
});

test("runRecords keeps the last entry per handle, the last plan run and the highest handle", () => {
	assert.deepEqual(runRecords([]), { runs: new Map(), highest: 0 });
	const records = runRecords([
		{ type: "message" },
		entry(legacy(0, "s-0", "h-1", "c-0")),
		entry(recorded("run-4", "implement", "s-4", "h-1", "c-4")),
		entry(recorded("run-2", "plan", "s-2", "h-1")),
		entry(recorded("run-4", "implement", "s-4", "h-1", "c-5")),
		entry({ run: "job-1", role: "plan" }),
		entry({ run: "run-7", role: "nobody" }),
		{ type: "custom", customType: "other", data: recorded("run-9", "plan", "s-9", "h-1") },
	]);
	assert.equal(records.highest, 4);
	assert.equal(records.lastPlan, "run-2");
	assert.deepEqual([...records.runs.values()], [
		{ handle: "run-1", role: "plan", sessionId: "s-0", hostSessionId: "h-1", checkpoint: "c-0" },
		{ handle: "run-4", role: "implement", sessionId: "s-4", hostSessionId: "h-1", checkpoint: "c-5" },
		{ handle: "run-2", role: "plan", sessionId: "s-2", hostSessionId: "h-1" },
	]);
});

test("nextSession picks new, resume or fork", () => {
	assert.equal(nextSession(undefined, "h-1").kind, "new");
	assert.equal(nextSession({ handle: "run-1", role: "plan", hostSessionId: "h-1" }, "h-1").kind, "new");
	assert.deepEqual(nextSession({ handle: "run-1", role: "plan", sessionId: "s-1", hostSessionId: "h-1" }, "h-1"), { kind: "resume", id: "s-1" });
	assert.deepEqual(nextSession({ handle: "run-1", role: "plan", sessionId: "s-1", hostSessionId: "h-1", checkpoint: "c-1" }, "h-1"), {
		kind: "resume",
		id: "s-1",
		at: "c-1",
	});
	const other = nextSession({ handle: "run-1", role: "plan", sessionId: "s-1", hostSessionId: "h-1", checkpoint: "c-1" }, "h-2");
	assert.equal(other.kind, "fork");
	assert.equal((other as { from: string }).from, "s-1");
	assert.equal((other as { at?: string }).at, "c-1");
	assert.match(other.id, UUID);
});

test("a plan call continues the plan run while its recorded context stays under the cap", async () => {
	const ext = makeExtension();
	const branch = [entry({ ...recorded("run-1", "plan", S1, "host-1", "ckpt-1"), contextTokens: 340_000, contextWindow: 1_000_000 })];
	const { argv, text } = await invoke(ext, { role: "plan", task: "follow-up" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(valueOf(argv, "--resume-session-at"), "ckpt-1");
	assert.doesNotMatch(text ?? "", /fresh plan run/);
});

test("a plan call whose plan run has passed the cap starts a fresh run that carries its last report", async () => {
	const ext = makeExtension();
	const first = await withScenario("big-context", () => invoke(ext, { role: "plan", task: "the goal" }, makeCtx({})));
	const [type, data] = ext.appended[0] as [string, Record<string, unknown>];
	assert.equal(type, "pi-fusion");
	assert.equal(data.contextTokens, 400_000);
	assert.equal(data.contextWindow, 1_000_000);
	assert.match(first.text ?? "", /context 400\.0k\/1\.00M \(40%\)/);

	const { argv, prompt, text } = await invoke(ext, { role: "plan", task: "next question" }, makeCtx({ branch: [entry(data)] }));
	assert.equal(valueOf(argv, "--resume"), undefined, "the fresh run does not resume the run it replaces");
	assert.match(valueOf(argv, "--session-id") ?? "", UUID);
	assert.match(prompt ?? "", /^next question\n\n## The plan so far\n/);
	assert.match(prompt ?? "", /<earlier-plan>\n## Agreed plan\n1\. rename the field\n<\/earlier-plan>$/);
	assert.match(text ?? "", /^run-2 is a fresh plan run: run-1's context had reached 40% of its window/);
	assert.match(text ?? "", /continue run-1/);
	assert.equal((ext.appended[1] as [string, Record<string, unknown>])[1].run, "run-2");
});

test("a plan call that must hand off and has no report to carry says what the host can do instead", async () => {
	const ext = makeExtension();
	const branch = [entry({ ...recorded("run-1", "plan", S1, "host-1", "ckpt-1"), contextTokens: 400_000, contextWindow: 1_000_000 })];
	const { error } = await invoke(ext, { role: "plan", task: "follow-up" }, makeCtx({ branch }));
	assert.match(error ?? "", /run-1's context has reached 40% of its window/);
	assert.match(error ?? "", /fresh true/);
	assert.deepEqual(ext.appended, []);
});

test("continue goes back to a plan run the cap would hand off, because the host asked for it by handle", async () => {
	const ext = makeExtension();
	const branch = [entry({ ...recorded("run-1", "plan", S1, "host-1", "ckpt-1"), contextTokens: 400_000, contextWindow: 1_000_000 })];
	const { argv, prompt } = await invoke(ext, { continue: "run-1", task: "follow-up" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S1);
	assert.equal(prompt, "follow-up");
});

test("PI_FUSION_PLAN_CONTEXT_PCT sets the cap, and 0 turns the handoff off", async () => {
	assert.equal(planContextPct({ PI_FUSION_PLAN_CONTEXT_PCT: "20" } as NodeJS.ProcessEnv), 20);
	assert.equal(planContextPct({} as NodeJS.ProcessEnv), 35);
	assert.equal(planContextPct({ PI_FUSION_PLAN_CONTEXT_PCT: "35%" } as NodeJS.ProcessEnv), 35, "a value the cap cannot use reads as the default");
	assert.match(planProblems({ PI_FUSION_PLAN_CONTEXT_PCT: "35%" } as NodeJS.ProcessEnv)[0] ?? "", /is not a percentage/);
	assert.deepEqual(planProblems({ PI_FUSION_PLAN_CONTEXT_PCT: "0" } as NodeJS.ProcessEnv), []);

	process.env.PI_FUSION_PLAN_CONTEXT_PCT = "0";
	try {
		const ext = makeExtension();
		const branch = [entry({ ...recorded("run-1", "plan", S1, "host-1", "ckpt-1"), contextTokens: 900_000, contextWindow: 1_000_000 })];
		const { argv } = await invoke(ext, { role: "plan", task: "follow-up" }, makeCtx({ branch }));
		assert.equal(valueOf(argv, "--resume"), S1, "the run is continued however large its context has grown");
	} finally {
		delete process.env.PI_FUSION_PLAN_CONTEXT_PCT;
	}
});

test("continuing a run past the cap still runs and says what a fresh run would cost instead", async () => {
	const ext = makeExtension();
	const branch = [entry({ ...recorded("run-1", "implement", S1, "host-1", "ckpt-1"), contextTokens: 500_000, contextWindow: 1_000_000 })];
	const { argv, text } = await invoke(ext, { continue: "run-1", task: "the test still fails" }, makeCtx({ branch }));
	assert.equal(valueOf(argv, "--resume"), S1, "the handle the host named is the run it gets");
	assert.match(text ?? "", /^run-1's context has reached 50% of its window, past the 35% cap/);
	assert.match(text ?? "", /the work so far is in the work tree/);
});

test("continuing a run under the cap says nothing about its context", async () => {
	const ext = makeExtension();
	const branch = [entry({ ...recorded("run-1", "implement", S1, "host-1", "ckpt-1"), contextTokens: 100_000, contextWindow: 1_000_000 })];
	const { text } = await invoke(ext, { continue: "run-1", task: "the test still fails" }, makeCtx({ branch }));
	assert.doesNotMatch(text ?? "", /cap/);
});
