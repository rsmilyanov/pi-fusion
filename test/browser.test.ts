import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type Dashboard, RunStore, startDashboard } from "../extensions/dashboard.ts";

/** Where a Chromium build sits when it was installed the usual way for the platform. */
const CHROME_PATHS: Record<string, readonly string[]> = {
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	],
	linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"],
	win32: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	],
};
/** The names a Chromium build goes by on PATH, tried when no install path matched. */
const CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge", "chrome"];

function onPath(name: string): string | undefined {
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const ext of exts) {
			const candidate = path.join(dir, name + ext);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			} catch {}
		}
	}
	return undefined;
}

/** PI_FUSION_CHROME wins, then this platform's install paths, then any Chromium name on PATH. */
function findChrome(): string | undefined {
	const named = process.env.PI_FUSION_CHROME?.trim();
	if (named) return fs.existsSync(named) ? named : undefined;
	for (const candidate of CHROME_PATHS[process.platform] ?? []) if (fs.existsSync(candidate)) return candidate;
	for (const name of CHROME_NAMES) {
		const found = onPath(name);
		if (found) return found;
	}
	return undefined;
}

const CHROME = findChrome();
const skip = CHROME ? false : "Chrome not found; set PI_FUSION_CHROME to a Chromium binary to run these tests";

const CWD = "/tmp/pi-fusion-browser";
const USAGE = { costUsd: 1.25, tokensIn: 1_200, tokensOut: 340, workflowTokens: 250, calls: 3, warnUsd: [1, 2], limitUsd: 5 };
const WIDTH = 1200;
const HEIGHT = 700;
const LAUNCH_MS = 15_000;
const COMMAND_MS = 10_000;
const DOM_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const TOOL_CALLS = 40;
const REPORT_LINES = 120;
const STDERR_TAIL = 8_192;

const READY = "document.readyState === 'complete' && !window.__stale ? 'ready' : document.readyState";
const RUN_BUTTONS = "document.querySelectorAll('.run').length";
const LOG_ROWS = "document.querySelectorAll('.log .log-row').length";
const DETAIL_TITLE = "(document.querySelector('.detail-title') || {}).textContent || ''";
const CWD_TEXT = "(document.getElementById('cwd') || {}).textContent || ''";
const USAGE_TEXT = "(document.getElementById('usage') || {}).textContent || ''";
const HAS_REPORT = "document.querySelector('.report') ? 'yes' : 'no'";
const HAS_LOG = "document.querySelector('.log') ? 'yes' : 'no'";
const HAS_FACTS = "document.querySelector('.facts') ? 'yes' : 'no'";
const LOG_SCROLL = "(document.querySelector('.log') || {}).scrollTop";
const REPORT_SCROLL = "(document.querySelector('.report') || {}).scrollTop";
const SELECTED_TAB = "(document.querySelector('.tab[aria-selected=\"true\"]') || {}).textContent || ''";
const VISIBLE_PANEL = "(document.querySelector('.panel:not(.hidden)') || { dataset: {} }).dataset.tab || ''";
const TAB = (label: string) => `Array.from(document.querySelectorAll('.tab')).find((node) => node.firstChild.textContent === ${JSON.stringify(label)})`;
const CLICK_TAB = (label: string) => `(() => { const tab = ${TAB(label)}; if (!tab) return 'missing'; tab.click(); return 'clicked'; })()`;
const TAB_BADGE = (label: string) => `(() => { const tab = ${TAB(label)}; const badge = tab && tab.querySelector('.badge'); return badge ? badge.textContent + (badge.classList.contains('badge-hot') ? '*' : '') : ''; })()`;
const PANEL = (tab: string) => `document.querySelector('.panel[data-tab="${tab}"]')`;
const PANEL_SCROLL = (tab: string) => `(${PANEL(tab)} || {}).scrollTop`;
const PANEL_OVERFLOW = (tab: string) => `(() => { const panel = ${PANEL(tab)}; return [panel.scrollHeight, panel.clientHeight]; })()`;
const SCROLL_THE_PANEL = (tab: string, top: string) => `(() => { const panel = ${PANEL(tab)}; panel.scrollTop = ${top}; return panel.scrollTop; })()`;
const SCROLL_THE_LOG = "(() => { const log = document.querySelector('.log'); log.scrollTop = 100; return log.scrollTop; })()";
const LOG_GAP = "(() => { const log = document.querySelector('.log'); return log.scrollHeight - log.clientHeight - log.scrollTop; })()";
const JUMP_TEXT = "(() => { const jump = document.querySelector('.log-jump'); return jump && !jump.classList.contains('hidden') ? jump.textContent : ''; })()";
const CLICK_JUMP = "(() => { document.querySelector('.log-jump').click(); return 'clicked'; })()";
const SCROLL_THE_REPORT = "(() => { const report = document.querySelector('.report'); report.scrollTop = 150; return report.scrollTop; })()";
const TOOL_CALLS_FACT =
	"(() => { const keys = Array.from(document.querySelectorAll('.facts .fact-key')); const key = keys.find((node) => node.textContent === 'Tool calls'); const value = key && key.nextElementSibling; return value ? value.textContent : ''; })()";
const CLICK_OLD =
	"(() => { const buttons = Array.from(document.querySelectorAll('.run')); const target = buttons.find((node) => node.querySelector('.run-role').textContent === 'fable'); if (!target) return 'missing'; target.click(); return 'clicked'; })()";
const CLICK_LIVE =
	"(() => { const buttons = Array.from(document.querySelectorAll('.run')); const target = buttons.find((node) => node.querySelector('.run-role').textContent === 'opus'); if (!target) return 'missing'; target.click(); return 'clicked'; })()";
const PROMPT_TEXT = "(document.querySelector('.prompt') || {}).textContent || ''";
const FACT_VALUE = (key: string) =>
	`(() => { const keys = Array.from(document.querySelectorAll('.facts .fact-key')); const found = keys.find((node) => node.textContent === ${JSON.stringify(key)}); return found ? found.nextElementSibling.textContent : ''; })()`;
const STYLE_PROOF =
	"(() => { const sidebar = document.querySelector('.sidebar'); return [document.styleSheets.length, getComputedStyle(sidebar).width]; })()";

interface Waiting {
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

class Cdp {
	private readonly socket: WebSocket;
	private readonly waiting = new Map<number, Waiting>();
	private next = 0;
	private broken: Error | undefined;

	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => this.receive(String((event as { data: unknown }).data)));
		socket.addEventListener("close", () => this.fail(new Error("the devtools socket closed")));
		socket.addEventListener("error", () => this.fail(new Error("the devtools socket failed")));
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			if (this.broken) {
				reject(this.broken);
				return;
			}
			const id = ++this.next;
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`${method} did not answer within ${COMMAND_MS}ms`));
			}, COMMAND_MS);
			timer.unref();
			this.waiting.set(id, { resolve, reject, timer });
			const message: Record<string, unknown> = { id, method, params };
			if (sessionId !== undefined) message.sessionId = sessionId;
			try {
				this.socket.send(JSON.stringify(message));
			} catch (error) {
				this.waiting.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		this.fail(new Error("the devtools socket was closed by the test"));
		try {
			this.socket.close();
		} catch {}
	}

	private receive(data: string): void {
		let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.waiting.get(message.id);
		if (!pending) return;
		this.waiting.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) pending.reject(new Error(`devtools refused the command: ${String(message.error.message)}`));
		else pending.resolve(message.result ?? {});
	}

	private fail(error: Error): void {
		this.broken ??= error;
		for (const pending of this.waiting.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.waiting.clear();
	}
}

interface Page {
	send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
	evaluate<T>(expression: string): Promise<T>;
	open(url: string): Promise<void>;
	until<T>(what: string, expression: string, ok: (value: T) => boolean, ms?: number): Promise<T>;
}

function makePage(cdp: Cdp, sessionId: string, redact: (text: string) => string): Page {
	const send = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);
	const evaluate = async <T>(expression: string): Promise<T> => {
		const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		const thrown = answer.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
		if (thrown) throw new Error(redact(`the page threw: ${thrown.exception?.description ?? thrown.text ?? "something"}`));
		return (answer.result as { value: T }).value;
	};
	const until = async <T>(what: string, expression: string, ok: (value: T) => boolean, ms = DOM_MS): Promise<T> => {
		const deadline = Date.now() + ms;
		let last = "nothing";
		for (;;) {
			try {
				const value = await evaluate<T>(expression);
				if (ok(value)) return value;
				last = redact(JSON.stringify(value) ?? String(value));
			} catch (error) {
				last = error instanceof Error ? error.message : String(error);
			}
			if (Date.now() > deadline) throw new Error(`${what}: gave up after ${ms}ms, last saw ${last}`);
			await delay(50);
		}
	};
	const open = async (url: string): Promise<void> => {
		await evaluate("window.__stale = true, 1").catch(() => undefined);
		await send("Page.navigate", { url });
		await until<string>("the page loads", READY, (value) => value === "ready", COMMAND_MS);
	};
	return { send, evaluate, open, until };
}

function report(): string {
	const lines = Array.from({ length: REPORT_LINES }, (_unused, i) => `line ${i + 1}: the child changed something in file-${i + 1}.ts`).join("\n");
	return `## Changed\n${lines}\n\n## Escalation\nNeeds a **decision** on \`store.ts\` <b>not bold</b>.\n\n- one\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |`;
}

function seed(store: RunStore): void {
	store.start({ id: "old", role: "fable", model: "fable-1", title: "consolidate the plan", prompt: "Goal: tidy the store.\nPlan: one step.", tool: "claude", toolCallId: "call-1", hostSessionId: "host-aaaaaaaa-1", contract: "contracts/plan.md", session: { kind: "resume", id: "sess-old", at: "msg-1" } });
	store.event("old", { type: "init", sessionId: "sess-old" });
	store.event("old", { type: "tool_call", name: "Agent", brief: "probe", id: "toolu_1", input: { description: "probe", prompt: "Find the store." } });
	store.event("old", { type: "task_started", taskId: "task-1", toolUseId: "toolu_1", taskType: "local_workflow", name: "probe", subagentType: "explore" });
	store.event("old", {
		type: "task_progress",
		taskId: "task-1",
		summary: "read the store",
		lastTool: "Read",
		tokens: 250,
		toolUses: 4,
		phase: "Probe",
		agents: [
			{ label: "a", state: "done" },
			{ label: "b", state: "start" },
		],
	});
	store.event("old", { type: "task_ended", taskId: "task-1", status: "completed", summary: "found it" });
	for (let i = 0; i < TOOL_CALLS; i++) store.event("old", { type: "tool_call", name: "Read", brief: `file-${i}.ts` });
	store.event("old", { type: "tool_call", name: "Bash", brief: "npm test", id: "tu-x", input: { command: "npm test" } });
	store.event("old", { type: "tool_result", toolUseId: "tu-x", text: "1 failing", isError: true });
	store.finish("old", {
		status: "done",
		text: report(),
		snapshot: {
			toolCalls: TOOL_CALLS,
			tokensIn: 1_200,
			tokensOut: 300,
			cacheRead: 900,
			cacheWrite: 100,
			costUsd: 0.25,
			contextTokens: 750_000,
			contextWindow: 1_000_000,
			models: [{ model: "claude-opus-5", inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 }],
			thinking: ["Check the store first."],
		},
		files: [
			{ path: "extensions/dashboard.ts", status: "M", added: 12, removed: 3 },
			{ path: "logo.png", status: "A" },
		],
	});
	store.start({ id: "live", role: "opus", model: "opus-4", tool: "claude", toolCallId: "call-2", hostSessionId: "host-aaaaaaaa-1", prompt: Array.from({ length: 60 }, (_unused, i) => `step ${i + 1}: keep the log pinned`).join("\n") });
	store.progress("live", { activity: "Bash npm test", toolCalls: TOOL_CALLS, tokensIn: 5, tokensOut: 1 });
	for (let i = 0; i < TOOL_CALLS; i++) store.event("live", { type: "tool_call", name: "Bash", brief: `step ${i}` });
}

function chromeArgs(profile: string): string[] {
	return [
		"--headless=new",
		"--remote-debugging-port=0",
		// A Chrome that runs as root, which is what a Linux container usually gives it, refuses to start its sandbox.
		...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-sync",
		"--disable-default-apps",
		`--window-size=${WIDTH},${HEIGHT}`,
		"about:blank",
	];
}

async function endpointOf(child: ChildProcess, profile: string, stderr: () => string): Promise<string> {
	const file = path.join(profile, "DevToolsActivePort");
	const deadline = Date.now() + LAUNCH_MS;
	for (;;) {
		try {
			const lines = fs.readFileSync(file, "utf8").split("\n");
			const port = Number(lines[0]);
			const target = (lines[1] ?? "").trim();
			if (Number.isInteger(port) && port > 0 && target.startsWith("/")) return `ws://127.0.0.1:${port}${target}`;
		} catch {}
		const listening = /DevTools listening on (ws:\/\/\S+)/.exec(stderr());
		if (listening) return listening[1]!;
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chrome exited (${child.exitCode}/${child.signalCode}) before it listened`);
		if (Date.now() > deadline) throw new Error(`Chrome reported no devtools endpoint within ${LAUNCH_MS}ms: ${stderr().slice(-400)}`);
		await delay(50);
	}
}

async function killChrome(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	const outcome = await Promise.race([exited.then(() => "exited"), delay(KILL_GRACE_MS, "alive", { ref: false })]);
	if (outcome === "exited") return;
	child.kill("SIGKILL");
	await Promise.race([exited, delay(KILL_GRACE_MS, undefined, { ref: false })]);
}

async function connect(url: string): Promise<Cdp> {
	const socket = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`the devtools socket did not open within ${COMMAND_MS}ms`)), COMMAND_MS);
		timer.unref();
		socket.addEventListener(
			"open",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
		socket.addEventListener(
			"error",
			() => {
				clearTimeout(timer);
				reject(new Error("the devtools socket failed to open"));
			},
			{ once: true },
		);
	});
	return new Cdp(socket);
}

interface Fixture {
	page: Page;
	store: RunStore;
	/** Moves the store's clock, so a run can look as if it started long ago. */
	shift(ms: number): number;
	url: string;
	slashless: string;
	token: string;
	stop(): Promise<void>;
}

async function launch(): Promise<Fixture> {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-chrome-"));
	let child: ChildProcess | undefined;
	let cdp: Cdp | undefined;
	let dashboard: Dashboard | undefined;
	const stop = async (): Promise<void> => {
		try {
			cdp?.close();
			if (child) await killChrome(child);
		} finally {
			fs.rmSync(profile, { recursive: true, force: true });
			if (dashboard) await dashboard.close();
		}
	};
	try {
		let clock = Date.now();
		const store = new RunStore(() => clock++);
		seed(store);
		dashboard = await startDashboard(store, { cwd: CWD, usage: () => USAGE });
		const token = dashboard.url.split("/")[3] ?? "";
		const redact = (text: string): string => (token ? text.split(token).join("<token>") : text);
		child = spawn(CHROME as string, chromeArgs(profile), { stdio: ["ignore", "ignore", "pipe"] });
		child.unref();
		child.on("error", () => {});
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_TAIL);
		});
		cdp = await connect(await endpointOf(child, profile, () => stderr));
		const target = await cdp.send("Target.createTarget", { url: "about:blank" });
		const attached = await cdp.send("Target.attachToTarget", { targetId: String(target.targetId), flatten: true });
		const page = makePage(cdp, String(attached.sessionId), redact);
		await page.send("Page.enable");
		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
		return { page, store, shift: (ms) => (clock += ms), url: dashboard.url, slashless: `http://127.0.0.1:${dashboard.port}/${token}`, token, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

let starting: Promise<Fixture> | undefined;

const fixture = (): Promise<Fixture> => (starting ??= launch());

after(async () => {
	const pending = starting;
	starting = undefined;
	if (!pending) return;
	const made = await pending.catch(() => undefined);
	if (made) await made.stop();
});

async function opened(): Promise<Fixture> {
	const made = await fixture();
	await made.page.open(made.url);
	await made.page.until<number>("both runs are listed", RUN_BUTTONS, (count) => count === 2);
	await made.page.until<string>("the first detail is rendered", HAS_FACTS, (has) => has === "yes");
	return made;
}

test("a live run's log opens at its bottom and follows new rows there", { skip }, async () => {
	const { page, store } = await opened();
	await page.until<string>("the running run is selected by default", DETAIL_TITLE, (title) => title === "opus");
	await page.until<number>("the live log is rendered", LOG_ROWS, (rows) => rows === TOOL_CALLS);
	assert.ok((await page.evaluate<number>(LOG_SCROLL)) > 0, "the log must overflow for this test to prove anything");
	assert.ok((await page.evaluate<number>(LOG_GAP)) < 2, "the log must open at its bottom");

	store.event("live", { type: "tool_call", name: "Read", brief: "x" });
	await page.until<number>("the new log row arrives", LOG_ROWS, (rows) => rows === TOOL_CALLS + 1);

	assert.ok((await page.evaluate<number>(LOG_GAP)) < 2, "a log at its bottom must stay there as rows arrive");
	assert.equal(await page.evaluate<string>(JUMP_TEXT), "", "a log at its bottom has nothing unseen");
});

test("a log scrolled up keeps its position, counts new rows and jumps to the bottom on request", { skip }, async () => {
	const { page, store } = await opened();
	await page.until<string>("the running run is selected by default", DETAIL_TITLE, (title) => title === "opus");
	await page.until<string>("the live log is rendered", HAS_LOG, (has) => has === "yes");
	const rows = await page.evaluate<number>(LOG_ROWS);
	const scrolled = await page.evaluate<number>(SCROLL_THE_LOG);
	assert.equal(scrolled, 100);

	store.event("live", { type: "tool_call", name: "Read", brief: "y" });
	store.event("live", { type: "tool_call", name: "Read", brief: "z" });
	await page.until<number>("the new log rows arrive", LOG_ROWS, (count) => count === rows + 2);

	assert.equal(await page.evaluate<number>(LOG_SCROLL), scrolled, "a live update must not move a log scrolled up");
	await page.until<string>("the unseen rows are counted", JUMP_TEXT, (text) => text === "2 new ↓");
	assert.equal(await page.evaluate<string>(CLICK_JUMP), "clicked");
	await page.until<number>("the log jumps to its bottom", LOG_GAP, (gap) => gap < 2);
	await page.until<string>("the count clears at the bottom", JUMP_TEXT, (text) => text === "");
});

test("a finished run's tabs keep their scroll across a progress update and across a tab switch", { skip }, async () => {
	const { page, store } = await opened();
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked", "the finished run must be in the sidebar");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	await page.until<string>("the report is rendered", HAS_REPORT, (has) => has === "yes");
	assert.equal(await page.evaluate<string>(SELECTED_TAB), "Report1", "a finished run with a report opens on Report, with its one badge counted");
	assert.equal(await page.evaluate<number>(SCROLL_THE_REPORT), 150, "the report must scroll");

	store.progress("old", { toolCalls: 3, tokensIn: 5, tokensOut: 1 });
	await page.until<string>("the new tool call count arrives", TOOL_CALLS_FACT, (value) => value === "3");
	assert.equal(await page.evaluate<number>(REPORT_SCROLL), 150, "a progress update must not scroll the report back to the top");

	assert.equal(await page.evaluate<string>(CLICK_TAB("Overview")), "clicked");
	const [scrollHeight, clientHeight] = await page.evaluate<[number, number]>(PANEL_OVERFLOW("overview"));
	assert.ok(scrollHeight > clientHeight, `the Overview tab must overflow ${WIDTH}x${HEIGHT} for this test to prove anything, got ${scrollHeight} in ${clientHeight}`);
	assert.equal(await page.evaluate<number>(SCROLL_THE_PANEL("overview", "200")), 200);

	store.progress("old", { toolCalls: 4, tokensIn: 5, tokensOut: 1 });
	await page.until<string>("the next tool call count arrives", TOOL_CALLS_FACT, (value) => value === "4");
	assert.equal(await page.evaluate<number>(PANEL_SCROLL("overview")), 200, "a progress update must not scroll the tab back to the top");

	assert.equal(await page.evaluate<string>(CLICK_TAB("Report")), "clicked");
	assert.equal(await page.evaluate<string>(VISIBLE_PANEL), "report");
	assert.equal(await page.evaluate<string>(CLICK_TAB("Overview")), "clicked");
	assert.equal(await page.evaluate<number>(PANEL_SCROLL("overview")), 200, "a tab keeps its scroll while another tab is shown");
});

const VIEWPORTS = [
	{ name: "desktop", width: WIDTH, height: HEIGHT, mobile: false },
	{ name: "mobile", width: 390, height: 844, mobile: true },
];
const REFRESHES = 3;

test("repeated live refreshes keep the log where the reader left it and count rows on a hidden Log tab", { skip }, async () => {
	const { page, store, shift } = await opened();
	const started = Date.now();
	try {
		for (const viewport of VIEWPORTS) {
			await page.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
			await page.open((await fixture()).url);
			await page.until<string>(`${viewport.name}: the running run is selected by default`, DETAIL_TITLE, (title) => title === "opus");
			await page.until<string>(`${viewport.name}: the live log is rendered`, HAS_LOG, (has) => has === "yes");
			assert.equal(await page.evaluate<string>(SELECTED_TAB), `Log${await page.evaluate<number>(LOG_ROWS)}`, `${viewport.name}: a live run opens on Log, with its rows counted`);
			assert.equal(await page.evaluate<number>(SCROLL_THE_LOG), 100, `${viewport.name}: the log must be scrolled up first`);
			for (let i = 1; i <= REFRESHES; i++) {
				const rows = await page.evaluate<number>(LOG_ROWS);
				store.event("live", { type: "tool_call", name: "Read", brief: `${viewport.name} away ${i}` });
				await page.until<number>(`${viewport.name}: refresh ${i} arrives`, LOG_ROWS, (count) => count === rows + 1);
				assert.equal(await page.evaluate<number>(LOG_SCROLL), 100, `${viewport.name}: refresh ${i} must not move a log scrolled up`);
				await page.until<string>(`${viewport.name}: refresh ${i} is counted`, JUMP_TEXT, (text) => text === `${i} new ↓`);
			}
			assert.equal(await page.evaluate<string>(CLICK_JUMP), "clicked");
			await page.until<number>(`${viewport.name}: the log jumps to its bottom`, LOG_GAP, (gap) => gap < 2);

			assert.equal(await page.evaluate<string>(CLICK_TAB("Overview")), "clicked");
			const [scrollHeight, clientHeight] = await page.evaluate<[number, number]>(PANEL_OVERFLOW("overview"));
			assert.ok(scrollHeight - clientHeight > 100, `${viewport.name}: the Overview tab must overflow for this test to prove anything, got ${scrollHeight} in ${clientHeight}`);
			const middle = await page.evaluate<number>(SCROLL_THE_PANEL("overview", "Math.floor((panel.scrollHeight - panel.clientHeight) / 2)"));
			assert.ok(middle > 0, `${viewport.name}: the Overview tab must scroll to its middle, got ${middle}`);
			for (let i = 1; i <= REFRESHES; i++) {
				const rows = await page.evaluate<number>(LOG_ROWS);
				store.event("live", { type: "tool_call", name: "Read", brief: `${viewport.name} hidden ${i}` });
				await page.until<number>(`${viewport.name}: hidden refresh ${i} arrives`, LOG_ROWS, (count) => count === rows + 1);
				assert.equal(await page.evaluate<number>(PANEL_SCROLL("overview")), middle, `${viewport.name}: hidden refresh ${i} must not move the Overview tab`);
				await page.until<string>(`${viewport.name}: hidden refresh ${i} is counted on the Log tab`, TAB_BADGE("Log"), (text) => text === `+${i}*`);
			}

			assert.equal(await page.evaluate<string>(CLICK_TAB("Log")), "clicked");
			await page.until<number>(`${viewport.name}: back on Log, the log is at its bottom`, LOG_GAP, (gap) => gap < 2);
			assert.equal(await page.evaluate<string>(JUMP_TEXT), "", `${viewport.name}: a pinned log has nothing unseen`);
			assert.equal(await page.evaluate<string>(TAB_BADGE("Log")), String(await page.evaluate<number>(LOG_ROWS)), `${viewport.name}: back on Log, the badge counts the rows again`);
		}
	} finally {
		shift(Date.now() - started);
		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
	}
});

const LOG_PLACE = "(() => { const log = document.querySelector('.log'); return [log.getBoundingClientRect().top, log.scrollTop]; })()";
const HEADER_STATUS = "(document.querySelector('.detail-title-row .status') || {}).textContent || ''";
const SECTION_HEIGHT = (title: string) =>
	`(() => { const node = document.querySelector(${JSON.stringify(`.section[data-section="${title}"]`)}); return node ? node.getBoundingClientRect().height : 0; })()`;
const GROWN_HEIGHTS = `[${["Timeline", "Tasks", "Latest thinking"].map(SECTION_HEIGHT).join(", ")}]`;
const TASK_SUMMARIES = "Array.from(document.querySelectorAll('.task-summary')).map((node) => node.textContent)";
const WORDS = (count: number) => Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");

test("the Log tab holds still while tasks, the timeline and thinking grow on the Tasks tab", { skip }, async () => {
	const { page, store, shift } = await opened();
	const started = Date.now();
	const tasks: string[] = [];
	const thoughts: string[] = [];
	let toolCalls = 50;
	try {
		for (const viewport of VIEWPORTS) {
			await page.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
			await page.open((await fixture()).url);
			await page.until<string>(`${viewport.name}: the running run is selected by default`, DETAIL_TITLE, (title) => title === "opus");
			await page.until<string>(`${viewport.name}: the live log is rendered`, HAS_LOG, (has) => has === "yes");
			assert.equal(await page.evaluate<string>(HEADER_STATUS), "running", `${viewport.name}: the header shows the run's status`);
			assert.equal(await page.evaluate<number>(SCROLL_THE_LOG), 100, `${viewport.name}: the log must be scrolled up first`);
			const [logTop] = await page.evaluate<[number, number]>(LOG_PLACE);

			const kept = async (what: string, pinned: boolean, unseen: string): Promise<void> => {
				const [top, logScroll] = await page.evaluate<[number, number]>(LOG_PLACE);
				assert.ok(Math.abs(top - logTop) <= 1, `${viewport.name}: ${what} moved the log on screen from ${logTop} to ${top}`);
				if (pinned) assert.ok((await page.evaluate<number>(LOG_GAP)) < 2, `${viewport.name}: a pinned log must follow ${what}`);
				else assert.equal(logScroll, 100, `${viewport.name}: ${what} must not move a log scrolled up`);
				assert.equal(await page.evaluate<string>(JUMP_TEXT), unseen, `${viewport.name}: unseen rows after ${what}`);
			};

			const grow = async (phase: string, pinned: boolean): Promise<void> => {
				const taskId = `${viewport.name}-${phase}`;
				const rows = await page.evaluate<number>(LOG_ROWS);
				store.event("live", { type: "task_started", taskId, name: `${taskId} ${WORDS(20)}`, taskType: "local_agent", subagentType: "general-purpose" });
				tasks.push(taskId);
				await page.until<number>(`${taskId}: the task's log row arrives`, LOG_ROWS, (count) => count === rows + 1);
				assert.equal(await page.evaluate<string>(TAB_BADGE("Tasks")), `${tasks.length} running*`, `${taskId}: the Tasks tab counts the running tasks`);
				await kept(`${taskId} starting`, pinned, pinned ? "" : "1 new ↓");

				const marker = `${taskId} summary`;
				store.event("live", {
					type: "task_progress",
					taskId,
					summary: `${marker} ${WORDS(60)}`,
					lastTool: "Read",
					tokens: 900,
					toolUses: 7,
					phase: "Verify",
					agents: [
						{ label: "a", state: "done" },
						{ label: "b", state: "start" },
					],
				});
				await page.until<string[]>(`${taskId}: the summary arrives`, TASK_SUMMARIES, (summaries) => summaries.some((text) => text.startsWith(marker)));
				await kept(`${taskId} progress`, pinned, pinned ? "" : "1 new ↓");

				toolCalls++;
				thoughts.push(`${taskId} thinking ${WORDS(12)}`);
				store.progress("live", { toolCalls, tokensIn: 5, tokensOut: 1, thinking: [...thoughts] });
				await page.until<string>(`${taskId}: the thinking arrives`, TOOL_CALLS_FACT, (value) => value === String(toolCalls));
				await kept(`${taskId} thinking`, pinned, pinned ? "" : "1 new ↓");
			};

			await grow("away", false);
			assert.equal(await page.evaluate<string>(CLICK_JUMP), "clicked");
			await page.until<number>(`${viewport.name}: the log jumps to its bottom`, LOG_GAP, (gap) => gap < 2);
			await page.until<string>(`${viewport.name}: the count clears at the bottom`, JUMP_TEXT, (text) => text === "");
			await kept("the jump", true, "");
			await grow("pinned", true);

			assert.equal(await page.evaluate<string>(CLICK_TAB("Tasks")), "clicked");
			const [timeline, taskTable, thinking] = await page.evaluate<number[]>(GROWN_HEIGHTS);
			assert.ok(timeline! > 0 && taskTable! > 0 && thinking! > 0, `${viewport.name}: the Tasks tab shows the timeline, the tasks and the thinking, got ${timeline}, ${taskTable} and ${thinking}`);
			const summaries = await page.evaluate<string[]>(TASK_SUMMARIES);
			assert.ok(summaries.some((text) => text.startsWith(`${viewport.name}-pinned summary`)), `${viewport.name}: the Tasks tab shows the last summary`);
		}
	} finally {
		for (const taskId of tasks) store.event("live", { type: "task_ended", taskId, status: "completed" });
		store.progress("live", { toolCalls: TOOL_CALLS, tokensIn: 5, tokensOut: 1, thinking: [] });
		shift(Date.now() - started);
		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
	}
});

test("selecting another run starts its tabs at the top and on the tab that fits its state", { skip }, async () => {
	const { page } = await opened();
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked", "the finished run must be in the sidebar");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	await page.until<string>("the report is rendered", HAS_REPORT, (has) => has === "yes");
	assert.equal(await page.evaluate<string>(SELECTED_TAB), "Report1", "a finished run opens on Report");
	assert.equal(await page.evaluate<string>(CLICK_TAB("Overview")), "clicked");
	assert.equal(await page.evaluate<number>(SCROLL_THE_PANEL("overview", "200")), 200, "the Overview tab must be scrolled first");

	assert.equal(await page.evaluate<string>(CLICK_LIVE), "clicked", "the live run must be in the sidebar");
	await page.until<string>("the live run is shown", DETAIL_TITLE, (title) => title === "opus");
	await page.until<string>("the live log is rendered", HAS_LOG, (has) => has === "yes");

	assert.equal(await page.evaluate<string>(SELECTED_TAB), `Log${await page.evaluate<number>(LOG_ROWS)}`, "a live run opens on Log");
	assert.ok((await page.evaluate<number>(LOG_GAP)) < 2, "another run's log must open at its newest rows");
	assert.equal(await page.evaluate<string>(CLICK_TAB("Overview")), "clicked");
	assert.equal(await page.evaluate<number>(PANEL_SCROLL("overview")), 0, "another run must be read from its top");
});

test("the tabs switch by click and arrow keys, / opens the Log tab and a report badge opens the Report tab", { skip }, async () => {
	const { page } = await opened();
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	await page.until<string>("the report is rendered", HAS_REPORT, (has) => has === "yes");
	const rows = await page.evaluate<number>(LOG_ROWS);
	assert.deepEqual(await page.evaluate<string[]>("Array.from(document.querySelectorAll('.tab')).map((node) => node.textContent)"), ["Overview", `Log${rows}`, "Tasks1", "Report1"]);
	assert.equal(await page.evaluate<string>(VISIBLE_PANEL), "report");

	assert.equal(await page.evaluate<string>(CLICK_TAB("Tasks")), "clicked");
	assert.equal(await page.evaluate<string>(VISIBLE_PANEL), "tasks");
	assert.equal(await page.evaluate<string>("document.activeElement.textContent"), "Tasks1", "the clicked tab takes the focus");
	await press(page, "ArrowRight");
	assert.equal(await page.evaluate<string>(SELECTED_TAB), "Report1", "ArrowRight selects the next tab");
	await press(page, "ArrowRight");
	assert.equal(await page.evaluate<string>(SELECTED_TAB), "Report1", "ArrowRight stops at the last tab");
	for (let i = 0; i < 3; i++) await press(page, "ArrowLeft");
	assert.equal(await page.evaluate<string>(SELECTED_TAB), "Overview", "ArrowLeft selects the previous tab");
	await press(page, "ArrowLeft");
	assert.equal(await page.evaluate<string>(SELECTED_TAB), "Overview", "ArrowLeft stops at the first tab");
	assert.equal(await page.evaluate<string>(VISIBLE_PANEL), "overview");

	await press(page, "/");
	assert.equal(await page.evaluate<string>(VISIBLE_PANEL), "log", "/ opens the Log tab");
	assert.equal(await page.evaluate<string>("document.activeElement.className"), "log-search", "/ focuses the search box");

	await page.evaluate<string>("(() => { document.activeElement.blur(); document.querySelector('.detail-flags .flag').click(); return 'ok'; })()");
	assert.equal(await page.evaluate<string>(VISIBLE_PANEL), "report", "a report badge opens the Report tab");
	const [headingTop, headingBottom, reportTop, reportBottom] = await page.evaluate<number[]>(
		"(() => { const report = document.querySelector('.report'); const heading = Array.from(report.querySelectorAll('.md-heading')).find((node) => node.dataset.heading === 'escalation'); const own = heading.getBoundingClientRect(); const box = report.getBoundingClientRect(); return [own.top, own.bottom, box.top, box.bottom]; })()",
	);
	assert.ok(headingTop! >= reportTop! && headingBottom! <= reportBottom!, `the badge scrolls the Escalation heading into the report's view, got ${headingTop}-${headingBottom} in ${reportTop}-${reportBottom}`);
});

test("a run shows the prompt it was given, its contract and its Claude session", { skip }, async () => {
	const { page } = await opened();
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	assert.equal(await page.evaluate<string>(PROMPT_TEXT), "Goal: tidy the store.\nPlan: one step.");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Contract")), "contracts/plan.md");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Claude session")), "resume sess-old at msg-1");
});

test("a tool call row opens its input and result, and a task shows its Agent prompt", { skip }, async () => {
	const { page } = await opened();
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	assert.equal(await page.evaluate<string>(CLICK_TAB("Log")), "clicked");
	await page.until<string>("the failed call is marked", "String(document.querySelectorAll('.log .call-error').length)", (count) => count === "1");
	await page.evaluate<string>("(() => { document.querySelector('.log .call-error .log-text').click(); return 'ok'; })()");
	const text = await page.until<string>(
		"the call opens",
		"(document.querySelector('.log .call-error .call-detail') || {}).textContent || ''",
		(value) => value.includes("1 failing"),
	);
	assert.ok(text.includes('"command": "npm test"'), text);
	assert.ok(text.startsWith("Input"), text);
	assert.ok(text.includes("Error1 failing"), text);
	assert.equal(await page.evaluate<string>("(document.querySelector('.task-prompt pre') || {}).textContent || ''"), "Find the store.");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Tool errors")), "1");
});

test("a run shows its cost, cache, context meter, model usage and latest thinking", { skip }, async () => {
	const { page } = await opened();
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Cost (estimate)")), "$0.2500");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Cache read")), "900");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Context")), "750,000 / 1,000,000 (75%)");
	const [width, warned] = await page.evaluate<[string, boolean]>(
		"(() => { const fill = document.querySelector('.context-fill'); return [fill.style.width, fill.classList.contains('context-warn')]; })()",
	);
	assert.equal(width, "75%", "the meter's width is set through the CSSOM, which the CSP allows");
	assert.equal(warned, true);
	assert.equal(await page.evaluate<string>("(document.querySelector('.models tbody td') || {}).textContent || ''"), "claude-opus-5");
	assert.equal(await page.evaluate<string>("(document.querySelector('.thinking-block') || {}).textContent || ''"), "Check the store first.");
	assert.ok((await page.evaluate<string>("Array.from(document.querySelectorAll('.run-count')).map((node) => node.textContent).join(' ')")).includes("$0.2500"));
});

test("the log filters by text, kind and errors, and the filter survives a live render", { skip }, async () => {
	const { page, store } = await opened();
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	assert.equal(await page.evaluate<string>(CLICK_TAB("Log")), "clicked");
	const shown = "document.querySelectorAll('.log .log-row:not(.filtered)').length";
	const count = "document.querySelector('.log-count').textContent";
	const total = await page.evaluate<number>(LOG_ROWS);
	await page.evaluate<string>("(() => { const box = document.querySelector('.log-search'); box.focus(); box.value = 'FILE-3'; box.dispatchEvent(new Event('input')); return 'ok'; })()");
	assert.equal(await page.evaluate<number>(shown), 11, "file-3.ts and file-30.ts to file-39.ts, matched without case");
	assert.equal(await page.evaluate<string>(count), `11 of ${total} entries`);
	store.progress("old", { toolCalls: 7, tokensIn: 5, tokensOut: 1 });
	await page.until<string>("the new tool call count arrives", TOOL_CALLS_FACT, (value) => value === "7");
	assert.equal(await page.evaluate<number>(shown), 11, "a render keeps the filter");
	assert.equal(await page.evaluate<string>("document.activeElement.className"), "log-search", "a render keeps the focus in the search box");
	assert.equal(await page.evaluate<string>("document.querySelector('.log-search').value"), "FILE-3");

	await page.evaluate<string>("(() => { const box = document.querySelector('.log-search'); box.value = ''; box.dispatchEvent(new Event('input')); return 'ok'; })()");
	const chip = (label: string) => `(() => { Array.from(document.querySelectorAll('.filter-chip')).find((node) => node.textContent === '${label}').click(); return 'ok'; })()`;
	await page.evaluate<string>(chip("errors"));
	assert.equal(await page.evaluate<number>(shown), 1);
	await page.evaluate<string>(chip("errors"));
	await page.evaluate<string>(chip("task"));
	assert.equal(await page.evaluate<number>("Array.from(document.querySelectorAll('.log .log-row:not(.filtered)')).every((row) => row.dataset.kind === 'task') ? 1 : 0"), 1);
	assert.ok((await page.evaluate<number>(shown)) >= 2);
	await page.evaluate<string>(chip("task"));
	assert.equal(await page.evaluate<number>(shown), total);
});

test("the report renders as Markdown without parsing markup, flags its Escalation and has a raw view", { skip }, async () => {
	const { page } = await opened();
	const flags = await page.evaluate<string>("Array.from(document.querySelectorAll('.run-flags .flag')).map((node) => node.textContent).join(',')");
	assert.equal(flags, "Escalation", "the run list flags a report with an Escalation section");
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
	await page.until<string>("the report is rendered", HAS_REPORT, (has) => has === "yes");
	const shape = await page.evaluate<Record<string, unknown>>(`(() => {
		const report = document.querySelector('.report');
		return {
			headings: Array.from(report.querySelectorAll('.md-heading')).map((node) => node.tagName + ' ' + node.textContent),
			strong: (report.querySelector('strong') || {}).textContent,
			code: (report.querySelector('.md-code') || {}).textContent,
			injected: report.querySelectorAll('b').length,
			literal: report.textContent.includes('<b>not bold</b>'),
			nested: report.querySelectorAll('.md-list .md-list li').length,
			cells: Array.from(report.querySelectorAll('.md-table td')).map((node) => node.textContent).join(','),
			breaks: report.querySelector('p').querySelectorAll('br').length,
		};
	})()`);
	assert.deepEqual(shape, {
		headings: ["H4 Changed", "H4 Escalation"],
		strong: "decision",
		code: "store.ts",
		injected: 0,
		literal: true,
		nested: 1,
		cells: "1,2",
		breaks: REPORT_LINES - 1,
	});
	await page.evaluate<string>("(() => { document.querySelector('.detail-flags .flag').click(); return 'ok'; })()");
	await page.evaluate<string>("(() => { Array.from(document.querySelectorAll('.section-head .copy')).find((node) => node.textContent === 'Raw').click(); return 'ok'; })()");
	assert.equal(await page.evaluate<string>("document.querySelector('.report').tagName"), "PRE");
	assert.ok((await page.evaluate<string>("document.querySelector('.report').textContent")).startsWith("## Changed"));
	await page.evaluate<string>("(() => { Array.from(document.querySelectorAll('.section-head .copy')).find((node) => node.textContent === 'Formatted').click(); return 'ok'; })()");
	assert.equal(await page.evaluate<string>("document.querySelector('.report').tagName"), "DIV");
});

test("a run lists the files it changed and the run list counts them", { skip }, async () => {
	const { page } = await opened();
	assert.ok((await page.evaluate<string>("Array.from(document.querySelectorAll('.run-count')).map((node) => node.textContent).join(' ')")).includes("2 files"));
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	const rows = await page.evaluate<string[]>("Array.from(document.querySelectorAll('.files tr')).map((row) => Array.from(row.children).map((cell) => cell.textContent).join('|'))");
	assert.deepEqual(rows, ["M|extensions/dashboard.ts|+12−3", "A|logo.png|"]);
});

test("the run list groups runs by Pi session and a run shows its place in the chain", { skip }, async () => {
	const { page } = await opened();
	assert.deepEqual(await page.evaluate<string[]>("Array.from(document.querySelectorAll('.run-group')).map((node) => node.textContent)"), ["Pi session host-aaa · 2 runs"]);
	assert.deepEqual(await page.evaluate<string[]>("Array.from(document.querySelectorAll('.run-step')).map((node) => node.textContent)"), ["#2", "#1"]);
	await page.until<string>("the live run is shown", DETAIL_TITLE, (title) => title === "opus");
	const chain = await page.evaluate<string[]>("Array.from(document.querySelectorAll('.chain-step')).map((node) => node.textContent + (node.classList.contains('chain-current') ? '*' : ''))");
	assert.deepEqual(chain, ["1 fable", "2 opus*"]);
	await page.evaluate<string>("(() => { document.querySelector('.chain-step').click(); return 'ok'; })()");
	await page.until<string>("the chain selects the first run", DETAIL_TITLE, (title) => title === "fable");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Pi tool")), "claude");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Pi tool call")), "call-1");
});

test("the token url without a trailing slash loads the page, its script and its stylesheet", { skip }, async () => {
	const { page, token, slashless } = await fixture();
	await page.open(slashless);

	const pathname = await page.evaluate<string>("location.pathname");
	assert.ok(pathname === `/${token}/`, "the slashless url must end up on the token path with a trailing slash");
	await page.until<number>("both runs are listed", RUN_BUTTONS, (count) => count === 2);
	assert.equal(await page.evaluate<string>(CWD_TEXT), CWD, "app.js must have loaded from the redirected url");
	assert.equal(
		await page.evaluate<string>(USAGE_TEXT),
		"Session usage: $1.25 est. · 1,200 in · 340 out · 250 workflow tokens · 3 calls · warn at $1.00, $2.00 · limit $5.00",
		"the header shows what this Pi session's runs have cost",
	);
	const [sheets, sidebarWidth] = await page.evaluate<[number, string]>(STYLE_PROOF);
	assert.equal(sheets, 1, "app.css must have loaded from the redirected url");
	assert.equal(sidebarWidth, "260px", "app.css must have been applied");
});

const NARROW = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
const DRAWER =
	"(() => { const sidebar = document.getElementById('runs'); const toggle = document.getElementById('runs-toggle'); const active = document.activeElement; return { sidebar: getComputedStyle(sidebar).display, sidebarWidth: sidebar.getBoundingClientRect().width, layoutWidth: document.getElementById('layout').getBoundingClientRect().width, toggle: getComputedStyle(toggle).display, expanded: toggle.getAttribute('aria-expanded'), focus: active === toggle ? 'toggle' : active && active.classList.contains('run-active') ? 'active run' : active ? active.tagName : '' }; })()";
const CLICK_TOGGLE = "(() => { document.getElementById('runs-toggle').click(); return 'clicked'; })()";

interface Drawer {
	sidebar: string;
	sidebarWidth: number;
	layoutWidth: number;
	toggle: string;
	expanded: string;
	focus: string;
}

test("a narrow window hides the run list behind a Runs button", { skip }, async () => {
	const { page, url } = await fixture();
	try {
		await page.send("Emulation.setDeviceMetricsOverride", NARROW);
		await page.open(url);
		await page.until<number>("both runs are listed", RUN_BUTTONS, (count) => count === 2);
		await page.until<string>("the live run is shown", DETAIL_TITLE, (title) => title === "opus");
		await page.until<string>("the live log is rendered", HAS_LOG, (has) => has === "yes");
		const closed = await page.evaluate<Drawer>(DRAWER);
		assert.equal(closed.sidebar, "none", "the run list starts hidden");
		assert.notEqual(closed.toggle, "none", "the Runs button is shown");
		assert.equal(closed.expanded, "false");

		assert.equal(await page.evaluate<number>(SCROLL_THE_LOG), 100, "the log must be scrolled first");
		assert.equal(await page.evaluate<string>(CLICK_TOGGLE), "clicked");
		const open = await page.evaluate<Drawer>(DRAWER);
		assert.equal(open.sidebar, "block", "the Runs button opens the run list");
		assert.equal(open.sidebarWidth, open.layoutWidth, "the open run list covers the whole layout");
		assert.equal(open.expanded, "true");
		assert.equal(open.focus, "active run", "opening the run list focuses the selected run");

		assert.equal(await page.evaluate<string>(CLICK_TOGGLE), "clicked");
		const shut = await page.evaluate<Drawer>(DRAWER);
		assert.equal(shut.sidebar, "none", "the Runs button closes the run list");
		assert.equal(shut.expanded, "false");
		assert.equal(await page.evaluate<number>(LOG_SCROLL), 100, "the drawer must not move the log");

		assert.equal(await page.evaluate<string>(CLICK_TOGGLE), "clicked");
		assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
		const picked = await page.evaluate<Drawer>(DRAWER);
		assert.equal(picked.sidebar, "none", "selecting a run closes the run list");
		assert.equal(picked.expanded, "false");
		assert.equal(picked.focus, "toggle", "selecting a run puts the focus back on the Runs button");
		await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");

		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
		const desktop = await page.evaluate<Drawer>(DRAWER);
		assert.equal(desktop.sidebar, "block", "a wide window always shows the run list");
		assert.equal(desktop.sidebarWidth, 260, "a wide window keeps the 260px run list");
		assert.equal(desktop.toggle, "none", "a wide window hides the Runs button");
	} finally {
		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
	}
});

const ATTENTION =
	"(() => { const banner = document.getElementById('attention'); const waiting = Array.from(document.querySelectorAll('.run-waiting')).map((node) => node.querySelector('.run-role').textContent); return { hidden: banner.classList.contains('hidden') || getComputedStyle(banner).display === 'none', text: Array.from(banner.children).map((node) => node.textContent).join('|'), waiting, title: document.title }; })()";
const CLICK_ATTENTION = "(() => { const button = document.querySelector('.attention-run'); if (!button) return 'missing'; button.click(); return 'clicked'; })()";
const AFTER_HEAD = "(() => { const next = document.querySelector('.detail-head').nextElementSibling; return next && next.querySelector('.question') ? next.querySelector('.question').textContent : ''; })()";

interface Attention {
	hidden: boolean;
	text: string;
	waiting: string[];
	title: string;
}

test("a waiting run shows in a banner and the page title without taking the selection", { skip }, async () => {
	const { page, store } = await opened();
	try {
		assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
		await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
		const idle = await page.evaluate<Attention>(ATTENTION);
		assert.equal(idle.hidden, true, "no waiting run, no banner");
		assert.equal(idle.title, "pi-fusion dashboard");

		store.question("live", "Which store?\nsecond line");
		const shown = await page.until<Attention>("the banner shows the question", ATTENTION, (value) => !value.hidden);
		assert.deepEqual(shown, { hidden: false, text: "Needs input|opusWhich store?", waiting: ["opus"], title: "(1) pi-fusion dashboard" });
		assert.equal(await page.evaluate<string>(DETAIL_TITLE), "fable", "a question must not move the selection");
		assert.equal(await page.evaluate<number>("document.querySelectorAll('.run-active.run-waiting').length"), 0);

		assert.equal(await page.evaluate<string>(CLICK_ATTENTION), "clicked");
		await page.until<string>("the waiting run is shown", DETAIL_TITLE, (title) => title === "opus");
		await page.until<string>("the question follows the header", AFTER_HEAD, (text) => text === "Which store?\nsecond line");
		assert.equal(await page.evaluate<number>("document.querySelectorAll('.run-active.run-waiting').length"), 1);
	} finally {
		store.question("live", undefined);
	}
	const cleared = await page.until<Attention>("the banner clears", ATTENTION, (value) => value.hidden);
	assert.deepEqual(cleared, { hidden: true, text: "", waiting: [], title: "pi-fusion dashboard" });
});

const QUESTION_OVERFLOW = "(() => { const question = document.querySelector('.question'); return question ? question.scrollHeight - question.clientHeight : 0; })()";
const QUESTION_SCROLL = "(document.querySelector('.question') || {}).scrollTop";
const SCROLL_THE_QUESTION = "(() => { const question = document.querySelector('.question'); question.scrollTop = 150; return question.scrollTop; })()";

test("a long question keeps its scroll across a progress update", { skip }, async () => {
	const { page, store } = await opened();
	try {
		store.question("live", Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n"));
		await page.until<number>("the question overflows", QUESTION_OVERFLOW, (overflow) => overflow > 150);
		assert.equal(await page.evaluate<number>(SCROLL_THE_QUESTION), 150);

		store.progress("live", { toolCalls: 41, tokensIn: 5, tokensOut: 1 });
		await page.until<string>("the new tool call count arrives", TOOL_CALLS_FACT, (value) => value === "41");

		assert.equal(await page.evaluate<number>(QUESTION_SCROLL), 150, "a progress update must not scroll the question back to the top");
	} finally {
		store.question("live", undefined);
	}
	await page.until<number>("the question clears", "document.querySelectorAll('.question').length", (count) => count === 0);
});

const FOCUSED_RUN = "(() => { const active = document.activeElement; return active && active.classList.contains('run') ? active.querySelector('.run-role').textContent : ''; })()";
const CURRENT_RUN = "Array.from(document.querySelectorAll('.run[aria-current=\"true\"]')).map((node) => node.querySelector('.run-role').textContent).join(',')";
const FOCUS_LIVE = "(() => { const target = Array.from(document.querySelectorAll('.run')).find((node) => node.querySelector('.run-role').textContent === 'opus'); if (!target) return 'missing'; target.focus(); return 'focused'; })()";
const KEYS: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> = {
	ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
	ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
	ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
	Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
	Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
	"/": { code: "Slash", windowsVirtualKeyCode: 191, text: "/" },
};

async function press(page: Page, key: string): Promise<void> {
	const { text, ...rest } = KEYS[key] ?? { code: key, windowsVirtualKeyCode: 0 };
	await page.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, text, ...rest });
	await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, ...rest });
}

test("arrow keys move the focus through the run list and Enter selects the focused run", { skip }, async () => {
	const { page, store } = await opened();
	await page.until<string>("the live run is shown", DETAIL_TITLE, (title) => title === "opus");
	assert.equal(await page.evaluate<string>(CURRENT_RUN), "opus", "the selected run is marked current");
	assert.equal(await page.evaluate<string>(FOCUS_LIVE), "focused");

	await press(page, "ArrowDown");
	assert.equal(await page.evaluate<string>(FOCUSED_RUN), "fable", "ArrowDown focuses the next run");
	await press(page, "ArrowDown");
	assert.equal(await page.evaluate<string>(FOCUSED_RUN), "fable", "ArrowDown stops at the last run");
	assert.equal(await page.evaluate<string>(DETAIL_TITLE), "opus", "an arrow key must not change the selection");
	assert.equal(await page.evaluate<string>(CURRENT_RUN), "opus");

	store.progress("live", { toolCalls: 42, tokensIn: 5, tokensOut: 1 });
	await page.until<string>("the new tool call count arrives", TOOL_CALLS_FACT, (value) => value === "42");
	assert.equal(await page.evaluate<string>(FOCUSED_RUN), "fable", "a rebuilt run list keeps the focus on the same run");

	await press(page, "ArrowUp");
	assert.equal(await page.evaluate<string>(FOCUSED_RUN), "opus", "ArrowUp focuses the previous run");
	await press(page, "ArrowUp");
	assert.equal(await page.evaluate<string>(FOCUSED_RUN), "opus", "ArrowUp stops at the first run");

	await press(page, "ArrowDown");
	await press(page, "Enter");
	await page.until<string>("Enter selects the focused run", DETAIL_TITLE, (title) => title === "fable");
	assert.equal(await page.evaluate<string>(CURRENT_RUN), "fable");
	assert.equal(await page.evaluate<string>(FOCUSED_RUN), "fable", "selecting a run keeps the focus on it");
});

test("Escape and the Clear button reset every log filter", { skip }, async () => {
	const { page } = await opened();
	assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
	await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
	assert.equal(await page.evaluate<string>(CLICK_TAB("Log")), "clicked");
	const shown = "document.querySelectorAll('.log .log-row:not(.filtered)').length";
	const pressed = "document.querySelectorAll('.filter-chip[aria-pressed=\"true\"]').length";
	const clearShown = "(() => { const node = document.querySelector('.filter-clear'); return node && getComputedStyle(node).display !== 'none' ? 1 : 0; })()";
	const chip = (label: string) => `(() => { Array.from(document.querySelectorAll('.filter-chip')).find((node) => node.textContent === '${label}').click(); return 'ok'; })()`;
	const total = await page.evaluate<number>(LOG_ROWS);
	assert.equal(await page.evaluate<number>(clearShown), 0, "Clear is hidden while no filter is set");

	await page.evaluate<string>("(() => { const box = document.querySelector('.log-search'); box.value = 'FILE-3'; box.dispatchEvent(new Event('input')); return 'ok'; })()");
	await page.evaluate<string>(chip("errors"));
	assert.equal(await page.evaluate<number>(pressed), 1);
	assert.equal(await page.evaluate<number>(clearShown), 1, "Clear shows while a filter is set");
	assert.ok((await page.evaluate<number>(shown)) < total);

	await page.evaluate<string>("(() => { document.querySelector('.log-search').focus(); return 'ok'; })()");
	await press(page, "Escape");
	assert.equal(await page.evaluate<string>("document.querySelector('.log-search').value"), "");
	assert.equal(await page.evaluate<number>(pressed), 0, "Escape releases every chip");
	assert.equal(await page.evaluate<number>(shown), total);
	assert.equal(await page.evaluate<number>(clearShown), 0);
	assert.equal(await page.evaluate<string>("document.activeElement.className"), "log-search", "Escape keeps the focus in the search box");

	await page.evaluate<string>(chip("task"));
	assert.equal(await page.evaluate<number>(clearShown), 1);
	assert.ok((await page.evaluate<number>(shown)) < total);
	await page.evaluate<string>("(() => { document.querySelector('.filter-clear').click(); return 'ok'; })()");
	assert.equal(await page.evaluate<number>(pressed), 0, "Clear releases every chip");
	assert.equal(await page.evaluate<number>(shown), total);
	assert.equal(await page.evaluate<number>(clearShown), 0);
	assert.equal(await page.evaluate<string>("document.activeElement.className"), "log-search", "Clear hands the focus to the search box");
});

const ATTENTION_FOCUS =
	"(() => { const button = document.querySelector('.attention-run'); return { probe: button ? button.dataset.probe || '' : '', focused: !!button && document.activeElement === button, text: button ? button.textContent : '' }; })()";

interface AttentionFocus {
	probe: string;
	focused: boolean;
	text: string;
}

test("the attention banner keeps its buttons across unrelated refreshes and the focus across a rebuild", { skip }, async () => {
	const { page, store } = await opened();
	try {
		assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
		await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
		store.question("live", "Which store?");
		await page.until<Attention>("the banner shows the question", ATTENTION, (value) => !value.hidden);
		await page.evaluate<string>("(() => { const button = document.querySelector('.attention-run'); button.dataset.probe = 'kept'; button.focus(); return 'ok'; })()");

		store.progress("old", { toolCalls: 8, tokensIn: 5, tokensOut: 1 });
		await page.until<string>("the new tool call count arrives", TOOL_CALLS_FACT, (value) => value === "8");
		assert.deepEqual(await page.evaluate<AttentionFocus>(ATTENTION_FOCUS), { probe: "kept", focused: true, text: "opusWhich store?" }, "an unrelated refresh must not rebuild the banner");

		store.question("live", "Which other store?");
		const changed = await page.until<AttentionFocus>("the banner shows the new question", ATTENTION_FOCUS, (value) => value.text === "opusWhich other store?");
		assert.deepEqual(changed, { probe: "", focused: true, text: "opusWhich other store?" }, "a rebuilt banner keeps the focus on the same run's button");
	} finally {
		store.question("live", undefined);
	}
	await page.until<Attention>("the banner clears", ATTENTION, (value) => value.hidden);
});

const DRAWER_STATE =
	"(() => { const toggle = document.getElementById('runs-toggle'); return { expanded: toggle.getAttribute('aria-expanded'), inert: document.getElementById('detail').inert, open: document.getElementById('layout').classList.contains('runs-open'), sidebar: getComputedStyle(document.getElementById('runs')).display, toggleFocused: document.activeElement === toggle }; })()";
const SEARCH_VALUE = "(document.querySelector('.log-search') || {}).value";
const SET_SEARCH = (text: string) =>
	`(() => { const box = document.querySelector('.log-search'); if (!box) return 'missing'; box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input')); return 'ok'; })()`;

interface DrawerState {
	expanded: string;
	inert: boolean;
	open: boolean;
	sidebar: string;
	toggleFocused: boolean;
}

test("the open run list keeps the keys and focus to itself, closes on Escape and on a wide window", { skip }, async () => {
	const { page, url } = await fixture();
	try {
		await page.send("Emulation.setDeviceMetricsOverride", NARROW);
		await page.open(url);
		await page.until<number>("both runs are listed", RUN_BUTTONS, (count) => count === 2);
		await page.until<string>("the live run is shown", DETAIL_TITLE, (title) => title === "opus");
		await page.until<string>("the live log is rendered", HAS_LOG, (has) => has === "yes");
		assert.equal(await page.evaluate<string>(SET_SEARCH("step")), "ok");

		assert.equal(await page.evaluate<string>(CLICK_TOGGLE), "clicked");
		assert.equal((await page.evaluate<DrawerState>(DRAWER_STATE)).inert, true, "the open run list shuts off the detail behind it");
		assert.equal(
			await page.evaluate<boolean>("(() => { const box = document.querySelector('.log-search'); box.focus(); return document.activeElement === box; })()"),
			false,
			"the hidden search box must not take the focus",
		);
		assert.equal(await page.evaluate<string>(FOCUS_LIVE), "focused");
		await press(page, "/");
		assert.equal(await page.evaluate<string>(FOCUSED_RUN), "opus", "/ must not move the focus out of the open run list");

		await press(page, "Escape");
		const closed = await page.evaluate<DrawerState>(DRAWER_STATE);
		assert.deepEqual(closed, { expanded: "false", inert: false, open: false, sidebar: "none", toggleFocused: true }, "Escape closes the run list and focuses the Runs button");
		assert.equal(await page.evaluate<string>(SEARCH_VALUE), "step", "Escape on the run list must not clear the hidden filter");

		assert.equal(await page.evaluate<string>(CLICK_TOGGLE), "clicked");
		assert.equal((await page.evaluate<DrawerState>(DRAWER_STATE)).open, true);
		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
		const wide = await page.until<DrawerState>("a wide window closes the run list", DRAWER_STATE, (drawer) => drawer.expanded === "false" && !drawer.inert && !drawer.open);
		assert.equal(wide.toggleFocused, false, "the hidden Runs button must not take the focus");

		await page.send("Emulation.setDeviceMetricsOverride", NARROW);
		await page.until<string>("the narrow layout is back", "getComputedStyle(document.getElementById('runs-toggle')).display", (display) => display !== "none");
		const narrow = await page.evaluate<DrawerState>(DRAWER_STATE);
		assert.equal(narrow.sidebar, "none", "narrowing again keeps the run list closed");
		assert.equal(narrow.expanded, "false");
		assert.equal(narrow.inert, false);
	} finally {
		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
		await page.evaluate<string>(SET_SEARCH(""));
	}
});

const TASKS_SECTION = "document.querySelector('.section[data-section=\"Tasks\"]')";
const TASKS_OVERFLOW = `(() => { const node = ${TASKS_SECTION}; return node ? [node.scrollWidth, node.clientWidth] : [0, 0]; })()`;
const TASKS_SCROLL = `(${TASKS_SECTION} || {}).scrollLeft`;
const SCROLL_THE_TASKS = `(() => { const node = ${TASKS_SECTION}; node.scrollLeft = 60; return node.scrollLeft; })()`;

test("a wide table in a narrow window keeps its sideways scroll across a progress update", { skip }, async () => {
	const { page, store, url } = await fixture();
	try {
		await page.send("Emulation.setDeviceMetricsOverride", NARROW);
		await page.open(url);
		await page.until<number>("both runs are listed", RUN_BUTTONS, (count) => count === 2);
		assert.equal(await page.evaluate<string>(CLICK_TOGGLE), "clicked");
		assert.equal(await page.evaluate<string>(CLICK_OLD), "clicked");
		await page.until<string>("the finished run is shown", DETAIL_TITLE, (title) => title === "fable");
		assert.equal(await page.evaluate<string>(CLICK_TAB("Tasks")), "clicked");
		const [scrollWidth, clientWidth] = await page.until<[number, number]>("the Tasks table is rendered", TASKS_OVERFLOW, ([width]) => width > 0);
		assert.ok(scrollWidth > clientWidth, `the Tasks section must overflow sideways for this test to prove anything, got ${scrollWidth} in ${clientWidth}`);
		assert.equal(await page.evaluate<number>(SCROLL_THE_TASKS), 60);

		store.progress("old", { toolCalls: 9, tokensIn: 5, tokensOut: 1 });
		await page.until<string>("the new tool call count arrives", TOOL_CALLS_FACT, (value) => value === "9");

		assert.equal(await page.evaluate<number>(TASKS_SCROLL), 60, "a progress update must not scroll the Tasks table back to its left edge");
	} finally {
		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
	}
});

test("a running run with no events for a minute is flagged in the list and in its facts", { skip }, async () => {
	const { page, store, shift } = await fixture();
	shift(Date.now() - shift(0));
	shift(-120_000);
	store.start({ id: "quiet", role: "quiet-role", model: "opus" });
	shift(120_000);
	await page.open((await fixture()).url);
	await page.until<number>("the quiet run is listed", RUN_BUTTONS, (count) => count === 3);
	const flagged = await page.until<string>(
		"the quiet run is flagged",
		"(() => { const item = Array.from(document.querySelectorAll('.run')).find((node) => node.querySelector('.run-role').textContent === 'quiet-role'); return item && item.classList.contains('run-stalled') ? item.querySelector('.run-stall').textContent : ''; })()",
		(text) => text !== "",
	);
	assert.match(flagged, /^no events for 2m 0\ds$/);
	assert.equal(await page.evaluate<number>("document.querySelectorAll('.run-stalled').length"), 1, "a run that just reported, or a finished one, is not flagged");
	await page.evaluate<string>("(() => { Array.from(document.querySelectorAll('.run')).find((node) => node.querySelector('.run-role').textContent === 'quiet-role').click(); return 'ok'; })()");
	await page.until<string>("the quiet run is shown", DETAIL_TITLE, (title) => title === "quiet-role");
	await page.until<number>("its last event is flagged in the summary line and in the facts", "document.querySelectorAll('.fact-warn').length", (count) => count === 2);
});

test("a run's tasks are drawn on a timeline of the run", { skip }, async () => {
	const { page, store, shift } = await fixture();
	shift(-10_000);
	store.start({ id: "gantt", role: "gantt-role", model: "opus" });
	shift(4_000);
	store.event("gantt", { type: "task_started", taskId: "t-1", name: "probe" });
	shift(2_000);
	store.event("gantt", { type: "task_ended", taskId: "t-1", status: "completed" });
	store.event("gantt", { type: "task_started", taskId: "t-2", name: "verify" });
	shift(4_000);
	store.finish("gantt", { status: "done" });
	await page.open((await fixture()).url);
	await page.evaluate<string>("(() => { Array.from(document.querySelectorAll('.run')).find((node) => node.querySelector('.run-role').textContent === 'gantt-role').click(); return 'ok'; })()");
	await page.until<string>("the gantt run is shown", DETAIL_TITLE, (title) => title === "gantt-role");
	const bars = await page.evaluate<string[]>(
		"Array.from(document.querySelectorAll('.timeline-row')).filter((row) => row.querySelector('.timeline-bar')).map((row) => { const bar = row.querySelector('.timeline-bar'); return [row.querySelector('.timeline-label').textContent, Math.round(parseFloat(bar.style.left)), Math.round(parseFloat(bar.style.width)), bar.className].join(' '); })",
	);
	assert.deepEqual(bars, ["probe 40 20 timeline-bar bar-completed", "verify 60 40 timeline-bar bar-stopped"]);
	assert.equal(await page.evaluate<string>("document.querySelector('.timeline-axis').textContent"), "0s10s");
});

const COUNT_TEXT = "(document.querySelector('.log-count') || {}).textContent || ''";
const LOG_TOP = "document.querySelector('.log').getBoundingClientRect().top";
const FIT_COUNT_AT_EDGE = `(() => {
	const row = document.querySelector('.log-filter');
	const count = row.querySelector('.log-count');
	const shown = Array.from(row.children).filter((node) => node.getClientRects().length > 0);
	const before = shown[shown.length - 2];
	const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
	const line = shown.reduce((sum, node) => sum + node.getBoundingClientRect().width, gap * (shown.length - 1));
	for (let width = Math.ceil(line) + 3; width > line - 3; width -= 0.5) {
		row.style.width = width + 'px';
		const own = count.getBoundingClientRect();
		const prev = before.getBoundingClientRect();
		const slack = row.getBoundingClientRect().right - own.right;
		if (own.top < prev.bottom && own.bottom > prev.top && slack >= 0 && slack <= 3) return slack;
	}
	return -1;
})()`;
const SET_QUERY = (query: string) =>
	`(() => { const search = document.querySelector('.log-search'); search.value = ${JSON.stringify(query)}; search.dispatchEvent(new Event('input')); return search.value; })()`;

test("the log stays in place when its entry count gains a digit", { skip }, async () => {
	const { page, store } = await fixture();
	store.start({ id: "digits", role: "digits-role", model: "opus" });
	await page.open((await fixture()).url);
	await page.evaluate<string>("(() => { Array.from(document.querySelectorAll('.run')).find((node) => node.querySelector('.run-role').textContent === 'digits-role').click(); return 'ok'; })()");
	await page.until<string>("the digits run is shown", DETAIL_TITLE, (title) => title === "digits-role");
	let added = 0;
	const fill = async (entries: number, brief: string): Promise<void> => {
		const shown = Number.parseInt(await page.evaluate<string>(COUNT_TEXT), 10) || 0;
		for (let i = shown; i < entries; i++) store.event("digits", { type: "tool_call", name: "Read", brief: `${brief} ${++added}` });
	};
	const crossing = async (what: string, from: string, to: string, brief: string): Promise<void> => {
		await page.until<string>(`${what}: the count reads ${from}`, COUNT_TEXT, (text) => text === from);
		const slack = await page.evaluate<number>(FIT_COUNT_AT_EDGE);
		assert.ok(slack >= 0, `${what}: the count must end at the edge of the filter row`);
		const top = await page.evaluate<number>(LOG_TOP);
		store.event("digits", { type: "tool_call", name: "Read", brief: `${brief} ${++added}` });
		await page.until<string>(`${what}: the count reads ${to}`, COUNT_TEXT, (text) => text === to);
		assert.equal(await page.evaluate<number>(LOG_TOP), top, `${what}: the log moved when the count changed from ${from} to ${to}`);
	};
	try {
		store.event("digits", { type: "tool_call", name: "Read", brief: `row ${++added}` });
		await page.until<string>("the digits log is rendered", HAS_LOG, (has) => has === "yes");
		await fill(9, "row");
		await crossing("desktop", "9 entries", "10 entries", "row");
		await fill(99, "row");
		await crossing("desktop", "99 entries", "100 entries", "row");

		await page.send("Emulation.setDeviceMetricsOverride", NARROW);
		await page.evaluate<string>(SET_QUERY("marker"));
		for (let i = 0; i < 9; i++) store.event("digits", { type: "tool_call", name: "Read", brief: `marker ${++added}` });
		await crossing("mobile filtered", "9 of 100 entries", "10 of 100 entries", "marker");
	} finally {
		await page.evaluate<string>("(() => { document.querySelector('.log-filter').style.width = ''; return 'ok'; })()").catch(() => undefined);
		await page.evaluate<string>(SET_QUERY("")).catch(() => undefined);
		await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
	}
});

test("a run restored from an earlier Pi process is labelled in the list and in its facts", { skip }, async () => {
	const { page, store } = await fixture();
	const now = Date.now();
	store.restore({
		id: "held",
		handle: "run-9",
		role: "held-role",
		model: "opus",
		state: "done",
		startedAt: now - 4_000,
		endedAt: now,
		report: "## Changed\nfoo.ts",
		files: [{ path: "foo.ts", status: "M" }],
		usage: { costUsd: 0.25, tokensIn: 40, tokensOut: 9, toolCalls: 7 },
	});
	await page.open((await fixture()).url);
	const labelled = await page.until<string>(
		"the restored run is labelled",
		"(() => { const item = Array.from(document.querySelectorAll('.run')).find((node) => node.querySelector('.run-role').textContent === 'held-role'); const label = item && item.querySelector('.restored'); return label ? label.textContent : ''; })()",
		(text) => text !== "",
	);
	assert.equal(labelled, "restored");
	assert.equal(await page.evaluate<number>("document.querySelectorAll('.restored').length"), 1, "a run of this Pi session carries no such label");
	await page.evaluate<string>("(() => { Array.from(document.querySelectorAll('.run')).find((node) => node.querySelector('.run-role').textContent === 'held-role').click(); return 'ok'; })()");
	await page.until<string>("the restored run is shown", DETAIL_TITLE, (title) => title === "held-role");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Restored")), "from an earlier Pi process");
	assert.equal(await page.evaluate<string>(FACT_VALUE("Tool calls")), "7");
});
