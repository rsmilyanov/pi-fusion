import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { emptySettings, fileSettingsStore, hostSettingsStore, memorySettingsStore, parseSettings, serializeSettings, SETTINGS_FILE } from "../extensions/settings-store.ts";

/** A Fusion directory of the case's own, inside a temporary root that is removed afterwards; the directory itself is not made. */
async function withDir<T>(body: (dir: string, file: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-settings-"));
	const dir = path.join(root, "pi-fusion");
	try {
		return await body(dir, path.join(dir, SETTINGS_FILE));
	} finally {
		fs.chmodSync(root, 0o700);
		if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const write = (file: string, text: string): void => {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, text, { mode: 0o600 });
};

test("a missing file is no saved preference, and reading it creates nothing", () =>
	withDir(async (dir, file) => {
		const store = fileSettingsStore(() => dir);
		assert.deepEqual(await store.read(), emptySettings());
		assert.equal((await store.read()).history, undefined, "no file is unset, never off");
		assert.equal(await store.where(), file);
		assert.equal(fs.existsSync(dir), false, "a read makes neither the directory nor the file");
	}));

test("the host store lives in pi-fusion/settings.json under the host agent directory, beside the profiles and never Pi's own settings", async () => {
	const store = hostSettingsStore(async () => "/home/someone/.pi/agent");
	assert.equal(await store.where(), path.resolve("/home/someone/.pi/agent/pi-fusion/settings.json"));
});

test("the document reads an absent preference as unset and both booleans as themselves", () => {
	assert.deepEqual(parseSettings({ version: 1 }), { version: 1 });
	assert.deepEqual(parseSettings({ version: 1, history: {} }), { version: 1 }, "a history object without enabled saves nothing");
	assert.deepEqual(parseSettings({ version: 1, history: { enabled: true } }), { version: 1, history: { enabled: true } });
	assert.deepEqual(parseSettings({ version: 1, history: { enabled: false } }), { version: 1, history: { enabled: false } });
	assert.equal(serializeSettings({ version: 1, history: { enabled: true } }), '{\n  "version": 1,\n  "history": {\n    "enabled": true\n  }\n}\n');
	assert.equal(serializeSettings(emptySettings()), '{\n  "version": 1\n}\n', "an unset preference is not written as off");
});

test("the optional plan cap round-trips as a number, including zero, fractions and both bounds", () => {
	assert.deepEqual(parseSettings({ version: 1, plan: {} }), { version: 1 });
	for (const contextPct of [0, 35, 60.5, 100]) {
		const settings = { version: 1 as const, plan: { contextPct } };
		assert.deepEqual(parseSettings(settings), settings);
		assert.deepEqual(parseSettings(JSON.parse(serializeSettings(settings))), settings);
		assert.deepEqual(parseSettings({ ...settings, history: {} }), settings, "an unset history preference does not skip the plan cap");
		assert.deepEqual(parseSettings({ ...settings, history: { enabled: false } }), { ...settings, history: { enabled: false } });
	}
});

test("a malformed document, an unknown version or an unknown field is refused with what is wrong", () => {
	const refused: Array<[unknown, RegExp]> = [
		[null, /must hold a JSON object/],
		[[], /must hold a JSON object/],
		["on", /must hold a JSON object/],
		[{}, /version undefined and this build reads version 1 only/],
		[{ version: "1" }, /version "1" and this build reads version 1 only/],
		[{ version: 0 }, /version 0 and this build reads version 1 only/],
		[{ version: 2, history: { enabled: true } }, /version 2, written by a newer pi-fusion, and this build reads version 1 only/],
		[{ version: 2, future: "field" }, /newer pi-fusion/],
		[{ version: 1, defaultProfile: "work" }, /unknown field "defaultProfile"/],
		[{ version: 1, history: null }, /history must be an object/],
		[{ version: 1, history: true }, /history must be an object/],
		[{ version: 1, history: [] }, /history must be an object/],
		[{ version: 1, history: { enabled: "yes" } }, /history.enabled must be true or false/],
		[{ version: 1, history: { enabled: 1 } }, /history.enabled must be true or false/],
		[{ version: 1, history: { enabled: null } }, /history.enabled must be true or false/],
		[{ version: 1, history: { enabled: true, dir: "/tmp" } }, /history has unknown field "dir"/],
		[{ version: 1, plan: null }, /plan must be an object/],
		[{ version: 1, plan: true }, /plan must be an object/],
		[{ version: 1, plan: [] }, /plan must be an object/],
		[{ version: 1, plan: { contextPct: 60, model: "opus" } }, /plan has unknown field "model"/],
		...["60", true, null, -1, 101, NaN, Infinity].map((contextPct): [unknown, RegExp] => [{ version: 1, plan: { contextPct } }, /plan.contextPct must be a number between 0 and 100/]),
	];
	for (const [value, reason] of refused) assert.throws(() => parseSettings(value), reason, JSON.stringify(value));
});

test("a file that cannot be read says which file and why, and is never replaced", () =>
	withDir(async (dir, file) => {
		const store = fileSettingsStore(() => dir);
		for (const text of ["{ not json", JSON.stringify({ version: 2, history: { enabled: false } }), JSON.stringify({ version: 1, history: { enabled: "no" } }), JSON.stringify({ version: 1, plan: { contextPct: "60" } })]) {
			write(file, text);
			await assert.rejects(store.read(), (error: Error) => error.message.startsWith(`settings file ${file}`) && /fix it by hand$/.test(error.message));
			await assert.rejects(store.update(() => ({ version: 1, history: { enabled: true } })), /fix it by hand/);
			assert.equal(fs.readFileSync(file, "utf8"), text, "an update over a file this cannot read leaves it as it was");
		}
		fs.rmSync(file);
		fs.mkdirSync(file);
		await assert.rejects(store.read(), new RegExp(`^Error: settings file ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could not be read \\(EISDIR\\)$`));
		await assert.rejects(store.update(() => emptySettings()), /could not be read/);
		assert.ok(fs.statSync(file).isDirectory(), "what stood there still does");
	}));

test("an update writes a private file in a private directory through a temporary sibling, and leaves nothing else", () =>
	withDir(async (dir, file) => {
		const store = fileSettingsStore(() => dir);
		const saved = await store.update((current) => ({ ...current, history: { enabled: true } }));
		assert.deepEqual(saved, { version: 1, history: { enabled: true } });
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(dir), [SETTINGS_FILE], "no temporary file is left behind");
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, history: { enabled: true } });
		await store.update((current) => ({ ...current, history: { enabled: false } }));
		assert.deepEqual(await store.read(), { version: 1, history: { enabled: false } });
	}));

test("a history update preserves the saved plan cap", () =>
	withDir(async (dir, file) => {
		write(file, serializeSettings({ version: 1, plan: { contextPct: 0 } }));
		const store = fileSettingsStore(() => dir);
		await store.update((current) => ({ ...current, history: { enabled: true } }));
		assert.deepEqual(await store.read(), { version: 1, history: { enabled: true }, plan: { contextPct: 0 } });
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, history: { enabled: true }, plan: { contextPct: 0 } });
	}));

test("a write that fails leaves the file as it was and says so", { skip: process.getuid?.() === 0 ? "root writes into a read-only directory" : false }, () =>
	withDir(async (dir, file) => {
		const store = fileSettingsStore(() => dir);
		await store.update(() => ({ version: 1, history: { enabled: false } }));
		const before = fs.readFileSync(file, "utf8");
		fs.chmodSync(dir, 0o500);
		try {
			// The private-directory check refuses before a temporary file is tried, and either way the error names the file.
			await assert.rejects(store.update(() => ({ version: 1, history: { enabled: true } })), new RegExp(`^Error: settings file ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could not be written.*EACCES`));
		} finally {
			fs.chmodSync(dir, 0o700);
		}
		assert.equal(fs.readFileSync(file, "utf8"), before);
		assert.deepEqual(fs.readdirSync(dir), [SETTINGS_FILE]);
		// A change that throws writes nothing either.
		await assert.rejects(store.update(() => {
			throw new Error("changed my mind");
		}), /changed my mind/);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	}));

test("writes of this process to one file are queued, whichever store makes them, and each reads what the last one left", () =>
	withDir(async (dir) => {
		const one = fileSettingsStore(() => dir);
		const other = fileSettingsStore(async () => dir);
		const seen: Array<boolean | undefined> = [];
		const values = [true, false, true, true, false];
		await Promise.all(
			values.map((enabled, index) =>
				(index % 2 ? other : one).update((current) => {
					seen.push(current.history?.enabled);
					return { ...current, history: { enabled } };
				}),
			),
		);
		assert.deepEqual(seen, [undefined, ...values.slice(0, -1)], "every write saw the one queued before it");
		assert.deepEqual(await one.read(), { version: 1, history: { enabled: false } });
	}));

test("the memory store reads and writes the same document without touching a file", async () => {
	const empty = memorySettingsStore();
	assert.deepEqual(await empty.read(), { version: 1 });
	assert.equal(empty.text(), undefined);
	await empty.update((current) => ({ ...current, history: { enabled: true } }));
	assert.equal(empty.text(), serializeSettings({ version: 1, history: { enabled: true } }));
	assert.equal(await empty.where(), "(in memory)");
	const broken = memorySettingsStore("{");
	await assert.rejects(broken.read(), /^Error: settings file \(in memory\) is not valid JSON/);
	await assert.rejects(broken.update(() => emptySettings()), /not valid JSON/);
	assert.equal(broken.text(), "{", "a document this cannot read is left as it was");
});
