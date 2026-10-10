import * as fs from "node:fs";
import * as path from "node:path";
import { FUSION_DIR } from "./backends/pi-storage.ts";
import { queued, reason, writePrivate } from "./profile-store.ts";

/**
 * Fusion's own user-global settings: one JSON file, `settings.json` in the Fusion-owned directory under the host agent
 * directory, beside `profiles.json` and never Pi's own `settings.json`. An instance reads its history preference and
 * plan context cap once, when it starts: saving them changes the next instance, never a running one. Reading a missing
 * file is an empty document and creates nothing.
 *
 * Writes go through the profile store's queue and private atomic write, so the same tradeoff holds: writes of this
 * process to the file are queued and each rereads what the one before it left, and nothing coordinates two Pi
 * processes, or a person editing the file, with each other; the last rename wins.
 */

export const SETTINGS_FILE = "settings.json";
/** The layout of the settings file. A file that names another version is one this build neither reads nor replaces. */
export const SETTINGS_VERSION = 1;

/** What the settings file holds. A preference the file does not name is unset, which is not the same as off. */
export interface FusionSettings {
	version: typeof SETTINGS_VERSION;
	history?: { enabled: boolean };
	plan?: { contextPct: number };
}

export interface SettingsStore {
	/** Where the settings live, for a person to find and edit. */
	where(): Promise<string>;
	/** The document as it is now: an empty one when there is no file, or an error naming what is wrong with the file. */
	read(): Promise<FusionSettings>;
	/** Rereads the document, applies the change and writes the result, after every write of this process queued before it. */
	update(change: (current: FusionSettings) => FusionSettings): Promise<FusionSettings>;
}

export const emptySettings = (): FusionSettings => ({ version: SETTINGS_VERSION });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The settings a parsed file holds, or an error saying what is wrong. The version is checked before the fields, because
 * a newer build may add fields this one does not know; every field this one does know is checked by type.
 */
export function parseSettings(value: unknown): FusionSettings {
	if (!isRecord(value)) throw new Error("the file must hold a JSON object");
	if (value.version !== SETTINGS_VERSION) {
		const newer = typeof value.version === "number" && Number.isInteger(value.version) && value.version > SETTINGS_VERSION;
		throw new Error(`the file has version ${JSON.stringify(value.version) ?? "undefined"}${newer ? ", written by a newer pi-fusion," : ""} and this build reads version ${SETTINGS_VERSION} only`);
	}
	for (const key of Object.keys(value)) if (key !== "version" && key !== "history" && key !== "plan") throw new Error(`the file has unknown field ${JSON.stringify(key)}`);
	const settings = emptySettings();
	if (value.history !== undefined) {
		if (!isRecord(value.history)) throw new Error("history must be an object");
		for (const key of Object.keys(value.history)) if (key !== "enabled") throw new Error(`history has unknown field ${JSON.stringify(key)}`);
		const enabled = value.history.enabled;
		if (enabled !== undefined) {
			if (typeof enabled !== "boolean") throw new Error("history.enabled must be true or false");
			settings.history = { enabled };
		}
	}
	if (value.plan !== undefined) {
		if (!isRecord(value.plan)) throw new Error("plan must be an object");
		for (const key of Object.keys(value.plan)) if (key !== "contextPct") throw new Error(`plan has unknown field ${JSON.stringify(key)}`);
		const contextPct = value.plan.contextPct;
		if (contextPct !== undefined) {
			if (typeof contextPct !== "number" || !Number.isFinite(contextPct) || contextPct < 0 || contextPct > 100) throw new Error("plan.contextPct must be a number between 0 and 100");
			settings.plan = { contextPct };
		}
	}
	return settings;
}

/** The document as it is written, with only the preferences it names. */
export function serializeSettings(settings: FusionSettings): string {
	return `${JSON.stringify({ version: SETTINGS_VERSION, ...(settings.history === undefined ? {} : { history: { enabled: settings.history.enabled } }), ...(settings.plan === undefined ? {} : { plan: { contextPct: settings.plan.contextPct } }) }, null, 2)}\n`;
}

/** The settings a file's text holds, or an error naming the file and what is wrong with it. */
function parsed(text: string, where: string): FusionSettings {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`settings file ${where} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it by hand`);
	}
	try {
		return parseSettings(value);
	} catch (error) {
		throw new Error(`settings file ${where}: ${error instanceof Error ? error.message : String(error)}; fix it by hand`);
	}
}

/**
 * The store in `<dir>/settings.json`, where `dir` is the Fusion directory under the host agent directory. The
 * directory is resolved on each operation, so nothing is read before the first one.
 */
export function fileSettingsStore(fusionDir: () => string | Promise<string>): SettingsStore {
	const file = async (): Promise<string> => path.resolve(await fusionDir(), SETTINGS_FILE);
	const readFile = async (target: string): Promise<FusionSettings> => {
		let text: string;
		try {
			text = await fs.promises.readFile(target, "utf8");
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return emptySettings();
			throw new Error(`settings file ${target} could not be read (${reason(error)})`);
		}
		return parsed(text, target);
	};
	return {
		where: file,
		read: async () => readFile(await file()),
		update: async (change) => {
			const target = await file();
			return queued(target, async () => {
				// A file this cannot read, or one a newer build wrote, is never replaced by a command: the person fixes it first.
				const next = change(await readFile(target));
				await writePrivate(target, serializeSettings(next), "settings file");
				return next;
			});
		},
	};
}

/** The production store, in the host agent directory Pi itself resolves, which is only asked for on first use. */
export function hostSettingsStore(agentDir: () => Promise<string>): SettingsStore {
	return fileSettingsStore(async () => path.join(await agentDir(), FUSION_DIR));
}

/** A store held in memory, for a host that must never read or write the user's file. `text` is what a file would hold. */
export function memorySettingsStore(initial?: string): SettingsStore & { text(): string | undefined } {
	let text = initial;
	const key = `memory:${Math.random().toString(36).slice(2)}`;
	const where = "(in memory)";
	const read = async (): Promise<FusionSettings> => (text === undefined ? emptySettings() : parsed(text, where));
	return {
		where: async () => where,
		read,
		update: (change) =>
			queued(key, async () => {
				const next = change(await read());
				text = serializeSettings(next);
				return next;
			}),
		text: () => text,
	};
}
