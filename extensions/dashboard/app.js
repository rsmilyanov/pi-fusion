const POLL_MS = 1000;
const TICK_MS = 1000;
const TASK_COLUMNS = ["Name", "Type", "State", "Tokens", "Tool uses", "Forwarded", "Last tool", "Summary"];
const EMPTY_TEXT = "No runs yet. Runs appear when a fusion tool is called.";
const SCROLL_PANES = [".prompt", ".thinking", ".question", ".report", ".failure"];
const FILE_STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "committed", U: "reverted" };
const MODEL_COLUMNS = ["Model", "Input", "Output", "Cache read", "Cache write", "Cost"];
const STALL_MS = 60_000;
const LOG_KINDS = ["run", "tool", "agent", "task", "turn"];
const MD_INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|\*([^*\s](?:[^*\n]*[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const MD_FENCE = /^\s*(```|~~~)/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const MD_RULE = /^\s*([-*_])([ \t]*\1){2,}\s*$/;
const MD_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const MD_TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const CONTEXT_WARN = 0.7;
const CONTEXT_BAD = 0.9;
const COPIED_MS = 1200;
const PINNED_SLACK_PX = 40;
const PAGE_TITLE = "pi-fusion dashboard";
const NARROW_QUERY = "(max-width: 767px)";
const TABS = ["overview", "log", "tasks", "report"];

const cwdNode = document.getElementById("cwd");
const usageNode = document.getElementById("usage");
const bannerNode = document.getElementById("banner");
const attentionNode = document.getElementById("attention");
const runsNode = document.getElementById("runs");
const detailNode = document.getElementById("detail");
const layoutNode = document.getElementById("layout");
const runsToggle = document.getElementById("runs-toggle");

const state = {
	cwd: "",
	usage: null,
	runs: [],
	runsKey: "",
	attentionKey: "",
	runsSeq: 0,
	pinnedId: "",
	selectedId: "",
	detail: null,
	detailKey: "",
	detailSeq: 0,
	renderedId: "",
	log: null,
	openPrompts: new Set(),
	filter: null,
	rawReport: false,
	tab: "",
	tabRun: "",
	logSeen: -1,
	panelTops: {},
	runsOpen: false,
	connected: true,
	runClocks: [],
	detailClocks: [],
	runWatches: [],
	detailWatches: [],
};

const str = (value) => (typeof value === "string" ? value : "");

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

const list = (value) => (Array.isArray(value) ? value : []);

const pad = (value) => String(value).padStart(2, "0");

const sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const el = (tag, className, content) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (content !== undefined) node.textContent = String(content);
	return node;
};

const formatCount = (value) => num(value).toLocaleString("en-US");

const formatUsd = (value) => "$" + num(value).toFixed(num(value) < 1 ? 4 : 2);

const formatSeconds = (ms) => {
	const total = Math.max(0, Math.round(ms / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	if (hours > 0) return hours + "h " + pad(minutes) + "m";
	if (minutes > 0) return minutes + "m " + pad(seconds) + "s";
	return seconds + "s";
};

const formatTime = (at) => {
	const date = new Date(num(at));
	return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
};

const elapsed = (run, now) => (isNum(run.endedAt) ? run.endedAt : now) - num(run.startedAt);

const slug = (value) => str(value).replace(/[^A-Za-z]/g, "") || "unknown";

const flagBadge = (flag) => el("span", "flag flag-" + slug(flag), flag);

const statusPill = (status) => el("span", "status status-" + slug(status), str(status) || "unknown");

const quietFor = (run, now) => now - (isNum(run.lastEventAt) ? run.lastEventAt : num(run.startedAt));

const stalled = (run, now) => run.status === "running" && quietFor(run, now) >= STALL_MS;

const active = (run) => run.status === "running" || run.status === "waiting";

const addWatch = (watches, check) => {
	check(Date.now());
	watches.push(check);
};

const addClock = (clocks, node, format) => {
	node.textContent = format(Date.now());
	clocks.push({ node, format });
};

const tick = () => {
	const now = Date.now();
	for (const clock of state.runClocks) clock.node.textContent = clock.format(now);
	for (const clock of state.detailClocks) clock.node.textContent = clock.format(now);
	for (const check of state.runWatches) check(now);
	for (const check of state.detailWatches) check(now);
};

const shortId = (id) => str(id).slice(0, 8);

/** Runs grouped by the Pi session that made them, newest group first; each run's step counts from the group's first run. */
const chains = (runs) => {
	const groups = new Map();
	for (const run of runs) {
		const host = str(run.hostSessionId);
		if (!groups.has(host)) groups.set(host, []);
		groups.get(host).push(run);
	}
	const steps = new Map();
	for (const group of groups.values()) {
		const ordered = [...group].sort((a, b) => num(a.startedAt) - num(b.startedAt));
		ordered.forEach((run, at) => steps.set(run.id, { step: at + 1, of: ordered.length, ordered }));
	}
	return { groups, steps };
};

const runItem = (run, step) => {
	const active = run.id === state.selectedId;
	const item = el("button", active ? "run run-active" : "run");
	item.type = "button";
	item.dataset.id = str(run.id);
	if (active) item.setAttribute("aria-current", "true");
	if (run.status === "waiting") item.classList.add("run-waiting");
	const head = el("span", "run-head");
	const name = el("span", "run-name");
	if (step) name.appendChild(el("span", "run-step", "#" + step.step));
	name.appendChild(el("span", "run-role", str(run.role) || "run"));
	if (str(run.handle)) name.appendChild(el("span", "run-handle", str(run.handle)));
	head.appendChild(name);
	head.appendChild(statusPill(run.status));
	if (run.restored === true) head.appendChild(el("span", "restored", "restored"));
	item.appendChild(head);
	const flags = list(run.reportFlags).map(str).filter(Boolean);
	if (flags.length > 0) {
		const row = el("span", "run-flags");
		for (const flag of flags) row.appendChild(flagBadge(flag));
		item.appendChild(row);
	}
	item.appendChild(el("span", "run-model", run.background === true ? str(run.model) + " · background" : str(run.model)));
	if (str(run.question)) item.appendChild(el("span", "run-question", str(run.question)));
	const meta = el("span", "run-meta");
	const clock = el("span", "run-clock");
	clock.title = "elapsed";
	addClock(state.runClocks, clock, (now) => formatSeconds(elapsed(run, now)));
	meta.appendChild(clock);
	const tools = el("span", "run-count", formatCount(run.toolCalls) + " tools");
	tools.title = "root tool calls";
	meta.appendChild(tools);
	const agents = el("span", "run-count", formatCount(run.agentToolCalls) + " agent");
	agents.title = "forwarded agent tool calls";
	meta.appendChild(agents);
	if (isNum(run.filesChanged)) {
		const files = el("span", "run-count", formatCount(run.filesChanged) + (run.filesChanged === 1 ? " file" : " files"));
		files.title = "files changed";
		meta.appendChild(files);
	}
	if (isNum(run.costUsd)) {
		const cost = el("span", "run-count", formatUsd(run.costUsd));
		cost.title = "estimated cost";
		meta.appendChild(cost);
	}
	item.appendChild(meta);
	const quiet = el("span", "run-stall hidden");
	item.appendChild(quiet);
	addWatch(state.runWatches, (now) => {
		const on = stalled(run, now);
		item.classList.toggle("run-stalled", on);
		quiet.classList.toggle("hidden", !on);
		if (on) quiet.textContent = "no events for " + formatSeconds(quietFor(run, now));
	});
	item.addEventListener("click", () => selectRun(str(run.id)));
	return item;
};

const renderAttention = () => {
	const waiting = state.runs.filter((run) => run.status === "waiting");
	const key = JSON.stringify(waiting.map((run) => [str(run.id), str(run.role), str(run.handle), str(run.question)]));
	if (key === state.attentionKey) return;
	state.attentionKey = key;
	attentionNode.classList.toggle("hidden", waiting.length === 0);
	if (waiting.length === 0) {
		attentionNode.replaceChildren();
		document.title = PAGE_TITLE;
		return;
	}
	const focused = document.activeElement;
	const focusedId = focused && focused.classList.contains("attention-run") && attentionNode.contains(focused) ? focused.dataset.id : undefined;
	const frame = document.createDocumentFragment();
	frame.appendChild(el("span", "attention-label", "Needs input"));
	for (const run of waiting) {
		const button = el("button", "attention-run");
		button.type = "button";
		button.dataset.id = str(run.id);
		const role = str(run.role) || "run";
		button.appendChild(el("span", "attention-name", str(run.handle) ? role + " " + str(run.handle) : role));
		button.appendChild(el("span", "attention-question", str(run.question).split("\n")[0]));
		button.title = str(run.question);
		button.addEventListener("click", () => selectRun(str(run.id)));
		frame.appendChild(button);
	}
	attentionNode.replaceChildren(frame);
	document.title = "(" + waiting.length + ") " + PAGE_TITLE;
	if (focusedId === undefined) return;
	const again = Array.from(attentionNode.querySelectorAll(".attention-run")).find((node) => node.dataset.id === focusedId);
	if (again) again.focus({ preventScroll: true });
};

const renderRuns = () => {
	renderAttention();
	const focused = document.activeElement;
	const focusedId = focused && focused.classList.contains("run") && runsNode.contains(focused) ? focused.dataset.id : undefined;
	state.runClocks = [];
	state.runWatches = [];
	const frame = document.createDocumentFragment();
	const { groups, steps } = chains(state.runs);
	for (const [host, runs] of groups) {
		const header = el("div", "run-group", (host ? "Pi session " + shortId(host) : "Unknown Pi session") + " · " + runs.length + (runs.length === 1 ? " run" : " runs"));
		if (host) header.title = host;
		frame.appendChild(header);
		for (const run of runs) frame.appendChild(runItem(run, steps.get(run.id)));
	}
	runsNode.replaceChildren(frame);
	if (focusedId === undefined) return;
	const again = Array.from(runsNode.querySelectorAll(".run")).find((node) => node.dataset.id === focusedId);
	if (again) again.focus({ preventScroll: true });
};

runsNode.addEventListener("keydown", (event) => {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	const target = event.target;
	if (!target || !target.classList || !target.classList.contains("run")) return;
	event.preventDefault();
	const items = Array.from(runsNode.querySelectorAll(".run"));
	const next = items[items.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
	if (next) next.focus();
});

const addFact = (facts, label, value) => {
	facts.appendChild(el("dt", "fact-key", label));
	const cell = el("dd", "fact-value");
	if (typeof value === "string") cell.textContent = value;
	else cell.appendChild(value);
	facts.appendChild(cell);
};

const factsList = (detail) => {
	const facts = el("dl", "facts");
	addFact(facts, "Status", statusPill(detail.status));
	const clock = el("span", "fact-clock");
	addClock(state.detailClocks, clock, (now) => formatSeconds(elapsed(detail, now)));
	addFact(facts, "Elapsed", clock);
	const age = el("span", "fact-clock");
	addClock(state.detailClocks, age, (now) =>
		isNum(detail.lastEventAt) ? formatSeconds(now - detail.lastEventAt) + " ago" : "no events yet",
	);
	addFact(facts, "Last event", age);
	addWatch(state.detailWatches, (now) => age.classList.toggle("fact-warn", stalled(detail, now)));
	if (str(detail.activity)) addFact(facts, "Activity", str(detail.activity));
	addFact(facts, "Tool calls", formatCount(detail.toolCalls));
	addFact(facts, "Agent tool calls", formatCount(detail.agentToolCalls));
	const errors = el("span", num(detail.toolErrors) > 0 ? "fact-bad" : "", formatCount(detail.toolErrors));
	addFact(facts, "Tool errors", errors);
	addFact(facts, "Tokens in", formatCount(detail.tokensIn));
	addFact(facts, "Tokens out", formatCount(detail.tokensOut));
	addFact(facts, "Cache read", formatCount(detail.cacheRead));
	addFact(facts, "Cache write", formatCount(detail.cacheWrite));
	if (isNum(detail.workflowTokens)) addFact(facts, "Workflow agent tokens", formatCount(detail.workflowTokens));
	if (isNum(detail.costUsd)) addFact(facts, "Cost (estimate)", formatUsd(detail.costUsd));
	if (isNum(detail.numTurns)) addFact(facts, "Model turns", formatCount(detail.numTurns));
	if (isNum(detail.apiMs)) addFact(facts, "API time", formatSeconds(detail.apiMs));
	if (str(detail.modelId)) addFact(facts, "Model id", str(detail.modelId));
	if (isNum(detail.contextTokens) && isNum(detail.contextWindow) && detail.contextWindow > 0) addFact(facts, "Context", contextMeter(detail));
	if (str(detail.tool)) addFact(facts, "Pi tool", str(detail.tool));
	if (str(detail.toolCallId)) addFact(facts, "Pi tool call", str(detail.toolCallId));
	if (str(detail.hostSessionId)) addFact(facts, "Pi session", str(detail.hostSessionId));
	if (detail.restored === true) addFact(facts, "Restored", "from an earlier Pi process");
	if (str(detail.origin) && detail.origin !== "tool") addFact(facts, "Origin", str(detail.origin));
	if (str(detail.reviews)) addFact(facts, "Reviews", str(detail.reviews));
	if (str(detail.reviewedBy)) addFact(facts, "Reviewed by", str(detail.reviewedBy));
	if (str(detail.contract)) addFact(facts, "Contract", str(detail.contract));
	if (detail.session && typeof detail.session === "object") addFact(facts, "Claude session", sessionText(detail.session));
	const denied = list(detail.deniedTools).map(str).filter(Boolean);
	if (denied.length > 0) addFact(facts, "Denied tools", denied.join(", "));
	return facts;
};

const copyButton = (text) => {
	const button = el("button", "copy", "Copy");
	button.type = "button";
	button.addEventListener("click", () => {
		navigator.clipboard.writeText(text).then(
			() => {
				button.textContent = "Copied";
				setTimeout(() => {
					button.textContent = "Copy";
				}, COPIED_MS);
			},
			() => {
				button.textContent = "Copy failed";
			},
		);
	});
	return button;
};

const contextMeter = (detail) => {
	const share = Math.min(1, detail.contextTokens / detail.contextWindow);
	const meter = el("span", "context");
	const bar = el("span", "context-bar");
	const fill = el("span", "context-fill" + (share >= CONTEXT_BAD ? " context-bad" : share >= CONTEXT_WARN ? " context-warn" : ""));
	fill.style.width = (share * 100).toFixed(1) + "%";
	bar.appendChild(fill);
	meter.appendChild(bar);
	meter.appendChild(el("span", "context-text", formatCount(detail.contextTokens) + " / " + formatCount(detail.contextWindow) + " (" + Math.round(share * 100) + "%)"));
	return meter;
};

const section = (title, copyText) => {
	const node = el("section", "section");
	node.dataset.section = title;
	const head = el("div", "section-head");
	head.appendChild(el("h3", "section-title", title));
	if (copyText) head.appendChild(copyButton(copyText));
	node.appendChild(head);
	return node;
};

const sessionText = (session) => {
	const kind = str(session.kind);
	const at = str(session.at) ? " at " + str(session.at) : "";
	if (kind === "resume") return "resume " + str(session.id) + at;
	if (kind === "fork") return "fork of " + str(session.from) + at + " into " + str(session.id);
	return "new " + str(session.id);
};

const taskPrompt = (task) => {
	const box = el("details", "task-prompt");
	const id = str(task.id);
	box.open = state.openPrompts.has(id);
	box.addEventListener("toggle", () => {
		if (box.open) state.openPrompts.add(id);
		else state.openPrompts.delete(id);
	});
	box.appendChild(el("summary", "", "Prompt"));
	box.appendChild(el("pre", "call-body", str(task.prompt)));
	return box;
};

const taskExtraRow = (task) => {
	const phase = str(task.phase);
	const agents = list(task.agents);
	const prompt = str(task.prompt);
	if (!phase && agents.length === 0 && !prompt) return null;
	const row = el("tr", "task-extra");
	const cell = el("td", "task-extra-cell");
	cell.colSpan = TASK_COLUMNS.length;
	const chips = el("div", "chips");
	if (phase) chips.appendChild(el("span", "phase", phase));
	for (const agent of agents) {
		const label = str(agent && agent.label) || "agent";
		const agentState = str(agent && agent.state) || "unknown";
		chips.appendChild(el("span", "chip", label + ": " + agentState));
	}
	if (chips.firstChild) cell.appendChild(chips);
	if (prompt) cell.appendChild(taskPrompt(task));
	row.appendChild(cell);
	return row;
};

const taskRow = (task) => {
	const row = el("tr", "task");
	const name = el("td", "task-name");
	name.appendChild(el("span", "task-label", str(task.name) || str(task.id) || "task"));
	if (str(task.subagentType)) name.appendChild(el("span", "task-agent", str(task.subagentType)));
	row.appendChild(name);
	row.appendChild(el("td", "task-type", str(task.type) || "-"));
	const status = el("td", "task-state");
	status.appendChild(statusPill(task.status));
	row.appendChild(status);
	row.appendChild(el("td", "num", isNum(task.tokens) ? formatCount(task.tokens) : "-"));
	row.appendChild(el("td", "num", isNum(task.toolUses) ? formatCount(task.toolUses) : "-"));
	row.appendChild(el("td", "num", formatCount(task.agentToolCalls)));
	row.appendChild(el("td", "task-tool", str(task.lastTool) || "-"));
	row.appendChild(el("td", "task-summary", str(task.summary) || "-"));
	return row;
};

const MIN_BAR_SHARE = 0.005;

const placeBar = (bar, task, start, now, end) => {
	const span = Math.max(1, end - start);
	const from = Math.max(0, num(task.startedAt) - start) / span;
	const to = Math.min(1, ((isNum(task.endedAt) ? task.endedAt : now) - start) / span);
	bar.style.left = (from * 100).toFixed(2) + "%";
	bar.style.width = (Math.max(MIN_BAR_SHARE, to - from) * 100).toFixed(2) + "%";
};

/** One bar per task on the run's own clock; running bars and the axis grow with the page's one-second tick. */
const appendTimeline = (parent, detail, tasks) => {
	if (tasks.length === 0) return;
	const node = section("Timeline");
	const chart = el("div", "timeline");
	const start = num(detail.startedAt);
	const endOf = (now) => (isNum(detail.endedAt) ? detail.endedAt : now);
	for (const task of tasks) {
		const row = el("div", "timeline-row");
		row.appendChild(el("span", "timeline-label", str(task.name) || str(task.id) || "task"));
		const track = el("span", "timeline-track");
		const bar = el("span", "timeline-bar bar-" + slug(task.status));
		track.appendChild(bar);
		row.appendChild(track);
		chart.appendChild(row);
		addWatch(state.detailWatches, (now) => {
			placeBar(bar, task, start, now, endOf(now));
			bar.title = (str(task.name) || str(task.id)) + " · " + str(task.status) + " · " + formatSeconds((isNum(task.endedAt) ? task.endedAt : now) - num(task.startedAt));
		});
	}
	const axisRow = el("div", "timeline-row");
	axisRow.appendChild(el("span"));
	const axis = el("span", "timeline-axis");
	axis.appendChild(el("span", "", "0s"));
	const total = el("span");
	addClock(state.detailClocks, total, (now) => formatSeconds(endOf(now) - start));
	axis.appendChild(total);
	axisRow.appendChild(axis);
	chart.appendChild(axisRow);
	node.appendChild(chart);
	parent.appendChild(node);
};

const appendTasks = (parent, tasks) => {
	if (tasks.length === 0) return;
	const node = section("Tasks");
	const table = el("table", "tasks");
	const headRow = el("tr", "tasks-head");
	for (const column of TASK_COLUMNS) headRow.appendChild(el("th", "", column));
	const head = el("thead");
	head.appendChild(headRow);
	table.appendChild(head);
	const body = el("tbody");
	for (const task of tasks) {
		body.appendChild(taskRow(task));
		const extra = taskExtraRow(task);
		if (extra) body.appendChild(extra);
	}
	table.appendChild(body);
	node.appendChild(table);
	parent.appendChild(node);
};

const callBlock = (parent, title, body, truncated) => {
	parent.appendChild(el("div", "call-title", truncated ? title + " (truncated)" : title));
	parent.appendChild(el("pre", "call-body", body));
};

const loadCall = async (log, item) => {
	const seq = ++item.loads;
	let call;
	try {
		call = await fetchJson("api/runs/" + encodeURIComponent(log.runId) + "/calls/" + encodeURIComponent(item.toolUseId));
	} catch {
		if (seq === item.loads) item.detail.replaceChildren(el("div", "call-title", "No longer kept."));
		return;
	}
	if (seq !== item.loads || !item.open) return;
	const frame = document.createDocumentFragment();
	callBlock(frame, "Input", str(call.input) || "(none)", call.inputTruncated === true);
	if (typeof call.result === "string") callBlock(frame, call.isError === true ? "Error" : "Result", call.result || "(empty)", call.resultTruncated === true);
	else frame.appendChild(el("div", "call-title", "Waiting for the result."));
	item.detail.replaceChildren(frame);
};

const setCallState = (item, call) => {
	item.call = call;
	item.row.classList.toggle("call-pending", call === "pending");
	item.row.classList.toggle("call-error", call === "error");
};

const logRow = (log, entry) => {
	const row = el("li", "log-row");
	row.dataset.seq = String(num(entry.seq));
	row.dataset.kind = slug(entry.kind);
	row.appendChild(el("span", "log-time", formatTime(entry.at)));
	row.appendChild(el("span", "log-kind kind-" + slug(entry.kind), str(entry.kind) || "run"));
	row.appendChild(el("span", "log-text", str(entry.text)));
	const item = { row, call: "", toolUseId: str(entry.toolUseId), open: false, loads: 0, detail: null };
	if (item.toolUseId) {
		row.classList.add("log-call");
		row.title = "Show the input and the result";
		item.detail = el("div", "call-detail hidden");
		row.appendChild(item.detail);
		setCallState(item, str(entry.call));
		row.addEventListener("click", (event) => {
			if (item.detail.contains(event.target)) return;
			item.open = !item.open;
			item.detail.classList.toggle("hidden", !item.open);
			row.classList.toggle("log-open", item.open);
			if (item.open) {
				item.detail.replaceChildren(el("div", "call-title", "Loading."));
				loadCall(log, item).catch(() => {});
			}
		});
	}
	log.rows.set(num(entry.seq), item);
	return row;
};

const updateRow = (log, entry) => {
	const item = log.rows.get(num(entry.seq));
	if (!item || !item.toolUseId) return;
	const call = str(entry.call);
	if (call === item.call) return;
	setCallState(item, call);
	if (item.open) loadCall(log, item).catch(() => {});
};

const atBottom = (node) => node.scrollHeight - node.scrollTop - node.clientHeight < PINNED_SLACK_PX;

const showUnseen = (log) => {
	log.jump.textContent = log.unseen + " new ↓";
	log.jump.classList.toggle("hidden", log.unseen === 0);
};

const newLog = (runId) => {
	const log = { runId, node: el("ol", "log"), jump: el("button", "log-jump hidden"), rows: new Map(), lastSeq: -1, top: 0, pinned: true, unseen: 0 };
	log.jump.type = "button";
	log.jump.addEventListener("click", () => {
		log.node.scrollTop = log.node.scrollHeight;
	});
	log.node.addEventListener("scroll", () => {
		if (!atBottom(log.node)) return;
		log.unseen = 0;
		showUnseen(log);
	});
	return log;
};

/**
 * The log is one node per run that only gains and loses rows, so a render never rebuilds it. A log scrolled to its
 * bottom stays there as rows arrive; one scrolled up keeps the rows in view and counts what arrived below.
 */
const syncLog = (runId, entries) => {
	if (!state.log || state.log.runId !== runId) state.log = newLog(runId);
	const log = state.log;
	if (log.node.isConnected && log.node.clientHeight > 0) {
		log.pinned = atBottom(log.node);
		log.top = log.node.scrollTop;
	}
	const first = entries.length > 0 ? num(entries[0].seq) : Infinity;
	let dropped = 0;
	while (log.node.firstChild && Number(log.node.firstChild.dataset.seq) < first) {
		dropped += log.node.firstChild.offsetHeight;
		log.rows.delete(Number(log.node.firstChild.dataset.seq));
		log.node.firstChild.remove();
	}
	let added = 0;
	for (const entry of entries) {
		const seq = num(entry.seq);
		if (seq <= log.lastSeq) {
			updateRow(log, entry);
			continue;
		}
		log.node.appendChild(logRow(log, entry));
		log.lastSeq = seq;
		added++;
	}
	log.top = Math.max(0, log.top - dropped);
	log.unseen = log.pinned ? 0 : log.unseen + added;
	showUnseen(log);
	return log;
};

const rowMatches = (filter, row) => {
	if (filter.kinds.size > 0 && !filter.kinds.has(row.dataset.kind)) return false;
	if (filter.errors && !row.classList.contains("call-error")) return false;
	if (!filter.query) return true;
	const text = row.querySelector(".log-text");
	return (text ? text.textContent : "").toLowerCase().includes(filter.query);
};

const applyFilter = () => {
	const filter = state.filter;
	const log = state.log;
	if (!filter || !log) return;
	let shown = 0;
	for (const row of log.node.children) {
		const match = rowMatches(filter, row);
		row.classList.toggle("filtered", !match);
		if (match) shown++;
	}
	const total = log.node.children.length;
	filter.count.textContent = shown === total ? total + " entries" : shown + " of " + total + " entries";
	filter.clear.classList.toggle("hidden", !filterActive(filter));
};

const filterActive = (filter) => filter.query !== "" || filter.kinds.size > 0 || filter.errors;

const clearFilter = (filter) => {
	filter.search.value = "";
	filter.query = "";
	filter.kinds.clear();
	filter.errors = false;
	for (const chip of filter.chips) chip.setAttribute("aria-pressed", "false");
	applyFilter();
};

const filterChip = (filter, label, pressed, toggle) => {
	const chip = el("button", "filter-chip", label);
	chip.type = "button";
	chip.setAttribute("aria-pressed", String(pressed));
	chip.addEventListener("click", () => {
		chip.setAttribute("aria-pressed", String(toggle()));
		applyFilter();
	});
	filter.node.appendChild(chip);
	filter.chips.push(chip);
};

/** Built once, so typing in the search box survives the renders that a live run triggers every second. */
const logFilter = () => {
	if (state.filter) return state.filter;
	const filter = { query: "", kinds: new Set(), errors: false, chips: [], node: el("div", "log-filter"), count: el("span", "log-count") };
	const search = el("input", "log-search");
	search.type = "search";
	search.placeholder = "Filter the log  /";
	search.setAttribute("aria-label", "Filter the log");
	search.addEventListener("input", () => {
		filter.query = search.value.trim().toLowerCase();
		applyFilter();
	});
	filter.search = search;
	filter.node.appendChild(search);
	for (const kind of LOG_KINDS) {
		filterChip(filter, kind, false, () => {
			if (filter.kinds.has(kind)) filter.kinds.delete(kind);
			else filter.kinds.add(kind);
			return filter.kinds.has(kind);
		});
	}
	filterChip(filter, "errors", false, () => (filter.errors = !filter.errors));
	filter.clear = el("button", "copy filter-clear hidden", "Clear");
	filter.clear.type = "button";
	filter.clear.addEventListener("click", () => {
		clearFilter(filter);
		search.focus();
	});
	filter.node.appendChild(filter.clear);
	filter.node.appendChild(filter.count);
	state.filter = filter;
	return filter;
};

document.addEventListener("keydown", (event) => {
	if (state.runsOpen) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		showRuns(false);
		runsToggle.focus({ preventScroll: true });
		return;
	}
	const filter = state.filter;
	if (!filter || !filter.search.isConnected) return;
	const target = event.target;
	if (event.key === "Escape") {
		const editable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
		if ((editable && target !== filter.search) || !filterActive(filter)) return;
		event.preventDefault();
		clearFilter(filter);
		return;
	}
	if (event.key !== "/") return;
	if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
	event.preventDefault();
	if (state.tab !== "log") selectTab("log");
	filter.search.focus();
});

const restoreLog = () => {
	const log = state.log;
	if (!log || !log.node.isConnected) return;
	log.node.scrollTop = log.pinned ? log.node.scrollHeight : log.top;
};

const appendModels = (parent, models) => {
	if (models.length === 0) return;
	const node = section("Models");
	const table = el("table", "tasks models");
	const headRow = el("tr", "tasks-head");
	for (const column of MODEL_COLUMNS) headRow.appendChild(el("th", "", column));
	const head = el("thead");
	head.appendChild(headRow);
	table.appendChild(head);
	const body = el("tbody");
	for (const model of models) {
		const row = el("tr");
		row.appendChild(el("td", "task-tool", str(model.model)));
		row.appendChild(el("td", "num", formatCount(model.inputTokens)));
		row.appendChild(el("td", "num", formatCount(model.outputTokens)));
		row.appendChild(el("td", "num", formatCount(model.cacheRead)));
		row.appendChild(el("td", "num", formatCount(model.cacheWrite)));
		row.appendChild(el("td", "num", formatUsd(model.costUsd)));
		body.appendChild(row);
	}
	table.appendChild(body);
	node.appendChild(table);
	parent.appendChild(node);
};

const appendFiles = (parent, detail) => {
	if (!Array.isArray(detail.files)) return;
	const files = detail.files;
	const node = section("Files changed");
	if (files.length === 0) {
		node.appendChild(el("p", "empty-note", "No file changed in the working tree."));
		parent.appendChild(node);
		return;
	}
	if (detail.filesTruncated === true) node.appendChild(el("p", "note", "showing " + files.length + " of " + formatCount(detail.filesChanged) + " files"));
	const table = el("table", "tasks files");
	const body = el("tbody");
	for (const file of files) {
		const row = el("tr");
		const letter = str(file.status);
		const status = el("td", "file-status file-" + slug(letter), letter);
		status.title = FILE_STATUS[letter] || letter;
		row.appendChild(status);
		row.appendChild(el("td", "file-path", str(file.path)));
		const lines = el("td", "num file-lines");
		if (isNum(file.added)) lines.appendChild(el("span", "file-added", "+" + formatCount(file.added)));
		if (isNum(file.removed)) lines.appendChild(el("span", "file-removed", "−" + formatCount(file.removed)));
		row.appendChild(lines);
		body.appendChild(row);
	}
	table.appendChild(body);
	node.appendChild(table);
	parent.appendChild(node);
};

const appendThinking = (parent, blocks) => {
	const texts = blocks.map(str).filter(Boolean);
	if (texts.length === 0) return;
	const node = section("Latest thinking");
	const pane = el("div", "thinking");
	for (const text of texts) pane.appendChild(el("pre", "thinking-block", text));
	node.appendChild(pane);
	parent.appendChild(node);
};

const appendLog = (parent, runId, entries) => {
	if (entries.length === 0) {
		parent.appendChild(el("p", "empty", "No log entries yet."));
		return;
	}
	const log = syncLog(runId, entries);
	const bar = el("div", "log-bar");
	bar.appendChild(logFilter().node);
	parent.appendChild(bar);
	const pane = el("div", "log-pane");
	pane.appendChild(log.node);
	pane.appendChild(log.jump);
	parent.appendChild(pane);
};

const inline = (parent, text) => {
	let last = 0;
	for (const match of text.matchAll(MD_INLINE)) {
		if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
		if (match[1] !== undefined) parent.appendChild(el("code", "md-code", match[1]));
		else if (match[2] !== undefined) inline(parent.appendChild(el("strong")), match[2]);
		else if (match[3] !== undefined) inline(parent.appendChild(el("em")), match[3]);
		else {
			const link = el("span", "md-link", match[4]);
			link.title = match[5];
			parent.appendChild(link);
		}
		last = match.index + match[0].length;
	}
	if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
};

const buildList = (items, start, indent) => {
	const node = el(/^\d/.test(items[start].marker) ? "ol" : "ul", "md-list");
	let index = start;
	while (index < items.length && items[index].indent >= indent) {
		const item = items[index];
		if (item.indent > indent) {
			const [sub, next] = buildList(items, index, item.indent);
			(node.lastElementChild || node.appendChild(el("li"))).appendChild(sub);
			index = next;
			continue;
		}
		inline(node.appendChild(el("li")), item.text);
		index++;
	}
	return [node, index];
};

const cells = (line) =>
	line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());

const buildTable = (rows) => {
	const table = el("table", "md-table");
	const head = el("thead").appendChild(el("tr"));
	for (const cell of cells(rows[0])) inline(head.appendChild(el("th")), cell);
	table.appendChild(head.parentNode);
	const body = el("tbody");
	for (const row of rows.slice(2)) {
		const line = body.appendChild(el("tr"));
		for (const cell of cells(row)) inline(line.appendChild(el("td")), cell);
	}
	table.appendChild(body);
	return table;
};

/**
 * A small Markdown subset built as DOM nodes, never as markup: a report is the child's output and is not trusted. A line
 * break inside a paragraph is kept, as in GitHub comments, because the contracts ask for one line per file.
 */
const renderMarkdown = (parent, text) => {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let paragraph = [];
	const flush = () => {
		if (paragraph.length === 0) return;
		const node = parent.appendChild(el("p"));
		paragraph.forEach((text, at) => {
			if (at > 0) node.appendChild(el("br"));
			inline(node, text);
		});
		paragraph = [];
	};
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		const fence = MD_FENCE.exec(line);
		if (fence) {
			flush();
			const body = [];
			index++;
			while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
			parent.appendChild(el("pre", "md-pre", body.join("\n")));
			index++;
			continue;
		}
		const heading = MD_HEADING.exec(line);
		if (heading) {
			flush();
			const node = el("h" + Math.min(6, heading[1].length + 2), "md-heading");
			node.dataset.heading = heading[2].toLowerCase();
			inline(node, heading[2]);
			parent.appendChild(node);
			index++;
			continue;
		}
		if (MD_RULE.test(line)) {
			flush();
			parent.appendChild(el("hr", "md-rule"));
			index++;
			continue;
		}
		if (MD_ITEM.test(line)) {
			flush();
			const items = [];
			while (index < lines.length && lines[index].trim()) {
				const item = MD_ITEM.exec(lines[index]);
				if (item) items.push({ indent: item[1].length, marker: item[2], text: item[3] });
				else if (/^\s/.test(lines[index]) && items.length > 0) items[items.length - 1].text += " " + lines[index].trim();
				else break;
				index++;
			}
			parent.appendChild(buildList(items, 0, items[0].indent)[0]);
			continue;
		}
		if (line.includes("|") && index + 1 < lines.length && MD_TABLE_RULE.test(lines[index + 1]) && lines[index + 1].includes("-")) {
			flush();
			const rows = [];
			while (index < lines.length && lines[index].includes("|")) rows.push(lines[index++]);
			parent.appendChild(buildTable(rows));
			continue;
		}
		if (/^\s*>/.test(line)) {
			flush();
			const quote = [];
			while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
			renderMarkdown(parent.appendChild(el("blockquote", "md-quote")), quote.join("\n"));
			continue;
		}
		if (line.trim()) paragraph.push(line.trim());
		else flush();
		index++;
	}
	flush();
};

const appendReport = (parent, detail) => {
	const body = str(detail.text);
	if (!body) return;
	const node = section("Report", body);
	const raw = el("button", "copy", state.rawReport ? "Formatted" : "Raw");
	raw.type = "button";
	raw.addEventListener("click", () => {
		state.rawReport = !state.rawReport;
		renderDetail();
	});
	node.firstChild.appendChild(raw);
	if (detail.textTruncated === true) node.appendChild(el("p", "note", "truncated"));
	if (state.rawReport) node.appendChild(el("pre", "report", body));
	else {
		const report = el("div", "report md");
		renderMarkdown(report, body);
		node.appendChild(report);
	}
	parent.appendChild(node);
};

const appendBlock = (parent, title, body, truncated, className, copy) => {
	if (!body) return;
	const node = section(title, copy ? body : "");
	if (truncated === true) node.appendChild(el("p", "note", "truncated"));
	node.appendChild(el("pre", className, body));
	parent.appendChild(node);
};

const appendResume = (parent, sessionId) => {
	if (!sessionId) return;
	const line = el("p", "resume");
	line.appendChild(el("code", "resume-command", "claude --resume " + sessionId));
	line.appendChild(copyButton("claude --resume " + sessionId));
	parent.appendChild(line);
};

const appendChain = (parent, detail) => {
	const step = chains(state.runs).steps.get(str(detail.id));
	if (!step || step.of < 2) return;
	const chain = el("nav", "chain");
	chain.setAttribute("aria-label", "Runs of this Pi session");
	step.ordered.forEach((run, at) => {
		if (at > 0) chain.appendChild(el("span", "chain-arrow", "→"));
		const link = el("button", run.id === detail.id ? "chain-step chain-current" : "chain-step", at + 1 + " " + str(run.role));
		link.type = "button";
		link.title = str(run.status);
		link.classList.add("chain-" + slug(run.status));
		link.addEventListener("click", () => selectRun(str(run.id)));
		chain.appendChild(link);
	});
	parent.appendChild(chain);
};

const stat = (line, value, label) => {
	const node = el("span", "stat");
	const strong = el("b");
	if (typeof value === "string") strong.textContent = value;
	else strong.appendChild(value);
	node.appendChild(strong);
	if (label) node.appendChild(document.createTextNode(" " + label));
	line.appendChild(node);
};

const statsLine = (detail) => {
	const line = el("p", "stats");
	const clock = el("span");
	addClock(state.detailClocks, clock, (now) => formatSeconds(elapsed(detail, now)));
	stat(line, clock, "elapsed");
	const age = el("span");
	addClock(state.detailClocks, age, (now) => (isNum(detail.lastEventAt) ? formatSeconds(now - detail.lastEventAt) + " ago" : "no events yet"));
	addWatch(state.detailWatches, (now) => age.classList.toggle("fact-warn", stalled(detail, now)));
	stat(line, age, "last event");
	stat(line, formatCount(detail.toolCalls), "tools");
	if (num(detail.toolErrors) > 0) stat(line, el("span", "fact-bad", formatCount(detail.toolErrors)), "errors");
	stat(line, formatCount(detail.tokensIn), "in");
	stat(line, formatCount(detail.tokensOut), "out");
	if (isNum(detail.costUsd)) stat(line, formatUsd(detail.costUsd), "");
	if (isNum(detail.contextTokens) && isNum(detail.contextWindow) && detail.contextWindow > 0) line.appendChild(contextMeter(detail));
	if (str(detail.activity)) {
		const now = el("span", "stat", "now ");
		now.appendChild(el("b", "", str(detail.activity)));
		line.appendChild(now);
	}
	return line;
};

const defaultTab = (detail) => (active(detail) ? "log" : str(detail.text) || str(detail.failure) ? "report" : "overview");

const panel = (key) => {
	const node = el("section", key === "log" ? "panel panel-log" : "panel");
	node.id = "panel-" + key;
	node.dataset.tab = key;
	node.setAttribute("role", "tabpanel");
	return node;
};

const selectTab = (tab) => {
	if (state.tab === tab) return;
	state.tab = tab;
	renderDetail();
	const button = detailNode.querySelector('.tab[aria-selected="true"]');
	if (button) button.focus({ preventScroll: true });
};

/** The Log badge counts the rows that arrived while another tab was shown, from the last row seen on the Log tab. */
const tabStrip = (detail, panels) => {
	const entries = list(detail.log);
	const lastSeq = entries.length > 0 ? num(entries[entries.length - 1].seq) : -1;
	const unseen = state.tab !== "log" && state.logSeen >= 0 ? Math.max(0, lastSeq - state.logSeen) : 0;
	if (state.tab === "log") state.logSeen = lastSeq;
	const tasks = list(detail.tasks);
	const running = tasks.filter((task) => task.status === "running").length;
	const flags = list(detail.reportFlags).length;
	const failed = str(detail.failure) !== "";
	const labels = {
		overview: ["Overview", "", ""],
		log: ["Log", unseen > 0 ? "+" + unseen : entries.length > 0 ? formatCount(entries.length) : "", unseen > 0 ? "hot" : ""],
		tasks: ["Tasks", running > 0 ? running + " running" : tasks.length > 0 ? formatCount(tasks.length) : "", running > 0 ? "hot" : ""],
		report: [failed ? "Failure" : "Report", failed ? "!" : flags > 0 ? String(flags) : "", failed ? "bad" : flags > 0 ? "hot" : ""],
	};
	const strip = el("div", "tabs");
	strip.setAttribute("role", "tablist");
	for (const key of TABS) {
		const [label, badge, tone] = labels[key];
		const tab = el("button", "tab", label);
		tab.type = "button";
		tab.dataset.tab = key;
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", String(key === state.tab));
		tab.setAttribute("aria-controls", panels[key].id);
		if (badge) tab.appendChild(el("span", tone ? "badge badge-" + tone : "badge", badge));
		tab.addEventListener("click", () => selectTab(key));
		strip.appendChild(tab);
	}
	strip.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		const next = TABS[TABS.indexOf(state.tab) + (event.key === "ArrowRight" ? 1 : -1)];
		if (!next) return;
		event.preventDefault();
		selectTab(next);
	});
	return strip;
};

const appendDetail = (parent, detail) => {
	const top = el("div", "detail-top");
	const head = el("header", "detail-head");
	const titleRow = el("div", "detail-title-row");
	titleRow.appendChild(el("h2", "detail-title", str(detail.role) || "run"));
	titleRow.appendChild(statusPill(detail.status));
	head.appendChild(titleRow);
	head.appendChild(el("p", "detail-model", str(detail.handle) ? str(detail.handle) + " · " + str(detail.model) : str(detail.model)));
	if (str(detail.title)) head.appendChild(el("p", "detail-subtitle", str(detail.title)));
	appendChain(head, detail);
	const flags = list(detail.reportFlags).map(str).filter(Boolean);
	if (flags.length > 0) {
		const row = el("p", "detail-flags");
		for (const flag of flags) {
			const badge = el("button", "flag flag-" + slug(flag), flag);
			badge.type = "button";
			badge.title = "Go to " + flag + " in the report";
			badge.addEventListener("click", () => {
				selectTab("report");
				const target = Array.from(detailNode.querySelectorAll(".report .md-heading")).find((node) => node.dataset.heading === flag.toLowerCase());
				if (target) target.scrollIntoView({ block: "start" });
			});
			row.appendChild(badge);
		}
		head.appendChild(row);
	}
	top.appendChild(head);
	appendBlock(top, "Question", str(detail.question), false, "question");
	top.appendChild(statsLine(detail));
	if (state.tabRun !== str(detail.id)) {
		state.tabRun = str(detail.id);
		state.tab = defaultTab(detail);
		state.logSeen = -1;
		state.panelTops = {};
	}
	const panels = { overview: panel("overview"), log: panel("log"), tasks: panel("tasks"), report: panel("report") };
	panels.overview.appendChild(factsList(detail));
	appendBlock(panels.overview, "Prompt", str(detail.prompt), detail.promptTruncated, "prompt", true);
	appendModels(panels.overview, list(detail.models));
	appendFiles(panels.overview, detail);
	appendResume(panels.overview, str(detail.sessionId));
	appendLog(panels.log, str(detail.id), list(detail.log));
	appendTimeline(panels.tasks, detail, list(detail.tasks));
	appendTasks(panels.tasks, list(detail.tasks));
	appendThinking(panels.tasks, list(detail.thinking));
	if (!panels.tasks.firstChild) panels.tasks.appendChild(el("p", "empty", "No tasks yet."));
	appendReport(panels.report, detail);
	appendBlock(panels.report, "Failure", str(detail.failure), detail.failureTruncated, "failure");
	if (!panels.report.firstChild) panels.report.appendChild(el("p", "empty", active(detail) ? "The report arrives when the run ends." : "No report."));
	top.appendChild(tabStrip(detail, panels));
	parent.appendChild(top);
	for (const key of TABS) {
		panels[key].classList.toggle("hidden", key !== state.tab);
		parent.appendChild(panels[key]);
	}
};

const captureScroll = () => {
	for (const node of detailNode.querySelectorAll(".panel")) if (node.clientHeight > 0) state.panelTops[node.dataset.tab] = node.scrollTop;
	const panes = [];
	for (const selector of SCROLL_PANES) {
		const node = detailNode.querySelector(selector);
		if (node) panes.push({ selector, top: node.scrollTop, left: node.scrollLeft });
	}
	const sections = Array.from(detailNode.querySelectorAll(".section"))
		.filter((node) => node.scrollLeft > 0)
		.map((node) => ({ section: node.dataset.section, left: node.scrollLeft }));
	return { panes, sections };
};

const restoreScroll = (kept) => {
	for (const pane of kept.panes) {
		const node = detailNode.querySelector(pane.selector);
		if (!node) continue;
		node.scrollTop = pane.top;
		node.scrollLeft = pane.left;
	}
	const current = Array.from(detailNode.querySelectorAll(".section"));
	for (const saved of kept.sections) {
		const node = current.find((candidate) => candidate.dataset.section === saved.section);
		if (node) node.scrollLeft = saved.left;
	}
	for (const node of detailNode.querySelectorAll(".panel")) {
		const top = state.panelTops[node.dataset.tab];
		if (isNum(top)) node.scrollTop = top;
	}
};

/** Moving the search box to the new frame blurs it, so a render hands the focus and the caret back. */
const renderDetail = () => {
	const search = state.filter && document.activeElement === state.filter.search ? state.filter.search : null;
	const caret = search ? [search.selectionStart, search.selectionEnd] : null;
	state.detailClocks = [];
	state.detailWatches = [];
	const id = state.runs.length > 0 && state.detail ? str(state.detail.id) : "";
	const kept = id !== "" && id === state.renderedId ? captureScroll() : null;
	const frame = document.createDocumentFragment();
	if (state.runs.length === 0) frame.appendChild(el("p", "empty", EMPTY_TEXT));
	else if (!state.detail) frame.appendChild(el("p", "empty", "Loading run."));
	else appendDetail(frame, state.detail);
	detailNode.replaceChildren(frame);
	if (search && search.isConnected) {
		search.focus({ preventScroll: true });
		search.setSelectionRange(caret[0], caret[1]);
	}
	applyFilter();
	if (kept) restoreScroll(kept);
	restoreLog();
	state.renderedId = id;
};

const setConnected = (connected) => {
	if (state.connected === connected) return;
	state.connected = connected;
	bannerNode.classList.toggle("hidden", connected);
};

const chooseSelection = () => {
	if (state.pinnedId && state.runs.some((run) => run.id === state.pinnedId)) return state.pinnedId;
	state.pinnedId = "";
	const running = state.runs.find(active);
	if (running) return str(running.id);
	return state.runs.length > 0 ? str(state.runs[0].id) : "";
};

const usageText = (usage) => {
	const parts = [
		formatUsd(usage.costUsd) + " est.",
		formatCount(usage.tokensIn) + " in",
		formatCount(usage.tokensOut) + " out",
		formatCount(usage.workflowTokens) + " workflow tokens",
		formatCount(usage.calls) + " calls",
	];
	const warn = list(usage.warnUsd).filter(isNum);
	if (warn.length > 0) parts.push("warn at " + warn.map(formatUsd).join(", "));
	if (isNum(usage.limitUsd)) parts.push("limit " + formatUsd(usage.limitUsd));
	return "Session usage: " + parts.join(" · ");
};

const applyUsage = (payload) => {
	const usage = payload && typeof payload.usage === "object" && payload.usage !== null ? payload.usage : null;
	const text = usage ? usageText(usage) : "";
	if (text === state.usage) return;
	state.usage = text;
	usageNode.textContent = text;
	usageNode.classList.toggle("hidden", text === "");
};

const applyRuns = (payload) => {
	const cwd = str(payload && payload.cwd);
	if (cwd !== state.cwd) {
		state.cwd = cwd;
		cwdNode.textContent = cwd;
	}
	applyUsage(payload);
	state.runs = list(payload && payload.runs).filter((run) => run && typeof run.id === "string");
	const key = JSON.stringify(state.runs);
	const selected = chooseSelection();
	if (key === state.runsKey && selected === state.selectedId) return;
	state.runsKey = key;
	state.selectedId = selected;
	renderRuns();
};

const fetchJson = async (path) => {
	const response = await fetch(path, { cache: "no-store", headers: { accept: "application/json" } });
	if (!response.ok) throw new Error("HTTP " + response.status);
	return await response.json();
};

const syncDetail = async () => {
	const id = state.selectedId;
	if (!id) {
		if (state.detail || state.detailKey) {
			state.detail = null;
			state.detailKey = "";
			renderDetail();
		}
		return;
	}
	const summary = state.runs.find((run) => run.id === id);
	const key = id + ":" + num(summary && summary.updatedAt);
	if (key === state.detailKey) return;
	const seq = ++state.detailSeq;
	let detail;
	try {
		detail = await fetchJson("api/runs/" + encodeURIComponent(id));
	} catch {
		return;
	}
	if (seq !== state.detailSeq || state.selectedId !== id) return;
	state.detailKey = key;
	state.detail = detail;
	renderDetail();
};

const showRuns = (open) => {
	state.runsOpen = open;
	layoutNode.classList.toggle("runs-open", open);
	runsToggle.setAttribute("aria-expanded", String(open));
	detailNode.inert = open;
	if (!open) return;
	const target = runsNode.querySelector(".run-active") || runsNode.querySelector(".run");
	if (target) target.focus({ preventScroll: true });
};

const selectRun = (id) => {
	state.pinnedId = id;
	if (state.runsOpen) {
		showRuns(false);
		runsToggle.focus({ preventScroll: true });
	}
	if (state.selectedId === id) return;
	state.selectedId = id;
	state.detail = null;
	state.detailKey = "";
	renderRuns();
	renderDetail();
	syncDetail().catch(() => {});
};

const pollRuns = async () => {
	const seq = ++state.runsSeq;
	let payload;
	try {
		payload = await fetchJson("api/runs");
	} catch {
		setConnected(false);
		return;
	}
	if (seq !== state.runsSeq) return;
	setConnected(true);
	applyRuns(payload);
	await syncDetail();
};

const loop = async () => {
	for (;;) {
		try {
			await pollRuns();
		} catch {
			setConnected(false);
		}
		await sleep(POLL_MS);
	}
};

runsToggle.addEventListener("click", () => showRuns(!state.runsOpen));
window.matchMedia(NARROW_QUERY).addEventListener("change", (event) => {
	if (!event.matches && state.runsOpen) showRuns(false);
});
renderDetail();
setInterval(tick, TICK_MS);
loop();
