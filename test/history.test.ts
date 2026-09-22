import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	boundRecord,
	History,
	HISTORY_FAILURE_CAP_BYTES,
	HISTORY_PROMPT_CAP_BYTES,
	HISTORY_REPORT_CAP_BYTES,
	HISTORY_VERSION,
	type HistoryRecord,
	historyDir,
	historyEnabled,
	HOST_SESSION_ID,
	MAX_HISTORY_FILE_BYTES,
	MAX_HISTORY_FILES,
	MAX_HISTORY_FILES_PER_RUN,
	MAX_HISTORY_RECORDS,
} from "../extensions/history.ts";

function withDir(body: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-history-"));
	try {
		body(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const record = (over: Partial<HistoryRecord> = {}): HistoryRecord => ({
	id: "id-1",
	handle: "run-1",
	role: "implement",
	model: "opus",
	hostSessionId: "host-1",
	cwd: "/work",
	origin: "tool",
	state: "done",
	startedAt: 1_000,
	prompt: "add the retry",
	...over,
});

const written = (dir: string, hostSessionId: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, `${hostSessionId}.json`), "utf8"));

test("history is off unless PI_FUSION_HISTORY is exactly 1", () => {
	assert.equal(historyEnabled({ PI_FUSION_HISTORY: "1" }), true);
	assert.equal(historyEnabled({ PI_FUSION_HISTORY: " 1 " }), true, "a variable with spaces around it still says 1");
	for (const value of ["", "  ", "0", "2", "true", "yes", "on", "11"]) {
		assert.equal(historyEnabled({ PI_FUSION_HISTORY: value }), false, `${JSON.stringify(value)} does not turn history on`);
	}
	assert.equal(historyEnabled({}), false, "history is off when the variable is unset");
});

test("the history directory is the override, then the agent directory, then the home default", () => {
	assert.equal(historyDir({ PI_FUSION_HISTORY_DIR: "/tmp/runs" }, "/home/u"), "/tmp/runs");
	assert.equal(historyDir({ PI_FUSION_HISTORY_DIR: " /tmp/runs " }, "/home/u"), "/tmp/runs", "the override is trimmed");
	const relative = historyDir({ PI_FUSION_HISTORY_DIR: "runs/here" }, "/home/u");
	assert.equal(path.isAbsolute(relative), true, "a relative override resolves against the working directory");
	assert.equal(relative, path.resolve("runs/here"));
	assert.equal(historyDir({ PI_CODING_AGENT_DIR: "/cfg/pi" }, "/home/u"), path.join("/cfg/pi", "pi-fusion", "history"));
	assert.equal(historyDir({ PI_FUSION_HISTORY_DIR: "   ", PI_CODING_AGENT_DIR: " /cfg/pi " }, "/home/u"), path.join("/cfg/pi", "pi-fusion", "history"), "a blank override falls through");
	assert.equal(historyDir({}, "/home/u"), path.join("/home/u", ".pi", "agent", "pi-fusion", "history"));
	assert.equal(historyDir({ PI_CODING_AGENT_DIR: "  " }, "/home/u"), path.join("/home/u", ".pi", "agent", "pi-fusion", "history"));
});

test("a save writes a private file in a private directory and leaves no temporary file behind", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const history = new History(dir);
		assert.equal(history.dir, dir);
		assert.equal(history.save("host-1", "/work", record()), undefined, "a save that worked reports nothing");
		assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700, "the directory is the user's own");
		assert.equal(fs.lstatSync(path.join(dir, "host-1.json")).mode & 0o777, 0o600, "the file is the user's own");
		assert.deepEqual(fs.readdirSync(dir), ["host-1.json"], "the temporary file is renamed, never left");
		assert.deepEqual(written(dir, "host-1"), { version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records: [record()] });
		assert.deepEqual(history.load("host-1"), { records: [record()], writable: true });
	});
});

test("a second save of the same run replaces its record, and another run is appended in start order", () => {
	withDir((root) => {
		const history = new History(path.join(root, "history"));
		history.save("host-1", "/work", record({ id: "id-2", handle: "run-2", startedAt: 5_000 }));
		history.save("host-1", "/work", record({ startedAt: 1_000, state: "running" }));
		history.save("host-1", "/work", record({ startedAt: 1_000, state: "done", endedAt: 4_000, report: "## Changed\nfoo.ts" }));
		const loaded = history.load("host-1");
		assert.deepEqual(
			loaded.records.map((held) => held.id),
			["id-1", "id-2"],
			"the same id is upserted, and the records come back oldest first",
		);
		assert.equal(loaded.records[0]?.state, "done", "the later save of a run wins");
		assert.equal(loaded.records[0]?.report, "## Changed\nfoo.ts");
		assert.equal(loaded.records[0]?.endedAt, 4_000);
	});
});

test("a session file keeps the newest records and drops the oldest past the cap", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const history = new History(dir);
		for (let index = 1; index <= MAX_HISTORY_RECORDS + 1; index++) {
			history.save("host-1", "/work", record({ id: `id-${index}`, handle: `run-${index}`, startedAt: 1_000 + index }));
		}
		const loaded = history.load("host-1");
		assert.equal(loaded.records.length, MAX_HISTORY_RECORDS);
		assert.equal(loaded.records[0]?.id, "id-2", "the oldest record is the one that goes");
		assert.equal(loaded.records.at(-1)?.id, `id-${MAX_HISTORY_RECORDS + 1}`);
		assert.equal((written(dir, "host-1") as { records: unknown[] }).records.length, MAX_HISTORY_RECORDS, "the file itself holds no more than the cap");
	});
});

test("boundRecord cuts the prompt, the report and the failure in bytes at a code point boundary and says it did", () => {
	const long = "€".repeat(20_000);
	const bound = boundRecord(record({ prompt: long, report: long, failure: long }));
	assert.equal(bound.prompt, "€".repeat(Math.floor(HISTORY_PROMPT_CAP_BYTES / 3)));
	assert.equal(bound.report, "€".repeat(Math.floor(HISTORY_REPORT_CAP_BYTES / 3)));
	assert.equal(bound.failure, "€".repeat(Math.floor(HISTORY_FAILURE_CAP_BYTES / 3)));
	for (const text of [bound.prompt, bound.report ?? "", bound.failure ?? ""]) {
		assert.ok(Buffer.byteLength(text) <= HISTORY_PROMPT_CAP_BYTES, "nothing kept is over its cap");
		assert.ok(!text.includes("�"), "a cut inside a code point would decode to a replacement character");
	}
	assert.deepEqual(
		{ prompt: bound.promptTruncated, report: bound.reportTruncated, failure: bound.failureTruncated },
		{ prompt: true, report: true, failure: true },
	);
	const short = boundRecord(record({ report: "fine", failure: "also fine" }));
	assert.deepEqual(
		{ prompt: short.promptTruncated, report: short.reportTruncated, failure: short.failureTruncated },
		{ prompt: undefined, report: undefined, failure: undefined },
		"a record under the caps is carried whole",
	);
});

test("boundRecord cuts the changed files to the per-run cap, keeps the count, caps other text and drops numbers that are not finite", () => {
	const files = Array.from({ length: MAX_HISTORY_FILES_PER_RUN + 3 }, (_unused, index) => ({ path: `src/file-${index}.ts`, status: "M", added: index, removed: 0 }));
	const bound = boundRecord(record({ files, model: "m".repeat(401), title: "t".repeat(401) }));
	assert.equal(bound.files?.length, MAX_HISTORY_FILES_PER_RUN);
	assert.equal(bound.files?.at(-1)?.path, `src/file-${MAX_HISTORY_FILES_PER_RUN - 1}.ts`);
	assert.equal(bound.filesTotal, MAX_HISTORY_FILES_PER_RUN + 3, "the count of what the run changed outlives the list");
	assert.equal(bound.model.length, 400, "a string field that is not the prompt, report or failure is capped at 400 chars");
	assert.equal(bound.title?.length, 400);
	const numbers = boundRecord(
		record({
			startedAt: Number.NaN,
			endedAt: Number.POSITIVE_INFINITY,
			filesTotal: Number.NaN,
			usage: { costUsd: Number.NaN, tokensIn: 300, tokensOut: 30, workflowTokens: Number.POSITIVE_INFINITY, toolCalls: 4 },
		}),
	);
	assert.equal(numbers.startedAt, 0, "a start time that is not a number sorts first instead of poisoning the sort");
	assert.deepEqual({ endedAt: numbers.endedAt, filesTotal: numbers.filesTotal }, { endedAt: undefined, filesTotal: undefined });
	assert.deepEqual(numbers.usage, { tokensIn: 300, tokensOut: 30, toolCalls: 4 });
});

test("pruning keeps the newest session files by mtime and leaves anything that is not a plain file alone", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const outside = path.join(root, "outside.json");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(outside, "{}");
		for (let index = 0; index <= MAX_HISTORY_FILES; index++) {
			const file = path.join(dir, `host-${index}.json`);
			fs.writeFileSync(file, JSON.stringify({ version: HISTORY_VERSION, hostSessionId: `host-${index}`, cwd: "/work", records: [] }));
			fs.utimesSync(file, 1_000 + index, 1_000 + index);
		}
		fs.symlinkSync(outside, path.join(dir, "link.json"));
		fs.mkdirSync(path.join(dir, "folder.json"));
		fs.writeFileSync(path.join(dir, "notes.txt"), "kept");
		const history = new History(dir);
		assert.equal(history.prune(), 1, "one file over the cap is one file removed");
		assert.equal(fs.existsSync(path.join(dir, "host-0.json")), false, "the oldest by mtime is the one that goes");
		assert.equal(fs.existsSync(path.join(dir, "host-1.json")), true);
		assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("host-")).length, MAX_HISTORY_FILES);
		assert.equal(fs.lstatSync(path.join(dir, "link.json")).isSymbolicLink(), true, "a symbolic link is never counted or removed");
		assert.equal(fs.existsSync(outside), true, "and never followed");
		assert.equal(fs.lstatSync(path.join(dir, "folder.json")).isDirectory(), true, "a directory is left alone");
		assert.equal(fs.existsSync(path.join(dir, "notes.txt")), true, "a file that is not a session file is left alone");
		assert.equal(history.prune(), 0, "at the cap there is nothing to remove");
	});
});

test("an unreadable file is reported and the next save replaces it", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, "host-1.json");
		fs.writeFileSync(file, "{not json");
		const history = new History(dir);
		const loaded = history.load("host-1");
		assert.deepEqual(loaded.records, []);
		assert.equal(loaded.writable, true);
		assert.equal(loaded.warning, `history file ${file} is unreadable and will be replaced`);
		assert.equal(history.save("host-1", "/work", record()), undefined);
		assert.deepEqual(written(dir, "host-1"), { version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records: [record()] });
	});
});

test("a file with no version, an older one, or another session's id is unreadable too", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, "host-1.json");
		const history = new History(dir);
		for (const value of [
			{ hostSessionId: "host-1", cwd: "/work", records: [record()] },
			{ version: 0, hostSessionId: "host-1", cwd: "/work", records: [record()] },
			{ version: HISTORY_VERSION, hostSessionId: "host-2", cwd: "/work", records: [record()] },
			{ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: 7, records: [record()] },
			{ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records: { "0": record() } },
			[record()],
			"a string",
		]) {
			fs.writeFileSync(file, JSON.stringify(value));
			const loaded = history.load("host-1");
			assert.deepEqual(loaded.records, [], `${JSON.stringify(value).slice(0, 40)} holds no records this can use`);
			assert.equal(loaded.writable, true, "the file is this session's to replace");
			assert.equal(loaded.warning, `history file ${file} is unreadable and will be replaced`);
		}
	});
});

test("a file from a newer pi-fusion is read by nobody and written over by nobody", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, "host-1.json");
		const text = JSON.stringify({ version: 99, hostSessionId: "host-1", cwd: "/work", records: [record()] });
		fs.writeFileSync(file, text);
		const history = new History(dir);
		const loaded = history.load("host-1");
		assert.deepEqual(loaded.records, []);
		assert.equal(loaded.writable, false);
		assert.equal(loaded.warning, `history file ${file} was written by a newer pi-fusion (version 99); it is left alone`);
		assert.equal(history.save("host-1", "/work", record({ id: "id-2", handle: "run-2" }))?.warning, loaded.warning, "the save is refused for the same reason");
		assert.equal(fs.readFileSync(file, "utf8"), text, "the file is byte for byte what it was");
		assert.deepEqual(fs.readdirSync(dir), ["host-1.json"], "a refused save leaves no temporary file");
		const huge = JSON.stringify({ version: 99, hostSessionId: "host-1", cwd: "x".repeat(MAX_HISTORY_FILE_BYTES + 100), records: [] });
		fs.writeFileSync(file, huge);
		const big = history.load("host-1");
		assert.deepEqual(big.records, []);
		assert.equal(big.writable, false, "the version is read before the size, so a big file of a newer pi-fusion is nobody's to replace");
		assert.equal(big.warning, loaded.warning);
		assert.equal(history.save("host-1", "/work", record({ id: "id-2", handle: "run-2" }))?.warning, loaded.warning);
		assert.equal(fs.readFileSync(file, "utf8"), huge, "and it too is byte for byte what it was");
		const reordered = JSON.stringify({ hostSessionId: "host-1", records: [], version: 99, cwd: "x".repeat(MAX_HISTORY_FILE_BYTES + 100) });
		fs.writeFileSync(file, reordered);
		assert.equal(history.load("host-1").warning, loaded.warning, "another writer orders the keys as it likes, and the head still names the version");
		assert.equal(history.load("host-1").writable, false);
		assert.equal(fs.readFileSync(file, "utf8"), reordered);
	});
});

test("a record the file cannot vouch for is dropped and the rest of the file is still read", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const records: unknown[] = [
			{ ...record({ id: "bad-state" }), state: "flying" },
			{ ...record({ id: "bad-start" }), startedAt: null },
			{ ...record({ id: "bad-handle" }), handle: "run-x" },
			{ ...record({ id: "bad-role" }), role: 7 },
			{ ...record({ id: "" }) },
			"not a record",
			null,
			record({ id: "ok", handle: "run-7", startedAt: 5_000 }),
		];
		fs.writeFileSync(path.join(dir, "host-1.json"), JSON.stringify({ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records }));
		const loaded = new History(dir).load("host-1");
		assert.deepEqual(
			loaded.records.map((held) => held.id),
			["ok"],
		);
		assert.equal(loaded.writable, true);
		assert.equal(loaded.warning, undefined, "a file this can still read raises nothing");
	});
});

test("one host session never reads another one's runs", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const history = new History(dir);
		history.save("host-1", "/work/one", record({ id: "id-a" }));
		history.save("host-2", "/work/two", record({ id: "id-b", hostSessionId: "host-2" }));
		assert.deepEqual(
			history.load("host-1").records.map((held) => held.id),
			["id-a"],
		);
		assert.deepEqual(
			history.load("host-2").records.map((held) => held.id),
			["id-b"],
		);
		assert.deepEqual(fs.readdirSync(dir).sort(), ["host-1.json", "host-2.json"]);
		assert.equal((written(dir, "host-2") as { cwd: string }).cwd, "/work/two", "each file names the directory it was written in");
	});
});

test("a symbolic link where a session file goes is neither read nor written through", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const outside = path.join(root, "outside.json");
		const text = JSON.stringify({ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records: [record({ id: "planted" })] });
		fs.writeFileSync(outside, text);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, "host-1.json");
		fs.symlinkSync(outside, file);
		const history = new History(dir);
		const loaded = history.load("host-1");
		assert.deepEqual(loaded.records, [], "the link is not followed");
		assert.equal(loaded.writable, false);
		assert.equal(loaded.warning, `history file ${file} is not a regular file; it is left alone`);
		assert.equal(history.save("host-1", "/work", record())?.warning, loaded.warning);
		assert.equal(fs.readFileSync(outside, "utf8"), text, "what the link points at is untouched");
		assert.equal(fs.lstatSync(file).isSymbolicLink(), true, "and so is the link");
		assert.deepEqual(fs.readdirSync(dir), ["host-1.json"]);
	});
});

test("a symbolic link where the history directory goes refuses every operation", () => {
	withDir((root) => {
		const elsewhere = path.join(root, "elsewhere");
		const dir = path.join(root, "history");
		fs.mkdirSync(elsewhere);
		fs.symlinkSync(elsewhere, dir);
		const history = new History(dir);
		const warning = `history directory ${dir} is not a plain directory; it is left alone`;
		const loaded = history.load("host-1");
		assert.deepEqual(loaded.records, []);
		assert.equal(loaded.writable, false);
		assert.equal(loaded.warning, warning);
		assert.equal(history.save("host-1", "/work", record())?.warning, warning);
		assert.equal(history.prune(), 0);
		assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing is written through the link");
	});
});

test("a file where the history directory goes refuses every operation", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.writeFileSync(dir, "in the way");
		const history = new History(dir);
		assert.equal(history.load("host-1").writable, false);
		assert.ok(history.save("host-1", "/work", record())?.warning, "a save over a file says why it cannot");
		assert.equal(fs.readFileSync(dir, "utf8"), "in the way");
	});
});

test("a host session id that is not a plain name reads nothing, writes nothing and creates nothing", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const history = new History(dir);
		for (const id of ["../x", "a/b", "a b", "", ".", "..", ".hidden", "trailing.", "_lead", "lead_", "a".repeat(129), "héllo"]) {
			const loaded = history.load(id);
			assert.deepEqual(loaded.records, [], `${JSON.stringify(id)} names no session`);
			assert.equal(loaded.writable, false);
			assert.match(loaded.warning ?? "", /the id is not a plain name/);
			assert.match(history.save(id, "/work", record())?.warning ?? "", /the id is not a plain name/);
		}
		assert.equal(fs.existsSync(dir), false, "no directory is made for an id no file can be named after");
		assert.equal(HOST_SESSION_ID.test("a".repeat(128)), true, "a long but plain id is still usable");
		assert.equal(HOST_SESSION_ID.test("01JXY_z-9"), true);
		assert.equal(HOST_SESSION_ID.test("my.session"), true, "a dot inside the id is one Pi itself allows");
	});
});

test("a host session id with a dot in it, which Pi allows, keeps a file of its own", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const history = new History(dir);
		assert.equal(history.save("my.session", "/work", record({ hostSessionId: "my.session" })), undefined);
		assert.deepEqual(fs.readdirSync(dir), ["my.session.json"]);
		assert.deepEqual(
			history.load("my.session").records.map((held) => held.id),
			["id-1"],
		);
		assert.deepEqual(history.load("host-1").records, [], "and it is still nobody else's file");
	});
});

test("pruning never removes a file of the user's own, whatever it is called", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (let index = 0; index <= MAX_HISTORY_FILES + 4; index++) {
			const file = path.join(dir, `my-notes-${index}.json`);
			fs.writeFileSync(file, JSON.stringify({ notes: index }));
			fs.utimesSync(file, 1_000 + index, 1_000 + index);
		}
		const history = new History(dir);
		assert.equal(history.prune(), 0, "a name of the right shape is not a file this wrote");
		assert.equal(fs.readdirSync(dir).length, MAX_HISTORY_FILES + 5);
		assert.equal(history.save("host-1", "/work", record()), undefined, "and an ordinary save removes none of them either");
		assert.equal(fs.existsSync(path.join(dir, "my-notes-0.json")), true);
		assert.equal(fs.readdirSync(dir).length, MAX_HISTORY_FILES + 6);
		const mine = path.join(dir, "host-2.json");
		fs.writeFileSync(mine, JSON.stringify({ version: HISTORY_VERSION, hostSessionId: "host-2", cwd: "/work", records: [] }));
		fs.utimesSync(mine, 500, 500);
		assert.equal(history.prune(), 0, "the cap counts the session files alone, and there are two of them");
		assert.equal(fs.existsSync(mine), true);
	});
});

test("a history directory that was already there is made private before anything is read or written", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
		fs.chmodSync(dir, 0o777);
		const history = new History(dir);
		const warning = `history directory ${dir} was open to other users and is now mode 0700`;
		assert.equal(history.save("host-1", "/work", record())?.warning, warning, "the user hears that their directory changed");
		assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700, "a directory anyone could write is closed before the save");
		assert.equal(fs.lstatSync(path.join(dir, "host-1.json")).mode & 0o777, 0o600);
		assert.equal(history.save("host-1", "/work", record({ id: "id-2", handle: "run-2" })), undefined, "a directory that is already private is said nothing about");
		fs.chmodSync(dir, 0o750);
		const loaded = history.load("host-1");
		assert.deepEqual(
			loaded.records.map((held) => held.id),
			["id-1", "id-2"],
			"a read closes it too",
		);
		assert.equal(loaded.warning, warning);
		assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
		assert.equal(history.load("host-1").warning, undefined, "and says so once");
		const other = path.join(dir, "host-2.json");
		fs.writeFileSync(other, "{not json", { mode: 0o600 });
		fs.chmodSync(dir, 0o777);
		const both = history.load("host-2");
		assert.equal(both.warning, `${warning}; history file ${other} is unreadable and will be replaced`, "a file with a warning of its own does not swallow the directory's");
		assert.equal(both.writable, true);
	});
});

test("a file over the byte budget is not read and is replaced, and a file of too many records gives back the newest", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, "host-1.json");
		const records = Array.from({ length: MAX_HISTORY_RECORDS + 5 }, (_unused, index) => record({ id: `id-${index}`, handle: `run-${index + 1}`, startedAt: 1_000 + index }));
		fs.writeFileSync(file, JSON.stringify({ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records }));
		const history = new History(dir);
		const loaded = history.load("host-1");
		assert.equal(loaded.records.length, MAX_HISTORY_RECORDS, "a file another writer filled hands back no more than the cap");
		assert.equal(loaded.records.at(-1)?.id, `id-${MAX_HISTORY_RECORDS + 4}`);
		fs.writeFileSync(file, JSON.stringify({ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "x".repeat(MAX_HISTORY_FILE_BYTES + 100), records: [record()] }));
		const big = history.load("host-1");
		assert.deepEqual(big.records, []);
		assert.equal(big.writable, true);
		assert.equal(big.warning, `history file ${file} is larger than ${MAX_HISTORY_FILE_BYTES} bytes and will be replaced`);
		assert.equal(history.save("host-1", "/work", record()), undefined);
		assert.deepEqual(written(dir, "host-1"), { version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records: [record()] });
		const unnamed = `{"records":[],"cwd":${JSON.stringify("x".repeat(MAX_HISTORY_FILE_BYTES + 100))}}`;
		fs.writeFileSync(file, unnamed);
		const nameless = history.load("host-1");
		assert.deepEqual(nameless.records, []);
		assert.equal(nameless.writable, false, "a file too large to read that names no version may be nobody's to replace");
		assert.equal(nameless.warning, `history file ${file} is larger than ${MAX_HISTORY_FILE_BYTES} bytes and names no version this can read; it is left alone`);
		assert.equal(history.save("host-1", "/work", record())?.warning, nameless.warning, "and the save leaves it where it is");
		assert.equal(fs.readFileSync(file, "utf8"), unnamed);
	});
});

test("pruning removes what a write nobody finished left behind, once no write can still be going", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const orphan = path.join(dir, "host-1.json.999.deadbeef.tmp");
		const mine = path.join(dir, `host-1.json.${process.pid}.beef.tmp`);
		const foreign = path.join(dir, "host-3.json.7.abcd.tmp");
		const fresh = path.join(dir, "host-2.json.1000.c0ffee.tmp");
		fs.writeFileSync(orphan, `{"version":${HISTORY_VERSION},"hostSessionId":"host-1","cwd":"/work","records":[`);
		fs.writeFileSync(mine, "{}");
		fs.writeFileSync(foreign, "mine too");
		fs.writeFileSync(fresh, "{}");
		const hours = (Date.now() - 2 * 60 * 60 * 1_000) / 1_000;
		for (const stale of [orphan, mine, foreign]) fs.utimesSync(stale, hours, hours);
		const history = new History(dir);
		assert.equal(history.prune(), 2, "the halves of a write that a kill left behind are the ones that go");
		assert.equal(fs.existsSync(orphan), false, "a temporary that carries the header this module writes goes");
		assert.equal(fs.existsSync(mine), false, "and so does one this process itself named");
		assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(foreign), path.basename(fresh)].sort());
		assert.equal(fs.readFileSync(foreign, "utf8"), "mine too", "a file of the user's own that only carries the name is left alone");
	});
});

test("a run whose record alone fills a file gives up its changed paths, never the file", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const history = new History(dir);
		// Each path and status is capped in characters, and a character outside ASCII costs more than one byte.
		const files = Array.from({ length: MAX_HISTORY_FILES_PER_RUN }, () => ({ path: "京".repeat(400), status: "京".repeat(400) }));
		assert.equal(history.save("host-1", "/work", record({ files })), undefined);
		const size = fs.statSync(path.join(dir, "host-1.json")).size;
		assert.ok(size <= MAX_HISTORY_FILE_BYTES, `a file of ${size} bytes is over the budget`);
		const loaded = history.load("host-1");
		assert.equal(loaded.warning, undefined, "the next load reads the file instead of replacing it whole");
		assert.equal(loaded.records.length, 1);
		assert.equal(loaded.records[0]?.files, undefined, "the paths are what the record gives up");
		assert.equal(loaded.records[0]?.filesTotal, MAX_HISTORY_FILES_PER_RUN, "the count of what the run changed stays");
		assert.equal(loaded.records[0]?.prompt, "add the retry", "and the rest of the record is kept whole");
	});
});

test("several runs go into the file in one pass, and the file stays under its byte budget", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const history = new History(dir);
		const big = "x".repeat(HISTORY_PROMPT_CAP_BYTES);
		const many = Array.from({ length: 40 }, (_unused, index) => record({ id: `id-${index}`, handle: `run-${index + 1}`, startedAt: 1_000 + index, prompt: big, report: big }));
		assert.equal(history.saveAll("host-1", "/work", many), undefined);
		const size = fs.statSync(path.join(dir, "host-1.json")).size;
		assert.ok(size <= MAX_HISTORY_FILE_BYTES, `a file of ${size} bytes is over the budget`);
		const kept = history.load("host-1").records;
		assert.ok(kept.length > 1 && kept.length < many.length, `${kept.length} of ${many.length} runs fit`);
		assert.equal(kept.at(-1)?.id, "id-39", "the newest run is kept whatever it costs");
		assert.equal(kept[0]?.id, `id-${many.length - kept.length}`, "the oldest runs are the ones that go");
		assert.deepEqual(fs.readdirSync(dir), ["host-1.json"], "one pass is one write");
		assert.equal(
			history.saveAll("host-2", "/work", [
				record({ id: "id-a", hostSessionId: "host-2", state: "running" }),
				record({ id: "id-a", hostSessionId: "host-2", state: "done", report: "later" }),
				record({ id: "id-b", hostSessionId: "host-2", handle: "run-2", startedAt: 2_000 }),
			]),
			undefined,
		);
		assert.deepEqual(
			history.load("host-2").records.map((held) => [held.id, held.report]),
			[
				["id-a", "later"],
				["id-b", undefined],
			],
			"the same id twice in one pass is one record, the last of them",
		);
		assert.equal(history.saveAll("host-3", "/work", []), undefined, "nothing to write writes nothing");
		assert.equal(fs.existsSync(path.join(dir, "host-3.json")), false);
	});
});

test("loading from a directory that is not there yet reads nothing, warns about nothing and makes nothing", () => {
	withDir((root) => {
		const dir = path.join(root, "history");
		const history = new History(dir);
		assert.deepEqual(history.load("host-1"), { records: [], writable: true });
		assert.equal(history.prune(), 0);
		assert.equal(fs.existsSync(dir), false);
	});
});
