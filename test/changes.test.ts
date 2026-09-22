import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { changedFiles, snapshot } from "../extensions/changes.ts";

function repo(): { dir: string; git: (...args: string[]) => string; write: (file: string, text: string) => void } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-changes-")));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
	const write = (file: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), text);
	};
	git("init", "-q");
	write("kept.ts", "a\nb\n");
	write("edited.ts", "a\nb\nc\n");
	write("gone.ts", "x\n");
	write("dirty.ts", "one\n");
	write("sub/deep.ts", "d\n");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	return { dir, git, write };
}

test("a snapshot pair names what changed in between, with line counts, and ignores what was already dirty", async () => {
	const { dir, git, write } = repo();
	try {
		write("dirty.ts", "one\ntwo\n");
		write("untouched-new.ts", "n\n");
		const before = await snapshot(path.join(dir, "sub"));
		assert.ok(before, "a subdirectory of a work tree still gets a snapshot");

		write("edited.ts", "a\nB\nc\nd\n");
		fs.rmSync(path.join(dir, "gone.ts"));
		write("new.ts", "1\n2\n3\n");
		write("sub/deep.ts", "d\ne\n");
		write("dirty.ts", "one\ntwo\nthree\n");
		write("committed.ts", "c\n");
		git("add", "committed.ts");
		git("commit", "-q", "-m", "during");
		const after = await snapshot(dir);
		assert.ok(after);

		assert.deepEqual(await changedFiles(before, after), [
			{ path: "committed.ts", status: "C", added: 1, removed: 0 },
			{ path: "dirty.ts", status: "M", added: 2, removed: 0 },
			{ path: "edited.ts", status: "M", added: 2, removed: 1 },
			{ path: "gone.ts", status: "D", added: 0, removed: 1 },
			{ path: "new.ts", status: "A", added: 3, removed: 0 },
			{ path: "sub/deep.ts", status: "M", added: 1, removed: 0 },
		]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a file put back to its HEAD content is reported as reverted", async () => {
	const { dir, write } = repo();
	try {
		write("kept.ts", "changed\n");
		const before = await snapshot(dir);
		write("kept.ts", "a\nb\n");
		const after = await snapshot(dir);
		assert.deepEqual(await changedFiles(before!, after!), [{ path: "kept.ts", status: "U" }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("outside a git work tree there is no snapshot", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-nogit-"));
	try {
		assert.equal(await snapshot(dir), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
