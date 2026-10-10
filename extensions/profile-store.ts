import * as fs from "node:fs";
import * as path from "node:path";
import { FUSION_DIR, ownedDir } from "./backends/pi-storage.ts";
import { emptyDocument, parseDocument, type ProfileDocument, serializeDocument } from "./profiles.ts";

/**
 * Where profiles are kept: one JSON file, `profiles.json` in the Fusion-owned directory under the host agent
 * directory, shared by every project and every Pi process of this user. Reading a missing file is an empty store and
 * creates nothing; only a save or a default change creates the directory and the file.
 *
 * A write rereads the file, applies its one change, writes a private temporary sibling and renames it over the file,
 * so a reader never sees half a document. Writes of this process to one file are queued, whichever extension instance
 * makes them, and each rereads what the one before it left. Nothing coordinates two Pi processes, or a person editing
 * the file, with each other: two saves at once from separate processes can each read the same document, and the last
 * rename wins. That is the agreed tradeoff; there is no lock to recover.
 */

export const PROFILES_FILE = "profiles.json";

export interface ProfileStore {
	/** Where the profiles live, for a person to find and edit. */
	where(): Promise<string>;
	/** The document as it is now: an empty one when there is no file, or an error naming what is wrong with the file. */
	read(): Promise<ProfileDocument>;
	/** Rereads the document, applies the change and writes the result, after every write of this process queued before it. */
	update(change: (current: ProfileDocument) => ProfileDocument): Promise<ProfileDocument>;
}

/**
 * The writes queued per file, shared by every store of this module in this process so two instances never interleave.
 * The Fusion settings store queues its own file here too, keyed by its own path.
 */
const queues = new Map<string, Promise<void>>();

/** Runs the operation after every one queued for the same key, whether those succeeded or not. */
export function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const before = queues.get(key) ?? Promise.resolve();
	const result = before.then(operation, operation);
	const tail = result.then(
		() => {},
		() => {},
	);
	queues.set(key, tail);
	// Only the last operation queued removes the key: one that settles while a newer one waits leaves the newer in place.
	void tail.then(() => {
		if (queues.get(key) === tail) queues.delete(key);
	});
	return result;
}

export const reason = (error: unknown): string => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
};

/**
 * Writes the text to the file in a private directory through a private temporary sibling and a rename, so a reader
 * never sees half of it and a write that fails leaves the file as it was. `what` names the file in the error.
 */
export async function writePrivate(target: string, text: string, what: string): Promise<void> {
	try {
		ownedDir(path.dirname(target));
	} catch (error) {
		throw new Error(`${what} ${target} could not be written: ${error instanceof Error ? error.message : String(error)}`);
	}
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	try {
		await fs.promises.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
		await fs.promises.rename(temporary, target);
	} catch (error) {
		await fs.promises.unlink(temporary).catch(() => {});
		throw new Error(`${what} ${target} could not be written (${reason(error)}); it is unchanged`);
	}
}

/** The document a file's text holds, or an error naming the file and what is wrong with it. */
function parsed(text: string, where: string): ProfileDocument {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`profiles file ${where} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it by hand`);
	}
	try {
		return parseDocument(value);
	} catch (error) {
		throw new Error(`profiles file ${where}: ${error instanceof Error ? error.message : String(error)}; fix it by hand`);
	}
}

/**
 * The store in `<dir>/profiles.json`, where `dir` is the Fusion directory under the host agent directory. The
 * directory is resolved on each operation, so nothing is read before the first one.
 */
export function fileProfileStore(fusionDir: () => string | Promise<string>): ProfileStore {
	const file = async (): Promise<string> => path.resolve(await fusionDir(), PROFILES_FILE);
	const readFile = async (target: string): Promise<ProfileDocument> => {
		let text: string;
		try {
			text = await fs.promises.readFile(target, "utf8");
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return emptyDocument();
			throw new Error(`profiles file ${target} could not be read (${reason(error)})`);
		}
		return parsed(text, target);
	};
	return {
		where: file,
		read: async () => readFile(await file()),
		update: async (change) => {
			const target = await file();
			return queued(target, async () => {
				// A file this cannot read is never replaced as a side effect of a command: the person fixes it first.
				const next = change(await readFile(target));
				await writePrivate(target, serializeDocument(next), "profiles file");
				return next;
			});
		},
	};
}

/** The production store, in the host agent directory Pi itself resolves, which is only asked for on first use. */
export function hostProfileStore(agentDir: () => Promise<string>): ProfileStore {
	return fileProfileStore(async () => path.join(await agentDir(), FUSION_DIR));
}

/** A store held in memory, for a host that must never read or write the user's file. `text` is what a file would hold. */
export function memoryProfileStore(initial?: string): ProfileStore & { text(): string | undefined } {
	let text = initial;
	const key = `memory:${Math.random().toString(36).slice(2)}`;
	const where = "(in memory)";
	const read = async (): Promise<ProfileDocument> => (text === undefined ? emptyDocument() : parsed(text, where));
	return {
		where: async () => where,
		read,
		update: (change) =>
			queued(key, async () => {
				const next = change(await read());
				text = serializeDocument(next);
				return next;
			}),
		text: () => text,
	};
}
