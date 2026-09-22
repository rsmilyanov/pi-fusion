import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const GIT_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_COUNTED_BYTES = 1024 * 1024;

/** A file that differs from HEAD, and the blob id of what is in the working tree. */
interface FileState {
	status: string;
	hash: string;
}

/** The working tree's difference from HEAD at one moment, so two snapshots show what changed in between. */
export interface Snapshot {
	/** The work tree's top level: git reports paths relative to it, so every command runs there. */
	root: string;
	head?: string;
	files: Map<string, FileState>;
}

export interface ChangedFile {
	path: string;
	/** `A` added, `M` modified, `D` deleted, `R` renamed, `C` committed during the run, `U` back to its HEAD content. */
	status: string;
	/** Lines added and removed against HEAD, or against nothing for a new file; absent for binary files. */
	added?: number;
	removed?: number;
}

function git(cwd: string, args: string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_BUFFER_BYTES, encoding: "utf8" }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

function statusLetter(xy: string): string {
	if (xy === "??" || xy.includes("A")) return "A";
	if (xy.includes("D")) return "D";
	if (xy.includes("R") || xy.includes("C")) return "R";
	return "M";
}

/** `git status --porcelain -z`: a rename or copy entry is followed by its source path, which is skipped. */
function parseStatus(text: string): Map<string, string> {
	const statuses = new Map<string, string>();
	const tokens = text.split("\0");
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.length < 4) continue;
		const xy = token.slice(0, 2);
		statuses.set(token.slice(3), statusLetter(xy));
		if (xy.includes("R") || xy.includes("C")) index++;
	}
	return statuses;
}

/** Undefined when `cwd` is not in a git work tree or git fails: the dashboard then shows no file list. */
export async function snapshot(cwd: string): Promise<Snapshot | undefined> {
	try {
		const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
		const status = parseStatus(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]));
		const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")).trim();
		const present = [...status].filter(([, letter]) => letter !== "D").map(([file]) => file);
		const hashes = present.length ? (await git(root, ["hash-object", "--stdin-paths"], `${present.join("\n")}\n`)).split("\n") : [];
		const hashOf = new Map(present.map((file, at) => [file, hashes[at] ?? ""]));
		const files = new Map<string, FileState>();
		for (const [file, letter] of status) files.set(file, { status: letter, hash: hashOf.get(file) ?? "" });
		return { root, ...(head ? { head } : {}), files };
	} catch {
		return undefined;
	}
}

function applyNumstat(changed: Map<string, ChangedFile>, numstat: string, status?: string): void {
	for (const line of numstat.split("\0")) {
		const [added, removed, file] = line.split("\t");
		if (file === undefined || !file) continue;
		if (status !== undefined && !changed.has(file)) changed.set(file, { path: file, status });
		const entry = changed.get(file);
		if (!entry || added === "-") continue;
		entry.added = Number(added);
		entry.removed = Number(removed);
	}
}

function countLines(file: string): number | undefined {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > MAX_COUNTED_BYTES) return undefined;
		const text = fs.readFileSync(file);
		if (text.includes(0)) return undefined;
		const body = text.toString("utf8");
		return body ? body.split("\n").length - (body.endsWith("\n") ? 1 : 0) : 0;
	} catch {
		return undefined;
	}
}

/** Every file whose working tree state differs between the two snapshots, plus files in commits made in between. */
export async function changedFiles(before: Snapshot, after: Snapshot): Promise<ChangedFile[]> {
	if (before.root !== after.root) return [];
	const cwd = after.root;
	const changed = new Map<string, ChangedFile>();
	for (const [file, state] of after.files) {
		const earlier = before.files.get(file);
		if (!earlier || earlier.status !== state.status || earlier.hash !== state.hash) changed.set(file, { path: file, status: state.status });
	}
	for (const file of before.files.keys()) if (!after.files.has(file)) changed.set(file, { path: file, status: "U" });
	if (before.head && after.head && before.head !== after.head) {
		const committed = new Map<string, ChangedFile>();
		try {
			applyNumstat(committed, await git(cwd, ["diff", "--numstat", "-z", "--no-renames", before.head, after.head]), "C");
		} catch {}
		for (const [file, entry] of committed) if (!changed.has(file)) changed.set(file, entry);
	}
	const tracked = [...changed.values()].filter((file) => file.status === "M" || file.status === "D");
	if (tracked.length && after.head) {
		try {
			applyNumstat(changed, await git(cwd, ["diff", "--numstat", "-z", "--no-renames", "HEAD", "--", ...tracked.map((file) => file.path)]));
		} catch {}
	}
	for (const file of changed.values()) {
		if (file.status !== "A") continue;
		const lines = countLines(path.join(cwd, file.path));
		if (lines === undefined) continue;
		file.added = lines;
		file.removed = 0;
	}
	return [...changed.values()].sort((a, b) => a.path.localeCompare(b.path));
}
