import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bodyLines, Card, CARD_FILES, CARD_QUESTION_CHARS, CARD_REPORT_LINES, cardDetails, headerLine, plainText, widgetLines } from "../extensions/cards.ts";

/** A theme that names what it paints, so a test reads the colors out of the line. */
const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<b>${text}</b>` };

const STATS = "[run-1 · implement · opus · 3s · 2 tool calls · in 10 out 5]";
const REVIEW = "run-2 reviews this run in the background; its report arrives as a message.";
const HINT = (handle: string) => `<muted>answer: /fusion answer ${handle} <text> or claude_control message</muted>`;

test("a header names the run, what became of it, its time, its files and its cost", () => {
	assert.equal(
		headerLine(theme, { label: "claude", details: { handle: "run-3", role: "implement", model: "opus", state: "done", elapsedMs: 12_400, filesChanged: 2, costUsd: 0.2534 } }),
		"<toolTitle><b>claude</b></toolTitle> implement run-3 · <success>done</success> · 12s · 2 files · $0.2534",
	);
	assert.equal(
		headerLine(theme, { label: "claude", details: { handle: "run-4", role: "ask", reviews: "run-1", state: "running", elapsedMs: 900 } }),
		"<toolTitle><b>claude</b></toolTitle> ask, review of run-1 run-4 · <warning>running</warning> · 1s",
	);
	assert.equal(
		headerLine(theme, { label: "claude", details: { handle: "run-1", state: "done", costUsd: 12.5, reviewedBy: "run-2" } }),
		"<toolTitle><b>claude</b></toolTitle> run-1 · <success>done</success> · $12.50 · reviewed by run-2",
	);
	assert.equal(headerLine(theme, { label: "claude_control status", details: {} }), "<toolTitle><b>claude_control status</b></toolTitle>", "a header carries only the parts it has");
	assert.equal(
		headerLine(theme, { label: "user steer", details: { handle: "run-1" }, color: "customMessageLabel" }),
		"<customMessageLabel><b>user steer</b></customMessageLabel> run-1",
		"a message labels itself as a message, not as a tool",
	);
});

test("a header colors the state by what it means for the host", () => {
	for (const [state, color] of [
		["done", "success"],
		["running", "warning"],
		["waiting", "warning"],
		["failed", "error"],
		["aborted", "error"],
		["cancelled", "error"],
		["ended", "muted"],
		["toString", "muted"],
		["constructor", "muted"],
	] as const) {
		assert.equal(headerLine(theme, { label: "claude", details: { state } }), `<toolTitle><b>claude</b></toolTitle> · <${color}>${state}</${color}>`, state);
	}
});

test("cardDetails reads what it knows, checks every type and caps the file list", () => {
	assert.deepEqual(
		cardDetails({
			handle: "run-1",
			role: "implement",
			model: "opus",
			state: "done",
			elapsedMs: 1_000,
			costUsd: 0.25,
			filesChanged: 3,
			files: ["a.ts", 7, "", "b.ts"],
			background: true,
			reviewedBy: "run-2",
			usage: { calls: 1 },
			prompt: "not a card field",
		}),
		{
			handle: "run-1",
			role: "implement",
			model: "opus",
			state: "done",
			elapsedMs: 1_000,
			costUsd: 0.25,
			filesChanged: 3,
			files: ["a.ts", "b.ts"],
			background: true,
			reviewedBy: "run-2",
			usage: { calls: 1 },
		},
	);
	assert.deepEqual(cardDetails({ handle: 7, state: null, elapsedMs: "3", costUsd: Number.NaN, files: "a.ts", background: "yes" }), {}, "a field of the wrong type is no field");
	for (const value of [undefined, null, "text", 7, []]) assert.deepEqual(cardDetails(value), {}, JSON.stringify(value) ?? "undefined");
	const many = Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`);
	assert.equal(cardDetails({ files: many }).files?.length, CARD_FILES);
});

test("a collapsed card shows the first report lines, drops the stats and review lines and counts what is left", () => {
	const report = `## Changed\n\nfoo.ts\nbar.ts\nbaz.ts\n\n${STATS}\n\n${REVIEW}`;
	assert.deepEqual(bodyLines(theme, report, { expanded: false }), ["## Changed", "foo.ts", "bar.ts", "<muted>… 1 more lines, ctrl+o to expand</muted>"]);
	assert.equal(CARD_REPORT_LINES, 3);
	assert.deepEqual(bodyLines(theme, `done\n\n${STATS}\n\n${REVIEW}`, { expanded: false }), ["done"], "the lines that end a report are not report lines");
	assert.deepEqual(bodyLines(theme, "one\ntwo\nthree", { expanded: false }), ["one", "two", "three"], "a report that fits is counted for nobody");
	assert.equal(bodyLines(theme, Array.from({ length: 20 }, (_unused, index) => `line ${index}`).join("\n"), { expanded: false }).at(-1), "<muted>… 17 more lines, ctrl+o to expand</muted>");
});

test("a collapsed card of a waiting run shows the question and how to answer it", () => {
	assert.deepEqual(bodyLines(theme, "run-1 (implement) asks:\n\nWhich name?", { expanded: false, question: "Which name?\nA or B?", handle: "run-1" }), [
		"<warning>Which name?</warning>",
		HINT("run-1"),
	]);
});

test("an expanded card marks the headings the host must act on and leaves the rest of the report alone", () => {
	const text = "## Changed\nfoo.ts\n## Escalation\nneeds a decision\n### open questions\nwhat now\n# Review\nfine\n#### Verification\nnpm test";
	assert.deepEqual(bodyLines(theme, text, { expanded: true }), [
		"<mdHeading>## Changed</mdHeading>",
		"foo.ts",
		"<b><warning>## Escalation</warning></b>",
		"needs a decision",
		"<b><warning>### open questions</warning></b>",
		"what now",
		"<b><warning># Review</warning></b>",
		"fine",
		"<mdHeading>#### Verification</mdHeading>",
		"npm test",
	]);
});

test("an expanded card lists the changed paths and says how many it left out", () => {
	const files = Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`);
	const lines = bodyLines(theme, "## Changed", { expanded: true, files, filesChanged: 60 });
	assert.equal(lines[0], "<mdHeading>## Changed</mdHeading>");
	assert.equal(lines[1], "<muted>files (60)</muted>");
	assert.equal(lines[2], "src/file-0.ts");
	assert.equal(lines.length, 2 + CARD_FILES + 1);
	assert.equal(lines.at(-1), "<muted>… 10 more</muted>");
	assert.deepEqual(bodyLines(theme, "## Changed", { expanded: true, files: files.slice(0, 2), filesChanged: 2 }), ["<mdHeading>## Changed</mdHeading>", "<muted>files (2)</muted>", "src/file-0.ts", "src/file-1.ts"]);
	assert.deepEqual(bodyLines(theme, "done", { expanded: true, files: [], filesChanged: 0 }), ["done"], "a run that changed nothing lists nothing");
});

test("an expanded card carries the whole question, capped, and how to answer it", () => {
	const lines = bodyLines(theme, "", { expanded: true, question: "Q".repeat(500), handle: "run-3" });
	assert.equal(lines.at(-2), `<warning>${"Q".repeat(CARD_QUESTION_CHARS)}</warning>`);
	assert.equal(lines.at(-1), HINT("run-3"));
	const lines2 = bodyLines(theme, "asked", { expanded: true, question: "Which name?\nA or B?", handle: "run-3" });
	assert.deepEqual(lines2, ["asked", "<warning>Which name?</warning>", "<warning>A or B?</warning>", HINT("run-3")], "every line of a question carries its own color");
});

const CJK = "日本語のテキスト";
const EMOJI = "🙂";

const content = [
	"a short line",
	"x".repeat(300),
	CJK.repeat(30),
	`${EMOJI} emoji and then a very long tail ${"b".repeat(200)}`,
	theme.fg("warning", `colored ${"c".repeat(120)}`),
	"",
];

test("a card never draws a line wider than the width it was given, wrapped or truncated", () => {
	const header = headerLine(theme, { label: "claude", details: { handle: "run-1", role: "implement", state: "done", elapsedMs: 3_000, filesChanged: 2, costUsd: 0.25 } });
	for (const mode of ["wrap", "truncate"] as const) {
		const card = new Card(header, content, mode);
		for (const width of [1, 2, 40, 120]) {
			const lines = card.render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${mode} at ${width}: ${visibleWidth(line)} wide: ${JSON.stringify(line)}`);
			assert.equal(lines.length >= content.length + 1, true, `${mode} at ${width} dropped lines`);
		}
	}
	assert.equal(new Card("head", content, "truncate").render(40).length, content.length + 1, "truncating keeps one line per line");
	assert.ok(new Card("head", content).render(40).length > content.length + 1, "wrapping folds a long line onto more lines");
});

test("a card takes a new header and new lines, as a tool row reuses the card it has", () => {
	const card = new Card("head", ["one"], "truncate");
	assert.deepEqual(card.render(40), ["head", "one"]);
	card.setHeader("next");
	card.setLines(["two", "three"]);
	assert.deepEqual(card.render(40), ["next", "two", "three"]);
	card.invalidate();
	assert.deepEqual(card.render(40), ["next", "two", "three"]);
	assert.deepEqual(card.render(0), [], "a width that fits nothing draws nothing");
	const long = new Card("head", ["x".repeat(90)], "truncate");
	assert.equal(long.render(40).length, 2);
	long.setMode("wrap");
	assert.equal(long.render(40).length, 4, "a card that turns to wrap folds the line it used to cut");
	long.setMode("truncate");
	assert.equal(long.render(40).length, 2, "and cuts it again when it turns back");
});

test("the widget names what every active run is doing, and what the session has cost when a budget is set", () => {
	const running = { handle: "run-3", role: "implement", state: "running", elapsedMs: 12_000, toolCalls: 4, activity: "Bash npm test", filesChanged: 2 };
	assert.deepEqual(widgetLines(undefined, []), [], "no run, no widget");
	assert.deepEqual(widgetLines(undefined, [running]), ["run-3 implement · 12s · 4 tool calls · Bash npm test · 2 files"]);
	assert.deepEqual(
		widgetLines(undefined, [{ handle: "run-3", role: "implement", state: "running", elapsedMs: 12_000, toolCalls: 4, activity: "Bash npm test" }]),
		["run-3 implement · 12s · 4 tool calls · Bash npm test"],
		"a run whose files are not sampled yet names none",
	);
	assert.deepEqual(widgetLines(theme, [running]), ["run-3 implement · 12s · 4 tool calls · <muted>Bash npm test</muted> · 2 files"]);
	assert.deepEqual(
		widgetLines(undefined, [{ handle: "run-3", role: "implement", state: "waiting", elapsedMs: 30_000, toolCalls: 4, question: "Which name?\nA or B?" }]),
		["run-3 implement · waiting: Which name? · answer: /fusion answer run-3 <text>"],
	);
	assert.deepEqual(
		widgetLines(theme, [{ handle: "run-3", role: "implement", state: "waiting", elapsedMs: 30_000, toolCalls: 4, question: "Which name?" }]),
		["<warning>run-3 implement · waiting: Which name? · answer: /fusion answer run-3 <text></warning>"],
	);
	assert.deepEqual(
		widgetLines(undefined, [{ handle: "run-4", role: "ask", reviews: "run-1", state: "running", elapsedMs: 2_000, toolCalls: 1 }]),
		["run-4 ask, review of run-1 · 2s · 1 tool calls"],
	);
	const usage = { costUsd: 0.25, tokensIn: 10, tokensOut: 5, workflowTokens: 0, calls: 1, warnUsd: [0.1, 0.2], limitUsd: 5 };
	assert.deepEqual(widgetLines(undefined, [running], usage).at(-1), "session usage: est. $0.2500 · warn at $0.1000, $0.2000 · limit $5.00");
	assert.deepEqual(widgetLines(theme, [running], { ...usage, warnUsd: [], limitUsd: undefined }).at(-1), "<muted>session usage: est. $0.2500</muted>");
	assert.equal(widgetLines(undefined, [running], usage).length, 2);
});

const ESC = "\u001b";
const BEL = "\u0007";
/** A report that writes the clipboard, clears the screen, hides a hyperlink and rewrites the line it is on. */
const NASTY = `${ESC}]52;c;aGVsbG8gY2xpcGJvYXJk${BEL}clipboard written\n${ESC}[2Jscreen cleared\r\nback to the start\n${ESC}]8;;https://evil.test${ESC}\\click me${ESC}]8;;${ESC}\\`;

/** Every line a card would draw, checked for what a terminal would act on. */
function drawn(lines: string[]): string[] {
	for (const line of lines) {
		assert.ok(!line.includes(ESC), `an escape introducer reached the terminal: ${JSON.stringify(line)}`);
		assert.ok(!line.includes("\r"), `a carriage return reached the terminal: ${JSON.stringify(line)}`);
	}
	return lines;
}

test("a card strips the escape sequences and control characters a child's text carries", () => {
	assert.deepEqual(drawn(bodyLines(theme, NASTY, { expanded: true })), ["clipboard written", "screen cleared", "back to the start", "click me"]);
	assert.deepEqual(drawn(bodyLines(theme, NASTY, { expanded: false })), ["clipboard written", "screen cleared", "back to the start", "<muted>… 1 more lines, ctrl+o to expand</muted>"]);
	assert.deepEqual(drawn(bodyLines(theme, "asked", { expanded: true, question: `${ESC}[2JWhich name?`, handle: "run-1" })), ["asked", "<warning>Which name?</warning>", HINT("run-1")]);
	assert.deepEqual(drawn(bodyLines(theme, "done", { expanded: false, question: `${ESC}]52;c;eA==${BEL}Which name?`, handle: "run-1" })), ["<warning>Which name?</warning>", HINT("run-1")]);
	assert.deepEqual(drawn(bodyLines(theme, "## Changed", { expanded: true, files: [`${ESC}[2Ja.ts`], filesChanged: 1 })), ["<mdHeading>## Changed</mdHeading>", "<muted>files (1)</muted>", "a.ts"]);
	assert.deepEqual(
		drawn([headerLine(theme, { label: "claude", details: { handle: `run-1${ESC}[2J`, role: `${ESC}[31mimplement`, state: "done" } })]),
		["<toolTitle><b>claude</b></toolTitle> implement run-1 · <success>done</success>"],
	);
	assert.deepEqual(cardDetails({ handle: `run-1${ESC}[2J`, files: [`${ESC}]52;c;eA==${BEL}a.ts`] }), { handle: "run-1", files: ["a.ts"] });
	assert.deepEqual(
		drawn(widgetLines(undefined, [{ handle: "run-3", role: "implement", state: "running", elapsedMs: 1_000, toolCalls: 1, activity: `Bash ${ESC}[2Jnpm test` }])),
		["run-3 implement · 1s · 1 tool calls · Bash npm test"],
	);
	assert.deepEqual(
		drawn(widgetLines(undefined, [{ handle: "run-3", role: "implement", state: "waiting", elapsedMs: 1_000, toolCalls: 1, question: `${ESC}[2JWhich name?` }])),
		["run-3 implement · waiting: Which name? · answer: /fusion answer run-3 <text>"],
	);
	// The TUI's own truncation appends a style reset, so a rendered card is read for the sequences the child wrote.
	const rendered = new Card(headerLine(theme, { label: "claude", details: {} }), bodyLines(theme, NASTY, { expanded: true })).render(20).join("\n");
	assert.ok(!rendered.includes(`${ESC}]`), rendered);
	assert.ok(!rendered.includes(`${ESC}[2J`), rendered);
	assert.ok(!rendered.includes("\r"), rendered);
});

test("plainText leaves ordinary text alone and never leaves an introducer behind", () => {
	assert.equal(plainText("a plain line\nwith a tab\there and 日本語 🙂"), "a plain line\nwith a tab\there and 日本語 🙂");
	for (const text of [`${ESC}`, `${ESC}[31`, `${ESC}]52;c;eA==`, `${ESC}${ESC}[2J`, `${ESC}P1;2q`, "\u0000\u009b[2J"]) {
		assert.ok(!plainText(text).includes(ESC), JSON.stringify(text));
		assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(plainText(text)), JSON.stringify(text));
	}
});
