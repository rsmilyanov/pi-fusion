import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** What a card needs of a theme: Pi's Theme satisfies it, and a plain one leaves every line as it is. */
export interface CardTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** The text of a tool result, which the SDK gives as a string or as content parts. */
export function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** What a tool call, a tool result or a run notice says about the run behind it. A renderer trusts none of it. */
export interface CardDetails {
	handle?: string;
	role?: string;
	model?: string;
	state?: string;
	elapsedMs?: number;
	costUsd?: number;
	filesChanged?: number;
	files?: string[];
	reviewedBy?: string;
	reviews?: string;
	question?: string;
	background?: boolean;
	kind?: string;
	by?: string;
	historical?: boolean;
	sent?: string;
	usage?: unknown;
	sessionUsage?: unknown;
}

/** How many report lines a collapsed card shows. */
export const CARD_REPORT_LINES = 3;
/** How many changed paths an expanded card lists. */
export const CARD_FILES = 50;
/** How much of an open question a card carries. */
export const CARD_QUESTION_CHARS = 400;

/** The report headings the host must act on, as dashboard.ts flags them; a card imports nothing of the extension. */
const FLAGGED = new Set(["escalation", "review", "open questions"]);
const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
/** The stats line a report ends with and the review line under it: a collapsed card has room for neither. */
const STATS_LINE = /^\[run-\d+ · .*\]$/;
const REVIEW_LINE = /^run-\d+ reviews this run in the background/;
/** How much of one line a card header, a question or a widget line carries, before the width cuts it again. */
const LINE_CHARS = 120;

const STATE_COLORS = new Map([
	["done", "success"],
	["running", "warning"],
	["waiting", "warning"],
	["failed", "error"],
	["aborted", "error"],
	["cancelled", "error"],
]);

const PLAIN: CardTheme = { fg: (_color, text) => text, bold: (text) => text };

/** Every escape sequence a terminal acts on: CSI, OSC, the string-terminated ones, and a short or bare introducer. */
const ESCAPES = /\u001b(?:\[[\u0020-\u003f]*[\u0040-\u007e]|\][\s\S]*?(?:\u0007|\u001b\\)|[P_^X][\s\S]*?(?:\u0007|\u001b\\)|[\u0020-\u002f]*[\u0030-\u007e])?/g;
/** What no card line may carry once the sequences are out: the C0 and C1 control characters, tab and newline apart. */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * A child's text as a card may draw it. Pi's own fallback renderer strips the escape sequences before it prints a tool
 * result, so a card that replaces it must not hand the terminal what that renderer would have taken away.
 */
export function plainText(text: string): string {
	return text.replace(ESCAPES, "").replace(CONTROLS, "");
}

const TEXT_FIELDS = ["handle", "role", "model", "state", "reviewedBy", "reviews", "question", "kind", "by", "sent"] as const;
const NUMBER_FIELDS = ["elapsedMs", "costUsd", "filesChanged"] as const;

function cap(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const last = cut.charCodeAt(max - 1);
	// Never end on the high half of a surrogate pair: that char is not text any more.
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function firstLine(text: string): string {
	return cap(plainText(text).trim().split("\n")[0] ?? "", LINE_CHARS);
}

/** Dollars as the stats line and the dashboard show them: cents are too coarse for a single cheap call. */
function usd(amount: number): string {
	return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

/** Pi appends a style reset to every line it draws, so a colored block carries its color on each of its lines. */
function painted(theme: CardTheme, color: string, text: string): string[] {
	return text.split("\n").map((line) => theme.fg(color, line));
}

/** What a card shows, read out of any details object with every type checked. */
export function cardDetails(value: unknown): CardDetails {
	const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
	const details: CardDetails = {};
	for (const field of TEXT_FIELDS) {
		const read = source[field];
		if (typeof read === "string" && read) details[field] = plainText(read);
	}
	for (const field of NUMBER_FIELDS) {
		const read = source[field];
		if (typeof read === "number" && Number.isFinite(read)) details[field] = read;
	}
	if (Array.isArray(source.files)) details.files = source.files.filter((file): file is string => typeof file === "string" && file !== "").slice(0, CARD_FILES).map(plainText);
	if (typeof source.background === "boolean") details.background = source.background;
	if (typeof source.historical === "boolean") details.historical = source.historical;
	if (source.usage !== undefined) details.usage = source.usage;
	if (source.sessionUsage !== undefined) details.sessionUsage = source.sessionUsage;
	return details;
}

/** One line over a card: what ran, what became of it, and what it cost. The caller truncates it to the width. */
export function headerLine(theme: CardTheme, parts: { label: string; details: CardDetails; color?: string }): string {
	// Through cardDetails again, so a header built from details nobody read through it carries no escape sequence either.
	const details = cardDetails(parts.details);
	const head = [theme.fg(parts.color ?? "toolTitle", theme.bold(parts.label))];
	if (details.role) head.push(details.reviews ? `${details.role}, review of ${details.reviews}` : details.role);
	if (details.handle) head.push(details.handle);
	const rest: string[] = [];
	if (details.state) rest.push(theme.fg(STATE_COLORS.get(details.state) ?? "muted", details.state));
	if (details.elapsedMs !== undefined) rest.push(`${Math.round(details.elapsedMs / 1000)}s`);
	if (details.filesChanged !== undefined) rest.push(`${details.filesChanged} files`);
	if (details.costUsd !== undefined) rest.push(usd(details.costUsd));
	if (details.reviewedBy) rest.push(`reviewed by ${details.reviewedBy}`);
	return [head.join(" "), ...rest].join(" · ");
}

/** Both ways to answer a run that waits, so the card says it wherever the question shows. */
function answerHint(handle: string | undefined): string {
	return `answer: /fusion answer ${handle ?? "run-N"} <text> or claude_control message`;
}

/** A Markdown heading as a card shows it: the headings the host must act on stand out from the rest. */
function heading(theme: CardTheme, line: string): string {
	const found = HEADING.exec(line);
	if (!found) return line;
	return FLAGGED.has(found[1]!.toLowerCase()) ? theme.bold(theme.fg("warning", line)) : theme.fg("mdHeading", line);
}

/**
 * The body under a card's header: the first report lines collapsed, the whole report with its changed paths and its
 * open question expanded. Nothing here knows the width; the card wraps or truncates what it gets.
 */
export function bodyLines(theme: CardTheme, text: string, opts: { expanded: boolean; question?: string; handle?: string; files?: string[]; filesChanged?: number }): string[] {
	const body = plainText(text);
	const question = opts.question === undefined ? undefined : plainText(opts.question);
	if (!opts.expanded) {
		if (question) return [theme.fg("warning", firstLine(question)), theme.fg("muted", answerHint(opts.handle))];
		const report = body
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.trim() && !STATS_LINE.test(line.trim()) && !REVIEW_LINE.test(line.trim()));
		const shown = report.slice(0, CARD_REPORT_LINES);
		const rest = report.length - shown.length;
		return rest > 0 ? [...shown, theme.fg("muted", `… ${rest} more lines, ctrl+o to expand`)] : shown;
	}
	const lines = body.split("\n").map((line) => heading(theme, line));
	const files = (opts.files ?? []).map(plainText);
	if (files.length) {
		const shown = files.slice(0, CARD_FILES);
		const rest = (opts.filesChanged ?? files.length) - shown.length;
		lines.push(theme.fg("muted", `files (${opts.filesChanged ?? files.length})`), ...shown);
		if (rest > 0) lines.push(theme.fg("muted", `… ${rest} more`));
	}
	if (question) lines.push(...painted(theme, "warning", cap(question, CARD_QUESTION_CHARS)), theme.fg("muted", answerHint(opts.handle)));
	return lines;
}

/** Whether a line too long for the width is cut or folded onto more lines. */
export type CardMode = "truncate" | "wrap";

/** A header over a body, rendered so that no line is ever wider than the width the TUI asked for. */
export class Card implements Component {
	private header: string;
	private lines: string[];
	private mode: CardMode;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(header: string, lines: string[], mode: CardMode = "wrap") {
		this.header = header;
		this.lines = lines;
		this.mode = mode;
	}

	setHeader(header: string): void {
		this.header = header;
		this.invalidate();
	}

	setLines(lines: string[]): void {
		this.lines = lines;
		this.invalidate();
	}

	setMode(mode: CardMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (width < 1) return [];
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		// A width of 1 fits no wide grapheme, which wrapping cannot split, so there the only safe fold is a cut.
		const truncate = this.mode === "truncate" || width < 2;
		const out = [truncateToWidth(this.header, width)];
		for (const line of this.lines) {
			if (truncate) out.push(truncateToWidth(line, width));
			else out.push(...wrapTextWithAnsi(line, width));
		}
		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}
}

/** One active run, as the editor widget names it. */
export interface WidgetRun {
	handle: string;
	role: string;
	reviews?: string;
	state: string;
	elapsedMs: number;
	toolCalls: number;
	activity?: string;
	filesChanged?: number;
	question?: string;
}

/** What this Pi session's runs have cost, with the thresholds that act on it. */
export interface WidgetUsage {
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
	workflowTokens: number;
	calls: number;
	warnUsd: number[];
	limitUsd?: number;
}

function widgetRunLine(theme: CardTheme, run: WidgetRun): string {
	const handle = plainText(run.handle);
	const name = plainText(run.reviews ? `${run.role}, review of ${run.reviews}` : run.role);
	if (run.state === "waiting") {
		return theme.fg("warning", `${handle} ${name} · waiting: ${firstLine(run.question ?? "")} · answer: /fusion answer ${handle} <text>`);
	}
	const parts = [`${handle} ${name}`, `${Math.round(run.elapsedMs / 1000)}s`, `${run.toolCalls} tool calls`];
	if (run.activity) parts.push(theme.fg("muted", firstLine(run.activity)));
	if (run.filesChanged !== undefined) parts.push(`${run.filesChanged} files`);
	return parts.join(" · ");
}

function widgetUsageLine(usage: WidgetUsage): string {
	const parts = [`session usage: est. ${usd(usage.costUsd)}`];
	if (usage.warnUsd.length) parts.push(`warn at ${usage.warnUsd.map((threshold) => usd(threshold)).join(", ")}`);
	if (usage.limitUsd !== undefined) parts.push(`limit ${usd(usage.limitUsd)}`);
	return parts.join(" · ");
}

/** What the active runs are doing, one line each, for the widget over the editor. Empty when none is active. */
export function widgetLines(theme: CardTheme | undefined, runs: readonly WidgetRun[], usage?: WidgetUsage): string[] {
	if (!runs.length) return [];
	const paint = theme ?? PLAIN;
	const lines = runs.map((run) => widgetRunLine(paint, run));
	if (usage) lines.push(paint.fg("muted", widgetUsageLine(usage)));
	return lines;
}
