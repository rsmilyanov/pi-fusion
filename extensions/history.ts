import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cap, capBytes } from "./dashboard.ts";

/** The layout of a history file. A file that names a higher version was written by a pi-fusion this one cannot read. */
export const HISTORY_VERSION = 1;
/** How many runs one host session's file keeps: the newest by start time. */
export const MAX_HISTORY_RECORDS = 100;
/** How many session files the history directory keeps: `prune` drops the oldest by mtime. */
export const MAX_HISTORY_FILES = 200;
export const HISTORY_PROMPT_CAP_BYTES = 32_768;
export const HISTORY_REPORT_CAP_BYTES = 32_768;
export const HISTORY_FAILURE_CAP_BYTES = 4_096;
export const MAX_HISTORY_FILES_PER_RUN = 500;
/** How large one session file may get: the oldest records go once the serialised file passes it, cap or no cap. */
export const MAX_HISTORY_FILE_BYTES = 1_048_576;
/** A host session id this module puts in a file name, as Pi names one: no separator, and never a bare dot or two. */
export const HOST_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

const HANDLE = /^run-[1-9]\d*$/;
const NAME = HOST_SESSION_ID.source.slice(1, -1);
/** What one session's file is called, so `prune` counts no file of the user's own that shares the directory. */
const SESSION_FILE = new RegExp(`^(${NAME})\\.json$`);
/** What `saveAll` names the file it writes before the rename, so a kill between the two leaves one of these behind. */
const TEMPORARY = new RegExp(`^${NAME}\\.json\\.(\\d+)\\.[a-z0-9]+\\.tmp$`);
/** How long `prune` leaves a temporary file alone: a younger one may be the write of another process right now. */
const TEMPORARY_MS = 60 * 60 * 1_000;
/** How much of a file `prune` reads to tell one this module wrote from one that only carries a name of that shape. */
const HEAD_BYTES = 512;
/** The version the head of a file names, wherever in the head it stands: another writer orders the keys as it likes. */
const HEAD_VERSION = /"version"\s*:\s*(\d+)/;
const STATES = new Set(["running", "waiting", "done", "failed", "aborted", "cancelled"]);
const SESSION_KINDS = new Set(["new", "resume", "fork"]);

/** One run of a host session, as the extension knew it when it last wrote the record: the same id overwrites it. */
export interface HistoryRecord {
	id: string;
	handle: string;
	role: string;
	mode?: string;
	model: string;
	hostSessionId: string;
	cwd: string;
	tool?: string;
	toolCallId?: string;
	origin: string;
	/** For a review run, the handle of the run it reviews. */
	reviews?: string;
	/** The handle of the latest review of this run. */
	reviewedBy?: string;
	state: "running" | "waiting" | "done" | "failed" | "aborted" | "cancelled";
	background?: boolean;
	startedAt: number;
	endedAt?: number;
	prompt: string;
	promptTruncated?: boolean;
	report?: string;
	reportTruncated?: boolean;
	failure?: string;
	failureTruncated?: boolean;
	files?: Array<{ path: string; status: string; added?: number; removed?: number }>;
	/** How many files the run changed, which is more than `files` holds once the per-run cap cuts the list. */
	filesTotal?: number;
	sessionId?: string;
	checkpoint?: string;
	session?: { kind: "new" | "resume" | "fork"; id: string; from?: string; at?: string };
	contract?: string;
	title?: string;
	usage?: { costUsd?: number; tokensIn: number; tokensOut: number; workflowTokens?: number; toolCalls: number };
}

/** What one host session's file holds. `cwd` is the working directory of the Pi process that wrote it last. */
export interface HistoryFile {
	version: number;
	hostSessionId: string;
	cwd: string;
	records: HistoryRecord[];
}

/** What a read gave: the records it could use, why it could use no more, and whether a save may replace the file. */
interface Loaded {
	records: HistoryRecord[];
	warning?: string;
	writable: boolean;
}

/** True when the user turned the on-disk run history on: it stays off unless PI_FUSION_HISTORY is exactly "1". */
export function historyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.PI_FUSION_HISTORY ?? "").trim() === "1";
}

/** Where the session files live: the override, else under the Pi agent directory, which has its own override. */
export function historyDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
	const override = (env.PI_FUSION_HISTORY_DIR ?? "").trim();
	if (override) return path.resolve(override);
	const agent = (env.PI_CODING_AGENT_DIR ?? "").trim();
	return path.join(agent || path.join(home, ".pi", "agent"), "pi-fusion", "history");
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const reason = (error: unknown): string => cap(error instanceof Error ? error.message : String(error));

const unusableId = (hostSessionId: string): string => `no history is kept for host session ${JSON.stringify(cap(String(hostSessionId), 140))}: the id is not a plain name`;

const openToOthers = (dir: string): string => `history directory ${dir} lets other users in and could not be made private; it is left alone`;

const tightened = (dir: string): string => `history directory ${dir} was open to other users and is now mode 0700`;

const newerFile = (target: string, version: number): string => `history file ${target} was written by a newer pi-fusion (version ${version}); it is left alone`;

const oversized = (target: string): string => `history file ${target} is larger than ${MAX_HISTORY_FILE_BYTES} bytes and will be replaced`;

const oversizedUnnamed = (target: string): string => `history file ${target} is larger than ${MAX_HISTORY_FILE_BYTES} bytes and names no version this can read; it is left alone`;

/** Every warning one call has, in the order they happened: a read with one of its own must not lose the directory's. */
const joined = (...warnings: Array<string | undefined>): string | undefined => {
	const held = warnings.filter((warning): warning is string => warning !== undefined);
	return held.length ? held.join("; ") : undefined;
};

const STRING_FIELDS = ["mode", "tool", "toolCallId", "reviews", "reviewedBy", "sessionId", "checkpoint", "contract", "title"] as const;

/** A copy of the record with every text, list and number a bounded one, so one run can never fill a session file. */
export function boundRecord(record: HistoryRecord): HistoryRecord {
	const prompt = capBytes(String(record.prompt ?? ""), HISTORY_PROMPT_CAP_BYTES);
	const bound: HistoryRecord = {
		id: cap(String(record.id)),
		handle: cap(String(record.handle)),
		role: cap(String(record.role)),
		model: cap(String(record.model)),
		hostSessionId: cap(String(record.hostSessionId)),
		cwd: cap(String(record.cwd)),
		origin: cap(String(record.origin)),
		state: record.state,
		startedAt: num(record.startedAt) ?? 0,
		prompt: prompt.text,
	};
	if (prompt.truncated || record.promptTruncated === true) bound.promptTruncated = true;
	for (const field of STRING_FIELDS) {
		const value = record[field];
		if (value !== undefined) bound[field] = cap(String(value));
	}
	if (record.background === true) bound.background = true;
	const endedAt = num(record.endedAt);
	if (endedAt !== undefined) bound.endedAt = endedAt;
	if (record.report !== undefined) {
		const report = capBytes(String(record.report), HISTORY_REPORT_CAP_BYTES);
		bound.report = report.text;
		if (report.truncated || record.reportTruncated === true) bound.reportTruncated = true;
	}
	if (record.failure !== undefined) {
		const failure = capBytes(String(record.failure), HISTORY_FAILURE_CAP_BYTES);
		bound.failure = failure.text;
		if (failure.truncated || record.failureTruncated === true) bound.failureTruncated = true;
	}
	if (record.files !== undefined) {
		bound.files = record.files.slice(0, MAX_HISTORY_FILES_PER_RUN).map((file) => {
			const copy: { path: string; status: string; added?: number; removed?: number } = { path: cap(String(file.path)), status: cap(String(file.status)) };
			const added = num(file.added);
			const removed = num(file.removed);
			if (added !== undefined) copy.added = added;
			if (removed !== undefined) copy.removed = removed;
			return copy;
		});
		bound.filesTotal = num(record.filesTotal) ?? record.files.length;
	} else {
		const filesTotal = num(record.filesTotal);
		if (filesTotal !== undefined) bound.filesTotal = filesTotal;
	}
	if (record.session !== undefined) {
		const session: NonNullable<HistoryRecord["session"]> = { kind: record.session.kind, id: cap(String(record.session.id)) };
		if (record.session.from !== undefined) session.from = cap(String(record.session.from));
		if (record.session.at !== undefined) session.at = cap(String(record.session.at));
		bound.session = session;
	}
	if (record.usage !== undefined) {
		const usage: NonNullable<HistoryRecord["usage"]> = {
			tokensIn: num(record.usage.tokensIn) ?? 0,
			tokensOut: num(record.usage.tokensOut) ?? 0,
			toolCalls: num(record.usage.toolCalls) ?? 0,
		};
		const costUsd = num(record.usage.costUsd);
		const workflowTokens = num(record.usage.workflowTokens);
		if (costUsd !== undefined) usage.costUsd = costUsd;
		if (workflowTokens !== undefined) usage.workflowTokens = workflowTokens;
		bound.usage = usage;
	}
	return bound;
}

/** The record without its changed paths, which is what a run too large for a file of its own gives up; the count stays. */
function withoutFiles(record: HistoryRecord): HistoryRecord {
	const held: HistoryRecord = { ...record, filesTotal: record.filesTotal ?? record.files?.length ?? 0 };
	delete held.files;
	return held;
}

/** The newest records a file may hold: the count cap first, then the byte budget, and always the newest record. */
function fitting(records: HistoryRecord[], overhead: number): HistoryRecord[] {
	const capped = records.slice(-MAX_HISTORY_RECORDS);
	const newest = capped[capped.length - 1];
	// The newest record is kept whatever its size, so one that fills the file on its own loses its paths, never the file.
	if (newest && overhead + Buffer.byteLength(JSON.stringify(newest)) + 1 > MAX_HISTORY_FILE_BYTES) capped[capped.length - 1] = withoutFiles(newest);
	let bytes = overhead;
	for (let index = capped.length - 1; index >= 0; index--) {
		bytes += Buffer.byteLength(JSON.stringify(capped[index])) + 1;
		if (bytes > MAX_HISTORY_FILE_BYTES && index !== capped.length - 1) return capped.slice(index + 1);
	}
	return capped;
}

function filesOf(value: unknown): HistoryRecord["files"] {
	if (!Array.isArray(value)) return undefined;
	const files: NonNullable<HistoryRecord["files"]> = [];
	for (const entry of value) {
		const file = entry as Record<string, unknown> | null;
		if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.status !== "string") continue;
		const copy: { path: string; status: string; added?: number; removed?: number } = { path: file.path, status: file.status };
		const added = num(file.added);
		const removed = num(file.removed);
		if (added !== undefined) copy.added = added;
		if (removed !== undefined) copy.removed = removed;
		files.push(copy);
	}
	return files;
}

function sessionOf(value: unknown): HistoryRecord["session"] {
	const data = value as Record<string, unknown> | null;
	if (!data || typeof data !== "object" || typeof data.kind !== "string" || !SESSION_KINDS.has(data.kind) || typeof data.id !== "string") return undefined;
	const session: NonNullable<HistoryRecord["session"]> = { kind: data.kind as "new" | "resume" | "fork", id: data.id };
	if (typeof data.from === "string") session.from = data.from;
	if (typeof data.at === "string") session.at = data.at;
	return session;
}

function usageOf(value: unknown): HistoryRecord["usage"] {
	const data = value as Record<string, unknown> | null;
	if (!data || typeof data !== "object") return undefined;
	const usage: NonNullable<HistoryRecord["usage"]> = { tokensIn: num(data.tokensIn) ?? 0, tokensOut: num(data.tokensOut) ?? 0, toolCalls: num(data.toolCalls) ?? 0 };
	const costUsd = num(data.costUsd);
	const workflowTokens = num(data.workflowTokens);
	if (costUsd !== undefined) usage.costUsd = costUsd;
	if (workflowTokens !== undefined) usage.workflowTokens = workflowTokens;
	return usage;
}

/** A record read back from disk, field by field, or undefined when the file holds something this cannot use. */
function recordOf(value: unknown): HistoryRecord | undefined {
	const data = value as Record<string, unknown> | null;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	if (typeof data.id !== "string" || !data.id) return undefined;
	if (typeof data.handle !== "string" || !HANDLE.test(data.handle)) return undefined;
	if (typeof data.role !== "string" || typeof data.model !== "string") return undefined;
	if (typeof data.hostSessionId !== "string" || typeof data.cwd !== "string" || typeof data.origin !== "string") return undefined;
	if (typeof data.state !== "string" || !STATES.has(data.state)) return undefined;
	if (typeof data.prompt !== "string") return undefined;
	const startedAt = num(data.startedAt);
	if (startedAt === undefined) return undefined;
	const record: HistoryRecord = {
		id: data.id,
		handle: data.handle,
		role: data.role,
		model: data.model,
		hostSessionId: data.hostSessionId,
		cwd: data.cwd,
		origin: data.origin,
		state: data.state as HistoryRecord["state"],
		startedAt,
		prompt: data.prompt,
	};
	for (const field of STRING_FIELDS) {
		const held = data[field];
		if (typeof held === "string") record[field] = held;
	}
	if (data.background === true) record.background = true;
	const endedAt = num(data.endedAt);
	if (endedAt !== undefined) record.endedAt = endedAt;
	if (data.promptTruncated === true) record.promptTruncated = true;
	if (typeof data.report === "string") record.report = data.report;
	if (data.reportTruncated === true) record.reportTruncated = true;
	if (typeof data.failure === "string") record.failure = data.failure;
	if (data.failureTruncated === true) record.failureTruncated = true;
	const files = filesOf(data.files);
	if (files !== undefined) record.files = files;
	const filesTotal = num(data.filesTotal);
	if (filesTotal !== undefined) record.filesTotal = filesTotal;
	const session = sessionOf(data.session);
	if (session !== undefined) record.session = session;
	const usage = usageOf(data.usage);
	if (usage !== undefined) record.usage = usage;
	return boundRecord(record);
}

/**
 * The runs of each durable host session on disk, one JSON file per session, so a later Pi process on the same session
 * can show what ran before it. Nothing here throws: every method hands back a warning instead, because a history that
 * cannot be read or written costs the user a list, never a run. The files are the user's own: mode 0600 in a 0700
 * directory, written through a temporary file and a rename, and never followed through a symbolic link.
 */
export class History {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	load(hostSessionId: string): Loaded {
		if (!HOST_SESSION_ID.test(hostSessionId)) return { records: [], writable: false, warning: unusableId(hostSessionId) };
		const trouble = this.dirTrouble();
		if (!trouble.usable) return { records: [], writable: false, warning: trouble.warning };
		const loaded = this.read(hostSessionId);
		const warning = joined(trouble.warning, loaded.warning);
		return warning === undefined ? loaded : { ...loaded, warning };
	}

	save(hostSessionId: string, cwd: string, record: HistoryRecord): { warning?: string } | undefined {
		return this.saveAll(hostSessionId, cwd, [record]);
	}

	/** Writes several runs in one pass, because every write reads the whole file back and writes the whole file out. */
	saveAll(hostSessionId: string, cwd: string, records: readonly HistoryRecord[]): { warning?: string } | undefined {
		if (!HOST_SESSION_ID.test(hostSessionId)) return { warning: unusableId(hostSessionId) };
		if (!records.length) return undefined;
		try {
			fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		} catch (error) {
			return { warning: `history directory ${this.dir} could not be created: ${reason(error)}` };
		}
		const trouble = this.dirTrouble();
		if (!trouble.usable) return { warning: trouble.warning };
		const current = this.read(hostSessionId);
		if (!current.writable) return { warning: joined(trouble.warning, current.warning) };
		const bound = new Map<string, HistoryRecord>();
		for (const record of records) {
			const held = boundRecord(record);
			bound.set(held.id, held);
		}
		const kept = current.records.filter((held) => !bound.has(held.id)).concat([...bound.values()]);
		kept.sort((left, right) => left.startedAt - right.startedAt);
		const file: HistoryFile = { version: HISTORY_VERSION, hostSessionId, cwd: cap(String(cwd)), records: [] };
		file.records = fitting(kept, Buffer.byteLength(JSON.stringify(file)));
		const target = this.file(hostSessionId);
		const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
		try {
			fs.writeFileSync(temporary, JSON.stringify(file), { flag: "wx", mode: 0o600 });
			fs.renameSync(temporary, target);
		} catch (error) {
			try {
				fs.unlinkSync(temporary);
			} catch {}
			return { warning: `history file ${target} could not be written: ${reason(error)}` };
		}
		this.prune();
		return trouble.warning === undefined ? undefined : { warning: trouble.warning };
	}

	/** Unlinks the session files past `MAX_HISTORY_FILES`, oldest first, and what a write nobody finished left behind. */
	prune(): number {
		if (!this.dirTrouble().usable) return 0;
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return 0;
		}
		const now = Date.now();
		const files: Array<{ path: string; hostSessionId: string; mtimeMs: number }> = [];
		let removed = 0;
		for (const name of names) {
			const hostSessionId = SESSION_FILE.exec(name)?.[1];
			const temporary = hostSessionId === undefined ? TEMPORARY.exec(name)?.[1] : undefined;
			if (hostSessionId === undefined && temporary === undefined) continue;
			const full = path.join(this.dir, name);
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(full);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			if (hostSessionId !== undefined) {
				files.push({ path: full, hostSessionId, mtimeMs: stat.mtimeMs });
				continue;
			}
			// A young one belongs to a write that has not reached its rename yet, here or in another Pi process.
			if (now - stat.mtimeMs <= TEMPORARY_MS) continue;
			// The name proves nothing here either: a temporary goes only when this process wrote it or it carries the header.
			if (temporary !== String(process.pid) && !this.head(full).startsWith('{"version":')) continue;
			try {
				fs.unlinkSync(full);
				removed++;
			} catch {}
		}
		if (files.length <= MAX_HISTORY_FILES) return removed;
		// The name proves nothing: a file of the user's own can carry it, so only what this module wrote may go.
		const ours = files.filter((file) => this.written(file.path, file.hostSessionId));
		if (ours.length <= MAX_HISTORY_FILES) return removed;
		ours.sort((left, right) => left.mtimeMs - right.mtimeMs);
		for (const file of ours.slice(0, ours.length - MAX_HISTORY_FILES)) {
			try {
				fs.unlinkSync(file.path);
				removed++;
			} catch {}
		}
		return removed;
	}

	/** Whether the file starts with the header `saveAll` writes for the session its name names, without reading it all. */
	private written(target: string, hostSessionId: string): boolean {
		const head = this.head(target);
		return head.startsWith('{"version":') && head.includes(`"hostSessionId":${JSON.stringify(hostSessionId)}`);
	}

	/** The first bytes of the file, which carry the header `saveAll` writes, or "" when they cannot be read. */
	private head(target: string): string {
		let handle: number | undefined;
		try {
			handle = fs.openSync(target, "r");
			const buffer = Buffer.alloc(HEAD_BYTES);
			const read = fs.readSync(handle, buffer, 0, HEAD_BYTES, 0);
			return buffer.toString("utf8", 0, read);
		} catch {
			return "";
		} finally {
			if (handle !== undefined) {
				try {
					fs.closeSync(handle);
				} catch {}
			}
		}
	}

	/** The version the head of a file names, so a file too large to read record by record still says who wrote it. */
	private headVersion(target: string): number | undefined {
		const found = HEAD_VERSION.exec(this.head(target))?.[1];
		return found === undefined ? undefined : num(Number(found));
	}

	private file(hostSessionId: string): string {
		return path.join(this.dir, `${hostSessionId}.json`);
	}

	/** Whether the path holds a directory only this user may read, and what to tell the user: one this had to close is said once, because the next call finds it closed. */
	private dirTrouble(): { usable: boolean; warning?: string } {
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(this.dir);
		} catch {
			return { usable: true };
		}
		if (!stat.isDirectory()) return { usable: false, warning: `history directory ${this.dir} is not a plain directory; it is left alone` };
		if ((stat.mode & 0o077) === 0) return { usable: true };
		// mkdirSync's mode only reaches a directory it creates, so one that was already there can still let others in.
		try {
			fs.chmodSync(this.dir, 0o700);
			return (fs.lstatSync(this.dir).mode & 0o077) === 0 ? { usable: true, warning: tightened(this.dir) } : { usable: false, warning: openToOthers(this.dir) };
		} catch {
			return { usable: false, warning: openToOthers(this.dir) };
		}
	}

	private read(hostSessionId: string): Loaded {
		const target = this.file(hostSessionId);
		let text: string;
		try {
			const stat = fs.lstatSync(target);
			if (!stat.isFile()) return { records: [], writable: false, warning: `history file ${target} is not a regular file; it is left alone` };
			// A file this module wrote fits the byte budget, so a larger one is nothing it can hand back record by record.
			if (stat.size > MAX_HISTORY_FILE_BYTES) {
				const version = this.headVersion(target);
				// A file whose head names no version this can read is nobody's to replace: it may not be this module's at all.
				if (version === undefined) return { records: [], writable: false, warning: oversizedUnnamed(target) };
				if (version > HISTORY_VERSION) return { records: [], writable: false, warning: newerFile(target, version) };
				return { records: [], writable: true, warning: oversized(target) };
			}
			text = fs.readFileSync(target, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { records: [], writable: true };
			return { records: [], writable: false, warning: `history file ${target} could not be read: ${reason(error)}` };
		}
		const unreadable: Loaded = { records: [], writable: true, warning: `history file ${target} is unreadable and will be replaced` };
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			return unreadable;
		}
		const file = data as Record<string, unknown> | null;
		if (!file || typeof file !== "object" || Array.isArray(file)) return unreadable;
		const version = num(file.version);
		if (version !== undefined && version > HISTORY_VERSION) return { records: [], writable: false, warning: newerFile(target, version) };
		if (version !== HISTORY_VERSION || file.hostSessionId !== hostSessionId || typeof file.cwd !== "string" || !Array.isArray(file.records)) return unreadable;
		const records: HistoryRecord[] = [];
		for (const entry of file.records.slice(-MAX_HISTORY_RECORDS)) {
			const record = recordOf(entry);
			if (record) records.push(record);
		}
		records.sort((left, right) => left.startedAt - right.startedAt);
		return { records, writable: true };
	}
}
