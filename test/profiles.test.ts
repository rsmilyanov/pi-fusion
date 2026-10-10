import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, ExtensionEditorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { PiRole } from "../extensions/backends/pi-binding.ts";
import type { BackendName, HostBackend } from "../extensions/backends/types.ts";
import fusion, { builtinConfiguration, type Configuration, claudeRoute, fusionCall, fusionRoute, roleFor, type RunRecords, runRecords } from "../extensions/fusion.ts";
import { fileProfileStore, memoryProfileStore, PROFILES_FILE, type ProfileStore } from "../extensions/profile-store.ts";
import { memorySettingsStore } from "../extensions/settings-store.ts";
import {
	BUILTIN,
	builtinSettings,
	captureBaseline,
	CLAUDE_MODEL_SUGGESTIONS,
	CODEX_MODEL_SUGGESTIONS,
	copySettings,
	nameProblem,
	parseDocument,
	parseSettings,
	type RoleSettings,
	serializeDocument,
	settingsTable,
} from "../extensions/profiles.ts";
import { type FakeBackend, fakeBackend } from "./fake-pi-backend.ts";
import { turnOn } from "./host-tools.ts";
import { tripwires } from "./tripwire.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempDirs: string[] = [];
after(() => {
	for (const dir of tempDirs) {
		try {
			fs.chmodSync(dir, 0o700);
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
const tempDir = (name: string): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fusion-profiles-${name}-`));
	tempDirs.push(dir);
	return dir;
};

/** The environment every baseline in this file is captured from, so nothing here depends on what this process has set. */
const ENV = {} as NodeJS.ProcessEnv;
const baseline = captureBaseline(ENV);
const LEGACY = builtinSettings(baseline);

/** The legacy defaults with the roles a case names over them, as a complete configuration. */
const settings = (over: Partial<Record<keyof RoleSettings, Record<string, unknown>>> = {}): RoleSettings => parseSettings({ ...LEGACY, ...over });

const configured = (roles: RoleSettings, profile = "work"): Configuration => ({ profile, modified: false, roles, baseline });

const document = (profiles: Record<string, RoleSettings>, defaultProfile: string | null = null): string => serializeDocument({ version: 1, defaultProfile, profiles });

const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: "pi-fusion", data });
const records = (...entries: Array<Record<string, unknown>>): RunRecords => runRecords(entries.map(entry));

// ---------------------------------------------------------------------------------------------------------------------
// The configuration itself: pure, with no file and no host.

test("the built-in configuration disables security even with a configured model, and captures each role's defaults from the environment", () => {
	assert.deepEqual(LEGACY, {
		plan: { enabled: true, backend: "claude", model: "fable", effort: "xhigh" },
		implement: { enabled: true, backend: "claude", model: "opus", effort: "high" },
		ultracode: { enabled: true, backend: "claude", model: "fable", effort: "ultracode" },
		ask: { enabled: true, backend: "claude", model: "opus", effort: "high" },
		security: { enabled: false, backend: "pi" },
	});
	const env = { PI_FUSION_IMPLEMENT_MODEL: "sonnet", PI_FUSION_ASK_EFFORT: "low", PI_FUSION_PI_SECURITY_MODEL: "deepseek/deepseek-chat", PI_FUSION_PI_PLAN_EFFORT: "high" } as NodeJS.ProcessEnv;
	const captured = captureBaseline(env);
	assert.deepEqual(builtinSettings(captured).implement, { enabled: true, backend: "claude", model: "sonnet", effort: "high" });
	assert.deepEqual(builtinSettings(captured).security, { enabled: false, backend: "pi", model: "deepseek/deepseek-chat" });
	assert.deepEqual(captured.plan.pi, { effort: "high" }, "the other backend's legacy defaults are captured too, for a call that names it");
	assert.deepEqual(captured.implement.codex, {}, "a codex role whose variables are unset runs on the host's own codex defaults");
	env.PI_FUSION_IMPLEMENT_MODEL = "haiku";
	assert.equal(captured.implement.claude?.model, "sonnet", "a baseline is a copy: a variable changed later does not reach it");
});

test("a configuration is validated whole: every role, its backend, its model and its effort", () => {
	assert.deepEqual(parseSettings(copySettings(LEGACY)), LEGACY);
	const bad: Array<[unknown, RegExp]> = [
		[{ ...LEGACY, extra: LEGACY.plan }, /^Error: roles has unknown role "extra"/],
		[(({ security: _, ...rest }) => rest)(LEGACY), /^Error: roles has no security role/],
		[{ ...LEGACY, plan: { ...LEGACY.plan, colour: "red" } }, /^Error: roles\.plan has unknown field "colour"/],
		[{ ...LEGACY, plan: { ...LEGACY.plan, enabled: "yes" } }, /^Error: roles\.plan\.enabled must be true or false$/],
		[{ ...LEGACY, plan: { ...LEGACY.plan, backend: "gemini" } }, /^Error: roles\.plan\.backend must be claude, pi or codex$/],
		[{ ...LEGACY, ultracode: { enabled: true, backend: "pi" } }, /^Error: roles\.ultracode\.backend is pi, but role ultracode runs on claude only$/],
		[{ ...LEGACY, security: { enabled: false, backend: "claude" } }, /^Error: roles\.security\.backend is claude, but role security runs on pi only$/],
		[{ ...LEGACY, ask: { enabled: true, backend: "pi", model: "deepseek-chat" } }, /^Error: roles\.ask\.model "deepseek-chat" is not a pi provider and model id/],
		[{ ...LEGACY, ask: { ...LEGACY.ask, model: "  " } }, /^Error: roles\.ask\.model must be a non-empty string; leave it out instead$/],
		[{ ...LEGACY, ask: { ...LEGACY.ask, model: " opus" } }, /^Error: roles\.ask\.model " opus" has spaces around it$/],
		[{ ...LEGACY, ask: { ...LEGACY.ask, effort: "off" } }, /^Error: roles\.ask\.effort "off" is not a claude effort; use one of low, medium, high, xhigh, max$/],
		[{ ...LEGACY, ask: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "ultracode" } }, /^Error: roles\.ask\.effort "ultracode" is not a pi effort/],
		[{ ...LEGACY, ultracode: { ...LEGACY.ultracode, effort: "xhigh" } }, /^Error: roles\.ultracode\.effort must be ultracode or left out/],
		[{ ...LEGACY, implement: { enabled: true, backend: "claude", effort: "high" } }, /^Error: roles\.implement is enabled on claude and names no model$/],
		[{ ...LEGACY, implement: { enabled: true, backend: "claude", model: "opus" } }, /^Error: roles\.implement is enabled on claude and names no effort$/],
		[[], /^Error: roles must be an object$/],
	];
	for (const [value, expected] of bad) assert.throws(() => parseSettings(value), expected, JSON.stringify(value));
	// What may be left out: a disabled role needs no model, an enabled pi role may be unconfigured, ultracode's effort.
	const loose = parseSettings({
		...LEGACY,
		implement: { enabled: false, backend: "claude" },
		ask: { enabled: true, backend: "pi" },
		ultracode: { enabled: true, backend: "claude", model: "fable" },
		plan: { enabled: true, backend: "pi", model: "openrouter/deepseek/deepseek-chat", effort: "off" },
	});
	assert.deepEqual(loose.implement, { enabled: false, backend: "claude" });
	assert.deepEqual(loose.ask, { enabled: true, backend: "pi" });
	assert.equal(loose.plan.model, "openrouter/deepseek/deepseek-chat", "a provider's own slashes survive");
	// A disabled role's supplied fields are still checked.
	assert.throws(() => parseSettings({ ...LEGACY, ask: { enabled: false, backend: "pi", model: "nope" } }), /roles\.ask\.model "nope"/);
});

test("a codex role is checked by its own grammar: any single-token model and effort, and an enabled role may name neither", () => {
	const env = {
		PI_FUSION_CODEX_IMPLEMENT_MODEL: " gpt-5-codex ",
		PI_FUSION_CODEX_IMPLEMENT_EFFORT: "high",
		PI_FUSION_CODEX_ASK_EFFORT: "minimal",
		PI_FUSION_CODEX_PLAN_MODEL: "gpt-5",
		PI_FUSION_CODEX_PLAN_EFFORT: " xhigh ",
		PI_FUSION_CODEX_ULTRACODE_MODEL: "gpt-5",
		PI_FUSION_CODEX_SECURITY_MODEL: "gpt-5",
	} as NodeJS.ProcessEnv;
	const captured = captureBaseline(env);
	assert.deepEqual(captured.implement.codex, { model: "gpt-5-codex", effort: "high" });
	assert.deepEqual(captured.ask.codex, { effort: "minimal" });
	assert.deepEqual(captured.plan.codex, { model: "gpt-5", effort: "xhigh" }, "role plan's own codex variables, trimmed, as every codex role's");
	assert.deepEqual(captureBaseline({} as NodeJS.ProcessEnv).plan.codex, {}, "unset, a codex plan run takes the host's own model and effort");
	for (const role of ["ultracode", "security"] as const) assert.equal(captured[role].codex, undefined, `role ${role} does not run on codex, so no variable of it is read`);
	for (const role of ["plan", "implement", "ask"] as const) assert.equal(builtinSettings(captured)[role].backend, "claude", "codex is never a role's default backend");
	// An enabled codex role with no model and no effort is the host's own default, not an unconfigured role.
	const loose = parseSettings({ ...LEGACY, plan: { enabled: true, backend: "codex" }, implement: { enabled: true, backend: "codex" }, ask: { enabled: true, backend: "codex", model: "gpt-5", effort: "ultra-deep" } });
	assert.deepEqual(loose.plan, { enabled: true, backend: "codex" }, "role plan may run on codex on the host's own defaults");
	assert.deepEqual(loose.implement, { enabled: true, backend: "codex" });
	assert.deepEqual(loose.ask, { enabled: true, backend: "codex", model: "gpt-5", effort: "ultra-deep" }, "an effort the editor does not suggest is still one token a codex model may take");
	assert.deepEqual(parseSettings({ ...LEGACY, ask: { enabled: true, backend: "codex", effort: "xhigh" } }).ask, { enabled: true, backend: "codex", effort: "xhigh" });
	const bad: Array<[unknown, RegExp]> = [
		[{ ...LEGACY, implement: { enabled: true, backend: "codex", model: "gpt 5" } }, /^Error: roles\.implement\.model "gpt 5" has whitespace in it, which no codex model id has$/],
		[{ ...LEGACY, implement: { enabled: true, backend: "codex", model: "" } }, /^Error: roles\.implement\.model must be a non-empty string; leave it out instead$/],
		[{ ...LEGACY, implement: { enabled: true, backend: "codex", effort: "very high" } }, /^Error: roles\.implement\.effort "very high" is not a codex effort; name one level, such as low, medium, high, xhigh, with no spaces in it$/],
		[{ ...LEGACY, implement: { enabled: true, backend: "codex", effort: "" } }, /^Error: roles\.implement\.effort "" is not a codex effort/],
		[{ ...LEGACY, implement: { enabled: true, backend: "codex", effort: 3 } }, /^Error: roles\.implement\.effort 3 is not a codex effort/],
		[{ ...LEGACY, implement: { enabled: true, backend: "codex", sandbox: "read-only" } }, /^Error: roles\.implement has unknown field "sandbox"/],
		[{ ...LEGACY, ultracode: { enabled: true, backend: "codex" } }, /^Error: roles\.ultracode\.backend is codex, but role ultracode runs on claude only$/],
		[{ ...LEGACY, security: { enabled: false, backend: "codex" } }, /^Error: roles\.security\.backend is codex, but role security runs on pi only$/],
	];
	for (const [value, expected] of bad) assert.throws(() => parseSettings(value), expected, JSON.stringify(value));
	// A profile document holding a codex role round-trips, model left out and all.
	const saved = parseDocument(JSON.parse(document({ codex: loose }, "codex")));
	assert.deepEqual(saved.profiles.codex, loose);
	assert.deepEqual(settingsTable(loose).slice(1, 5), [
		"plan       yes      codex    host default  host default",
		"implement  yes      codex    host default  host default",
		"ultracode  yes      claude   fable         ultracode (fixed)",
		"ask        yes      codex    gpt-5         ultra-deep",
	]);
});

test("built-in security refuses explicit models and continuations, while a saved profile can enable it", () => {
	const config = builtinConfiguration(captureBaseline({ PI_FUSION_PI_SECURITY_MODEL: "openai/gpt-5" }));
	const branch = records({ run: "run-1", role: "security", backend: "pi", hostSessionId: "host-1", session: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" }, selection: { model: "openai/gpt-5", effort: "medium" } });
	for (const call of [{ role: "security", task: "audit" }, { role: "security", task: "audit", backend: "pi", model: "openai/gpt-5" }, { continue: "run-1", task: "audit more" }]) {
		assert.throws(() => fusionCall(call, branch, 35, config), /role security is disabled in profile builtin/);
	}
	const roles = copySettings(config.roles);
	roles.security.enabled = true;
	const saved = parseDocument(JSON.parse(document({ security: roles }, "security")));
	const enabled: Configuration = { ...config, profile: "security", roles: saved.profiles.security! };
	assert.equal(fusionCall({ role: "security", task: "audit" }, records(), 35, enabled).bound.model, "openai/gpt-5");
	assert.equal(fusionCall({ continue: "run-1", task: "audit more" }, branch, 35, enabled).handle, "run-1");
});

test("a copy of a configuration shares nothing with it", () => {
	const copy = copySettings(LEGACY);
	copy.plan.model = "sonnet";
	copy.ask.enabled = false;
	assert.equal(LEGACY.plan.model, "fable");
	assert.equal(LEGACY.ask.enabled, true);
});

test("profile names are plain and case-sensitive, and builtin is no name a profile can take", () => {
	for (const name of ["work", "Work", "a", "w.2_x-y", "x".repeat(64)]) assert.equal(nameProblem(name), undefined, name);
	for (const name of ["", "-x", ".x", "a b", "a/b", "x".repeat(65), "ü"]) assert.match(nameProblem(name) ?? "", /must start with a letter or digit/, name);
	assert.match(nameProblem(BUILTIN) ?? "", /^builtin is the built-in configuration and cannot be saved over$/);
});

test("the profiles file is versioned, and anything this build does not read is refused rather than guessed at", () => {
	const work = settings({ ask: { enabled: false, backend: "claude" } });
	const parsed = parseDocument(JSON.parse(document({ work }, "work")));
	assert.deepEqual(parsed, { version: 1, defaultProfile: "work", profiles: { work } });
	assert.deepEqual(parseDocument({ version: 1, profiles: {} }), { version: 1, defaultProfile: null, profiles: {} }, "no default is the built-in configuration");
	assert.deepEqual(parseDocument({ version: 1, defaultProfile: "gone", profiles: {} }).defaultProfile, "gone", "a default the file does not hold is the loader's to report");
	const bad: Array<[unknown, RegExp]> = [
		[{ version: 2, profiles: {} }, /has version 2, and this build reads version 1 only/],
		[{ profiles: {} }, /has version undefined/],
		[{ version: 1, profiles: {}, extra: true }, /unknown field "extra"/],
		[{ version: 1, defaultProfile: "builtin", profiles: {} }, /defaultProfile: builtin is the built-in configuration and cannot be saved over; use null for builtin/],
		[{ version: 1, profiles: { builtin: { roles: LEGACY } } }, /profiles: builtin is the built-in configuration/],
		[{ version: 1, profiles: { "a b": { roles: LEGACY } } }, /profiles: profile name "a b"/],
		[{ version: 1, profiles: { work: { roles: LEGACY, note: "x" } } }, /profiles\.work has unknown field "note"/],
		[{ version: 1, profiles: { work: { roles: { ...LEGACY, plan: { enabled: 1, backend: "claude" } } } } }, /profiles\.work\.roles\.plan\.enabled must be true or false/],
		["text", /must hold a JSON object/],
	];
	for (const [value, expected] of bad) assert.throws(() => parseDocument(value), expected, JSON.stringify(value));
});

test("the configuration table names every role with its backend, model and effort, unconfigured and fixed included", () => {
	assert.deepEqual(settingsTable(settings({ implement: { enabled: false, backend: "claude" }, ask: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat" } })), [
		"role       enabled  backend  model                   effort",
		"plan       yes      claude   fable                   xhigh",
		"implement  no       claude   unconfigured            none",
		"ultracode  yes      claude   fable                   ultracode (fixed)",
		"ask        yes      pi       deepseek/deepseek-chat  child default",
		"security   no       pi       unconfigured            child default",
	]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The store: one JSON file, read without writing and replaced whole.

test("a missing profiles file reads as an empty store and creates nothing", async () => {
	const root = tempDir("absent");
	const fusionDir = path.join(root, "agent", "pi-fusion");
	const store = fileProfileStore(() => fusionDir);
	assert.deepEqual(await store.read(), { version: 1, defaultProfile: null, profiles: {} });
	assert.equal(await store.where(), path.join(fusionDir, PROFILES_FILE));
	assert.equal(fs.existsSync(path.join(root, "agent")), false, "reading created no directory");
});

test("a save creates the private directory and file, round-trips the snapshot and keeps every other profile", async () => {
	const fusionDir = path.join(tempDir("save"), "agent", "pi-fusion");
	const store = fileProfileStore(() => fusionDir);
	const work = settings({ ultracode: { enabled: false, backend: "claude" } });
	const home = settings({ implement: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "high" } });
	await store.update((current) => ({ ...current, profiles: { ...current.profiles, work } }));
	await store.update((current) => ({ ...current, defaultProfile: "home", profiles: { ...current.profiles, home } }));
	assert.equal(fs.statSync(fusionDir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.join(fusionDir, PROFILES_FILE)).mode & 0o777, 0o600);
	assert.deepEqual(await store.read(), { version: 1, defaultProfile: "home", profiles: { home, work } });
	assert.deepEqual(fs.readdirSync(fusionDir), [PROFILES_FILE], "no temporary file is left beside it");
});

test("a malformed profiles file is reported, never overwritten by a command, and left byte for byte as it was", async () => {
	const fusionDir = tempDir("malformed");
	const file = path.join(fusionDir, PROFILES_FILE);
	const store = fileProfileStore(() => fusionDir);
	for (const text of ["{ not json", JSON.stringify({ version: 9, profiles: {} })]) {
		fs.writeFileSync(file, text);
		await assert.rejects(store.read(), new RegExp(`^Error: profiles file ${file.replaceAll("/", "\\/")}`));
		await assert.rejects(store.update((current) => current), /fix it by hand$/);
		assert.equal(fs.readFileSync(file, "utf8"), text);
	}
});

test("two stores on one file in this process queue their writes, each rereading what the one before it left", async () => {
	const fusionDir = tempDir("queue");
	const one = fileProfileStore(() => fusionDir);
	// The same file named another way: the queue is keyed by the absolute path, not by the string a store was given.
	const other = fileProfileStore(() => path.join(fusionDir, ".", "x", ".."));
	const names = ["a", "b", "c", "d", "e", "f"];
	await Promise.all(names.map((name, index) => (index % 2 ? one : other).update((current) => ({ ...current, profiles: { ...current.profiles, [name]: LEGACY } }))));
	assert.deepEqual(Object.keys((await one.read()).profiles).sort(), names, "no save lost another's profile");
	// A change that throws fails that update alone; the one queued after it still runs on the latest document.
	const failing = one.update(() => {
		throw new Error("refused");
	});
	const next = other.update((current) => ({ ...current, defaultProfile: "a" }));
	await assert.rejects(failing, /^Error: refused$/);
	assert.equal((await next).defaultProfile, "a");
	assert.equal(Object.keys((await one.read()).profiles).length, names.length);
});

test("a write that fails leaves the file it would have replaced as it was, and no temporary file of its own", async () => {
	const fusionDir = tempDir("failing");
	const store = fileProfileStore(() => fusionDir);
	await store.update((current) => ({ ...current, profiles: { work: LEGACY } }));
	const file = path.join(fusionDir, PROFILES_FILE);
	const before = fs.readFileSync(file, "utf8");
	// The rename is the step that replaces the file, so failing it after the temporary file was written is the case
	// the cleanup is for.
	const rename = fs.promises.rename;
	fs.promises.rename = async () => {
		throw Object.assign(new Error("simulated"), { code: "EXDEV" });
	};
	try {
		await assert.rejects(store.update((current) => ({ ...current, defaultProfile: "work" })), /could not be written \(EXDEV\); it is unchanged$/);
	} finally {
		fs.promises.rename = rename;
	}
	assert.equal(fs.readFileSync(file, "utf8"), before);
	assert.deepEqual(fs.readdirSync(fusionDir), [PROFILES_FILE], "the temporary file this write made is gone");
	// A directory this user cannot write is refused by the shared directory check before anything is written.
	if (process.getuid?.() !== 0) {
		fs.chmodSync(fusionDir, 0o500);
		try {
			await assert.rejects(store.update((current) => ({ ...current, defaultProfile: "work" })), /could not be written: inspect .* it is not readable, writable and searchable by this user \(EACCES\)$/);
		} finally {
			fs.chmodSync(fusionDir, 0o700);
		}
		assert.equal(fs.readFileSync(file, "utf8"), before);
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// Routing under a configuration: pure, with records written out as literals.

test("a fresh run goes to the role's configured backend, on its configured model and effort, and a call's own values win", () => {
	const config = configured(
		settings({
			implement: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "high" },
			ask: { enabled: true, backend: "claude", model: "sonnet", effort: "low" },
		}),
	);
	const implement = fusionCall({ role: "implement", task: "x" }, records(), 35, config);
	assert.deepEqual([implement.backend, implement.bound.model, (implement.bound as PiRole).effort], ["pi", "deepseek/deepseek-chat", "high"]);
	const ask = fusionCall({ role: "ask", task: "x" }, records(), 35, config);
	assert.deepEqual([ask.backend, ask.bound.model, ask.bound.effort], ["claude", "sonnet", "low"]);
	const named = fusionCall({ role: "ask", task: "x", model: "opus", effort: "max" }, records(), 35, config);
	assert.deepEqual([named.bound.model, named.bound.effort], ["opus", "max"]);
	assert.equal(fusionRoute({ role: "ask", task: "x" }, records(), 35, config).call.model, undefined, "a configured default is never written into the call");
});

test("a call naming the other backend runs on that backend's legacy defaults, and nothing configured for the role's backend leaks across", () => {
	const piBaseline = captureBaseline({ PI_FUSION_PI_IMPLEMENT_MODEL: "deepseek/deepseek-chat" } as NodeJS.ProcessEnv);
	const config: Configuration = { profile: "work", modified: false, roles: settings({ implement: { enabled: true, backend: "claude", model: "sonnet", effort: "low" } }), baseline: piBaseline };
	const onPi = fusionCall({ role: "implement", task: "x", backend: "pi" }, records(), 35, config);
	assert.deepEqual([onPi.bound.model, (onPi.bound as PiRole).effort], ["deepseek/deepseek-chat", undefined], "the pi baseline, never the claude model or effort");
	const noPi: Configuration = { ...config, baseline };
	assert.throws(() => fusionCall({ role: "implement", task: "x", backend: "pi" }, records(), 35, noPi), /^Error: role implement has no model for the pi backend: set PI_FUSION_PI_IMPLEMENT_MODEL/);
	// And the other way round: a role configured on pi runs on claude's own defaults when a call names claude.
	const toClaude = configured(settings({ plan: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "off" } }));
	const plan = fusionCall({ role: "plan", task: "x", backend: "claude" }, records(), 35, toClaude);
	assert.deepEqual([plan.bound.model, plan.bound.effort], ["fable", "xhigh"]);
	// The compatibility tool is that same explicit override, forced.
	const forced = claudeRoute({ role: "plan", task: "x" }, records(), 35, toClaude);
	assert.deepEqual([forced.backend, roleFor(forced.call, forced.defaults).model], ["claude", "fable"]);
});

test("a pi role a profile leaves unconfigured is refused in that profile's words, and never borrows a variable", () => {
	const piBaseline = captureBaseline({ PI_FUSION_PI_SECURITY_MODEL: "deepseek/deepseek-chat" } as NodeJS.ProcessEnv);
	const config: Configuration = { profile: "work", modified: true, roles: settings({ security: { enabled: true, backend: "pi" } }), baseline: piBaseline };
	assert.throws(
		() => fusionCall({ role: "security", task: "x" }, records(), 35, config),
		/^Error: role security has no model for the pi backend in profile work \(modified\): choose a provider and a model id, such as deepseek\/deepseek-chat, with \/fusion config, or name one in the call's model parameter/,
	);
	assert.equal(fusionCall({ role: "security", task: "x", model: "openai/gpt-5" }, records(), 35, config).bound.model, "openai/gpt-5");
	// The built-in configuration keeps the configured model without enabling the role.
	assert.equal(builtinConfiguration(piBaseline).roles.security.model, "deepseek/deepseek-chat");
	assert.throws(() => fusionCall({ role: "security", task: "x" }, records(), 35, builtinConfiguration(piBaseline)), /role security is disabled in profile builtin/);
});

test("a session-less pi handle fails closed under a profile, and retrying fresh uses that profile", () => {
	for (const role of ["plan", "implement", "ask", "security"] as const) {
		const config = configured(settings({ [role]: { enabled: true, backend: "pi", model: "openai/gpt-5", effort: "high" } }));
		const failed = records({ run: "run-1", role, backend: "pi", hostSessionId: "host-1" });
		const refusal = /^Error: run-1 ran on pi and recorded no verified session/;
		assert.throws(() => fusionCall({ continue: "run-1", task: "retry" }, failed, 35, config), refusal, role);
		assert.throws(() => fusionCall({ continue: "run-1", task: "retry", model: "deepseek/deepseek-chat", effort: "low" }, failed, 35, config), refusal, "naming a model cannot make an unverified run continuable");
		if (role === "plan") assert.throws(() => fusionCall({ role, task: "retry" }, failed, 35, config), refusal, "an implicit plan call also fails closed");
		const fresh = fusionCall({ role, task: "retry", ...(role === "plan" ? { fresh: true } : {}) }, failed, 35, config);
		assert.deepEqual([fresh.handle, fresh.record, fresh.bound.model, fresh.bound.effort], ["run-2", undefined, "openai/gpt-5", "high"]);
	}
});

test("a disabled role is refused before anything is bound, whatever the call names, and for a continuation too", () => {
	const config = configured(settings({ ultracode: { enabled: false, backend: "claude" }, implement: { enabled: false, backend: "claude" } }));
	const refusal = /^Error: role implement is disabled in profile work; change \/fusion config or select another profile$/;
	assert.throws(() => fusionRoute({ role: "implement", task: "x" }, records(), 35, config), refusal);
	assert.throws(() => fusionRoute({ role: "implement", task: "x", backend: "pi", model: "deepseek/deepseek-chat", effort: "high" }, records(), 35, config), refusal);
	assert.throws(() => claudeRoute({ role: "implement", task: "x", model: "opus" }, records(), 35, config), refusal);
	const done = records({ run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", model: "opus", effort: "high" });
	assert.throws(() => fusionRoute({ continue: "run-1", task: "more" }, done, 35, config), refusal);
	assert.throws(() => claudeRoute({ continue: "run-1", task: "more" }, done, 35, config), refusal);
	assert.throws(() => fusionRoute({ role: "ultracode", task: "x" }, records(), 35, config), /^Error: role ultracode is disabled in profile work;/);
	// An unknown role is still an unknown role, before any configuration is read.
	assert.throws(() => fusionRoute({ role: "audit", task: "x" }, records(), 35, config), /^Error: unknown role audit;/);
	// Enabling the role is all a continuation needs.
	assert.equal(fusionRoute({ continue: "run-1", task: "more" }, done, 35, configured(LEGACY)).handle, "run-1");
});

test("a continuation keeps the model and effort it recorded, whatever profile is selected since", () => {
	const other = configured(settings({ implement: { enabled: true, backend: "claude", model: "haiku", effort: "low" }, plan: { enabled: true, backend: "claude", model: "opus", effort: "medium" } }));
	const implement = records({ run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", model: "sonnet", effort: "max" });
	const kept = fusionCall({ continue: "run-1", task: "more" }, implement, 35, other);
	assert.deepEqual([kept.bound.model, kept.bound.effort, kept.unrecorded], ["sonnet", "max", undefined]);
	// An implicit plan continuation keeps the plan run's model: a configured default is not a change of model.
	const plan = records({ run: "run-1", role: "plan", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", model: "sonnet", effort: "low" });
	const implicit = fusionCall({ role: "plan", task: "next" }, plan, 35, other);
	assert.deepEqual([implicit.handle, implicit.handoff, implicit.bound.model, implicit.bound.effort], ["run-1", undefined, "sonnet", "low"]);
	// A deliberately fresh plan takes the profile's.
	const fresh = fusionCall({ role: "plan", task: "start over", fresh: true }, plan, 35, other);
	assert.deepEqual([fresh.handle, fresh.bound.model, fresh.bound.effort], ["run-2", "opus", "medium"]);
	// An old entry's missing fields are the legacy defaults this instance started with, never the profile's, and it says so.
	const old = records({ run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1" });
	const legacy = fusionCall({ continue: "run-1", task: "more" }, old, 35, other);
	assert.deepEqual([legacy.bound.model, legacy.bound.effort], ["opus", "high"]);
	assert.equal(legacy.unrecorded, "run-1 was recorded before its settings were kept, so it runs on the default this Pi process started with: model (opus), effort (high)");
});

test("a cap replacement keeps the planner's model unless the call names another, and takes its effort from the call or the configured role", () => {
	const fable = configured(settings({ plan: { enabled: true, backend: "claude", model: "fable", effort: "xhigh" } }));
	const full = { contextTokens: 400_000, contextWindow: 1_000_000 };
	const sonnet = records({ run: "run-1", role: "plan", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", model: "sonnet", effort: "low", ...full });
	const handed = fusionCall({ role: "plan", task: "next" }, sonnet, 35, fable);
	assert.deepEqual([handed.handle, handed.handoff?.reason.kind, handed.bound.model, handed.bound.effort], ["run-2", "cap", "sonnet", "xhigh"]);
	assert.equal(fusionCall({ role: "plan", task: "next", effort: "max" }, sonnet, 35, fable).bound.effort, "max");
	// Another model named is a model handoff, on that model, at the configured effort.
	const model = fusionCall({ role: "plan", task: "next", model: "opus" }, sonnet, 35, fable);
	assert.deepEqual([model.handoff?.reason.kind, model.bound.model, model.bound.effort], ["model", "opus", "xhigh"]);
	assert.equal(fusionCall({ role: "plan", task: "next", fresh: true }, sonnet, 35, fable).bound.model, "fable");
	// On pi the recorded model and level go together.
	const onPi = configured(settings({ plan: { enabled: true, backend: "pi", model: "openai/gpt-5", effort: "xhigh" } }));
	const piPlan = records({
		run: "run-1",
		role: "plan",
		backend: "pi",
		hostSessionId: "host-1",
		session: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" },
		selection: { model: "deepseek/deepseek-chat", effort: "low" },
		...full,
	});
	const piHanded = fusionCall({ role: "plan", task: "next" }, piPlan, 35, onPi);
	assert.deepEqual([piHanded.backend, piHanded.handoff?.reason.kind, piHanded.bound.model, (piHanded.bound as PiRole).effort], ["pi", "cap", "deepseek/deepseek-chat", "low"]);
	assert.deepEqual([fusionCall({ role: "plan", task: "next", fresh: true }, piPlan, 35, onPi).bound.model], ["openai/gpt-5"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The extension on a host whose tool registry behaves as Pi 0.85.1's does in the two ways this feature depends on.

interface Tool {
	name: string;
	description: string;
	promptGuidelines?: string[];
	executionMode?: string;
	parameters?: unknown;
	execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: undefined, ctx: any) => Promise<{ content: Array<{ text: string }>; details?: any }>;
}

interface SdkHostOptions {
	profiles?: ProfileStore;
	/** The host's `--tools` allow list, which a registry refresh puts back on the active list whole. */
	allowed?: string[];
	backends?: Partial<Record<BackendName, HostBackend>>;
	/** The answers the host's select and input dialogs give, in order; a function picks one of the options offered. */
	dialogs?: Array<string | undefined | ((options: string[]) => string | undefined | Promise<string | undefined>)>;
	ui?: boolean;
	/** False leaves the editor dialog out while select and input stay, as a host without one would. */
	editor?: boolean;
	modelRegistry?: unknown;
	/** What the host has active before this extension registers anything; read and bash by default. */
	initial?: string[];
}

/**
 * A host whose tool registry models what this feature relies on in the installed SDK, and nothing else: registering
 * a name again replaces its definition, a name new to the registry becomes active, and a refresh under an allow list
 * puts every allowed tool back on the active list. It measures what Fusion does with those behaviours; that the SDK
 * has them is the manual spike's to show, never this file's.
 */
function sdkHost(options: SdkHostOptions = {}) {
	const tools = new Map<string, Tool>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions: (prefix: string) => unknown }>();
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const branch: unknown[] = [];
	const notices: Array<[string, string]> = [];
	const active: string[] = [...(options.initial ?? ["read", "bash"])];
	/** Set by a case: the next tool list change goes part way and then throws, as a host that failed mid-update would. */
	let failing = false;
	const registrations: string[] = [];
	const dialogs = [...(options.dialogs ?? [])];
	const titles: string[] = [];
	/** What each input dialog was given as its placeholder, which is never text the user edits. */
	const placeholders: Array<string | undefined> = [];
	/** What each editor dialog was prefilled with: text the user edits and submits. */
	const editorPrefills: Array<string | undefined> = [];
	const offered = (name: string) => options.allowed === undefined || options.allowed.includes(name);
	const api = {
		registerTool: (tool: Tool) => {
			registrations.push(tool.name);
			const known = tools.has(tool.name);
			tools.set(tool.name, tool);
			if (!known && !active.includes(tool.name)) active.push(tool.name);
			for (const name of options.allowed ?? []) if (tools.has(name) && !active.includes(name)) active.push(name);
		},
		getActiveTools: () => [...active],
		// A name the registry does not hold is dropped, and an allow list keeps a tool it does not name out of the registry.
		setActiveTools: (names: string[]) => {
			if (failing) {
				failing = false;
				active.splice(0, active.length, ...names.slice(0, 1));
				throw new Error("the host refused the tool list");
			}
			active.splice(0, active.length, ...names.filter((name) => !tools.has(name) || offered(name)));
		},
		getAllTools: () => [...tools.keys()].filter(offered).map((name) => ({ name })),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (event: string, handler: any) => handlers.set(event, handler),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		sendMessage: () => {},
		registerMessageRenderer: () => {},
	} as unknown as ExtensionAPI;
	fusion(api, { backends: { ...tripwires(), ...options.backends }, profiles: options.profiles ?? memoryProfileStore(), settings: memorySettingsStore() });
	const answer = (options: string[]) => {
		const next = dialogs.shift();
		return typeof next === "function" ? next(options) : next;
	};
	const ui = {
		setStatus() {},
		setWidget() {},
		notify: (text: string, level: string) => notices.push([text, level]),
		...(options.ui === false
			? {}
			: {
					select: async (title: string, choices: string[]) => {
						titles.push(title);
						return answer(choices);
					},
					input: async (title: string, placeholder?: string) => {
						titles.push(title);
						placeholders.push(placeholder);
						return answer([]);
					},
					...(options.editor === false
						? {}
						: {
								editor: async (title: string, prefill?: string) => {
									titles.push(title);
									editorPrefills.push(prefill);
									return answer([]);
								},
							}),
				}),
	};
	const ctx = {
		cwd: repoRoot,
		mode: "print",
		hasUI: options.ui !== false,
		ui,
		...(options.modelRegistry === undefined ? {} : { modelRegistry: options.modelRegistry }),
		sessionManager: { getSessionId: () => "host-1", getBranch: () => branch, getSessionFile: () => undefined },
	};
	const call = async (tool: string, params: Record<string, unknown>, signal?: AbortSignal) => {
		try {
			const result = await tools.get(tool)!.execute("call-1", params, signal, undefined, ctx);
			return { text: result.content[0]!.text, details: result.details };
		} catch (error) {
			return { error: (error as Error).message };
		}
	};
	return {
		tools,
		active,
		registrations,
		notices,
		titles,
		placeholders,
		editorPrefills,
		branch,
		dialogs,
		start: async () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
		settled: async () => handlers.get("agent_settled")!({ type: "agent_settled" }, ctx),
		/** Turns Fusion on as a user's request for it does, through the activation tool. */
		on: () => turnOn(tools.get("fusion_activate"), ctx),
		command: async (args: string) => commands.get("fusion")!.handler(args, ctx),
		completions: (prefix: string) => commands.get("fusion")!.getArgumentCompletions(prefix),
		fusion: (params: Record<string, unknown>) => call("fusion", params),
		claude: (params: Record<string, unknown>) => call("claude", params),
		call,
		failNextToolChange: () => {
			failing = true;
		},
		shutdown: async () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx),
		last: () => notices.at(-1)?.[0],
	};
}

const WORK = settings({
	implement: { enabled: true, backend: "claude", model: "sonnet", effort: "low" },
	ultracode: { enabled: false, backend: "claude" },
	ask: { enabled: true, backend: "claude", model: "haiku", effort: "medium" },
});

test("the default profile loads as the session starts, and the host's guidance and every call follow it", async () => {
	const claude = fakeBackend({ name: "claude" });
	const host = sdkHost({ profiles: memoryProfileStore(document({ work: WORK }, "work")), backends: { claude: claude.backend } });
	assert.match(host.tools.get("fusion")!.description, /implement runs on claude with model opus at effort high/, "before the session starts, the built-in guidance");
	await host.start();
	assert.deepEqual(host.notices, [], "a default that loaded is no warning");
	const description = host.tools.get("fusion")!.description;
	assert.match(description, /In this session's configuration plan runs on claude with model fable at effort xhigh; implement runs on claude with model sonnet at effort low; ultracode is disabled; ask runs on claude with model haiku at effort medium;/);
	const guidelines = host.tools.get("fusion")!.promptGuidelines ?? [];
	assert.ok(guidelines.some((line) => /disables role ultracode, role security: a fusion call to a disabled role is refused/.test(line)), guidelines.join("\n"));
	assert.ok(!guidelines.some((line) => /Use fusion with role ultracode/.test(line)), "a disabled role is recommended nowhere");
	assert.match(host.tools.get("claude")!.description, /ultracode is disabled/);
	assert.deepEqual(host.active, ["read", "bash", "fusion_activate"], "and fusion starts off, with only its way in offered");
	await host.command("status");
	// The history line is the instance's own, whatever profile it runs, and is checked where history is the subject.
	assert.deepEqual(host.last()?.split("\n").slice(0, 10).filter((line) => !line.startsWith("history: ")), ["fusion: off", "profile: work", "", ...settingsTable(WORK)]);
	await host.on();
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.deepEqual([claude.starts[0]!.role.model, claude.starts[0]!.role.effort], ["sonnet", "low"]);
	assert.equal((host.branch.at(-1) as any).data.effort, "low", "and the run records what it was admitted with");
	assert.equal((await host.claude({ role: "ultracode", task: "x" })).error, "role ultracode is disabled in profile work; change /fusion config or select another profile");
	assert.equal(claude.starts.length, 1, "a refused call starts nothing");
	await host.shutdown();
});

test("the claude guidance respects pi-routed profiles and leaves explicit Claude overrides available", async (t) => {
	const piRoles = settings({
		plan: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "low" },
		implement: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "high" },
		ask: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "medium" },
	});
	const pi = fakeBackend();
	const claude = fakeBackend({ name: "claude" });
	const host = sdkHost({ profiles: memoryProfileStore(document({ work: piRoles }, "work")), backends: { pi: pi.backend, claude: claude.backend } });
	t.after(() => host.shutdown());
	await host.start();
	await host.on();
	const guidance = host.tools.get("claude")!.promptGuidelines!.join("\n");
	assert.match(guidance, /Use fusion for these roles unless the user explicitly asks for Claude Code/);
	assert.match(guidance, /Call fusion with role plan/);
	assert.match(guidance, /Send every implementation task to fusion with role implement/);
	assert.match(guidance, /Use fusion with role ask/);
	assert.doesNotMatch(guidance, /Call claude with role plan|Send every implementation task to claude|Use claude with role ask/);
	assert.match(guidance, /legacy Claude defaults/);
	assert.doesNotMatch(guidance, /leave both unset, which runs each role on this session's configured defaults/);
	assert.doesNotMatch(host.tools.get("fusion")!.promptGuidelines!.join("\n"), /Use fusion for these roles unless/);
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.deepEqual([pi.starts[0]!.role.model, pi.starts[0]!.role.effort], ["deepseek/deepseek-chat", "high"]);
	assert.equal(claude.starts.length, 0, "the configured route does not start Claude");
	assert.equal((await host.claude({ role: "implement", task: "explicit Claude work" })).error, undefined);
	assert.deepEqual([claude.starts[0]!.role.model, claude.starts[0]!.role.effort], ["opus", "high"], "the compatibility tool remains an explicit override on legacy defaults");

	await host.command("profile use builtin");
	const builtin = host.tools.get("claude")!.promptGuidelines!.join("\n");
	assert.match(builtin, /Call claude with role plan/);
	assert.match(builtin, /Send every implementation task to claude with role implement/);
	assert.match(builtin, /Use claude with role ask/);
	assert.doesNotMatch(builtin, /Use fusion for these roles unless/);
});

test("mixed-profile guidance recommends each role's configured backend", async () => {
	const work = settings({ implement: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat" }, ask: { enabled: false, backend: "pi" } });
	const noPlan = { ...work, plan: { ...work.plan, enabled: false } };
	const host = sdkHost({ profiles: memoryProfileStore(document({ work, noPlan }, "work")) });
	await host.start();
	const guidance = host.tools.get("claude")!.promptGuidelines!.join("\n");
	assert.match(guidance, /Call claude with role plan/);
	assert.match(guidance, /Send every implementation task to fusion with role implement/);
	assert.doesNotMatch(guidance, /Use (fusion|claude) with role ask/);
	assert.match(guidance, /disables role ask/);
	await host.command("profile use noPlan");
	for (const tool of ["fusion", "claude"]) {
		assert.doesNotMatch(host.tools.get(tool)!.promptGuidelines!.join("\n"), /Call (fusion|claude) with role plan|to (fusion|claude) with role plan/, "a disabled planner is not recommended, even on escalation");
	}
});

test("roles configured on codex are described as runs that can ask, take one unconfirmed steer per message and continue from their exact turn, in each tool's own name", async () => {
	const codexRoles = settings({ plan: { enabled: true, backend: "codex" }, implement: { enabled: true, backend: "codex" }, ask: { enabled: true, backend: "codex", model: "gpt-5-codex", effort: "high" } });
	const host = sdkHost({ profiles: memoryProfileStore(document({ work: codexRoles }, "work")) });
	await host.start();
	const fusionGuidance = host.tools.get("fusion")!.promptGuidelines!;
	const codexLine = fusionGuidance.find((guideline) => guideline.startsWith("Role plan, role implement and role ask run on codex in this session."));
	assert.ok(codexLine, "the fusion guidance does not say what a codex run is");
	assert.match(codexLine, /A codex child can ask you a question and waits for your answer as any child does\./);
	assert.doesNotMatch(codexLine, /cannot ask|experimental/i, "questions are available without an experimental status label");
	assert.match(codexLine, /one steer to its current turn, sent once and never retried: a steer the turn took is queued input, not proof the child read it/);
	assert.match(codexLine, /Continue a codex run with fusion and continue, as any run: it goes on only from the exact turn its record names/);
	assert.doesNotMatch(codexLine, /takes no message|not with continue|cannot be continued/, "a codex run is no longer described as fresh-only or unsteerable");
	assert.doesNotMatch(codexLine, /\bclaude\b/);
	const claudeGuidance = host.tools.get("claude")!.promptGuidelines!;
	assert.ok(claudeGuidance.some((guideline) => /^This session routes role plan, role implement, role ask to codex\. Use fusion for these roles/.test(guideline)));
	assert.ok(claudeGuidance.some((guideline) => guideline.startsWith("Role plan, role implement and role ask run on codex in this session, which fusion runs and claude does not.")));
	// The plan guidance is the fusion tool's on either tool, because only fusion runs a plan configured on codex.
	assert.ok(claudeGuidance.some((guideline) => guideline.startsWith("Call fusion with role plan")));
	const description = host.tools.get("fusion")!.description;
	assert.match(description, /plan runs on codex with the host's default codex model; implement runs on codex with the host's default codex model; .*ask runs on codex with model gpt-5-codex at effort high/);
	assert.match(description, /backend codex runs plan and implement in a workspace-write sandbox, and ask read-only, under the same contracts/);
	assert.doesNotMatch(description, /backend codex is experimental|experimentally/i);
	assert.match(description, /with no ultracode or security role;/);
	assert.match(description, /A codex child also gets ask_orchestrator, through codex's experimental API, and asks you a question as a pi child does\./);
	assert.doesNotMatch(description, /codex child gets no ask_orchestrator/);
	assert.match(description, /A message to a running codex run is sent once to its current turn, with no retry, and a turn that took it has queued it, which does not show the child read it\./);
	assert.match(description, /A codex run is continued like any other, but only from the exact turn its record names: in the Pi session that recorded it its thread is resumed, and refused if it has moved past that turn; in another one it is forked from that turn into a new thread\./);
	assert.match(description, /A codex plan handoff carries the model and effort the plan run recorded and not its provider, so the fresh thread runs on the provider the host's own codex configuration chooses\./);
	assert.doesNotMatch(description, /cannot be continued|takes no message while it runs|as fresh runs|no plan, ultracode or security role|no fresh parameter/, "nothing still calls codex fresh-only or unsteerable");
	assert.doesNotMatch(description, /registers no codex backend|refused as unavailable/, "codex is registered in this build");
	const parameters = host.tools.get("fusion")!.parameters as { properties: Record<string, { description: string }> };
	assert.match(parameters.properties.backend!.description, /codex runs plan, implement and ask through the user's own codex install\./);
	assert.doesNotMatch(parameters.properties.backend!.description, /experimental/i);
	assert.doesNotMatch(parameters.properties.backend!.description, /cannot be continued/);
	assert.match(parameters.properties.model!.description, /on the codex backend a model id with no whitespace, for plan, implement and ask,/);
	assert.match(parameters.properties.effort!.description, /on the codex backend one level with no whitespace, for plan, implement and ask,/);
	for (const tool of ["fusion_control", "claude_control"]) {
		const control = host.tools.get(tool)!.description;
		assert.match(control, /a steer it reads when it next takes input \(on codex, sent once to the run's current turn with no retry, where being taken does not show the child read it\);/, tool);
		assert.match(control, /a message a running child's input does not accept now, closed or full, is not sent, and the reply says so;/, tool);
		assert.doesNotMatch(control, /which takes none/, tool);
	}
	// A builtin session routes nothing to codex, so neither tool carries the line.
	await host.command("profile use builtin");
	for (const tool of ["fusion", "claude"]) assert.ok(!host.tools.get(tool)!.promptGuidelines!.some((guideline) => / on codex in this session/.test(guideline)), tool);
});

test("a broken profiles file or a missing default leaves the built-in configuration and a warning, and rewrites nothing", async () => {
	const broken = memoryProfileStore("{ nope");
	const host = sdkHost({ profiles: broken });
	await host.start();
	assert.equal(host.notices.length, 1);
	assert.match(host.notices[0]![0], /^fusion: profiles file \(in memory\) is not valid JSON .*; fix it by hand; this session uses the builtin configuration$/);
	assert.equal(broken.text(), "{ nope");
	await host.command("profile use work");
	assert.match(host.last() ?? "", /^profile work was not loaded: profiles file \(in memory\) is not valid JSON/);
	await host.command("config");
	assert.match(host.titles.at(-1) ?? "", /^fusion config · builtin\n/, "and the session is still on the built-in configuration");

	const missing = sdkHost({ profiles: memoryProfileStore(document({}, "gone")), ui: false });
	await missing.start();
	assert.deepEqual(missing.notices, [["fusion: the default profile gone is not in (in memory); this session uses the builtin configuration", "warning"]]);
});

test("profile save, list, use and default each do one thing, and only use changes this session", async () => {
	const store = memoryProfileStore();
	const host = sdkHost({ profiles: store, ui: false });
	await host.start();
	await host.command("profile save work");
	assert.equal(host.last(), "saved profile work; it is not the default for new sessions unless /fusion profile default work makes it one");
	await host.command("profile save work");
	assert.match(host.last() ?? "", /^replaced profile work;/);
	await host.command("profile list");
	assert.equal(host.last(), "builtin (default for new sessions)\nwork (current)");
	await host.command("profile default work");
	assert.equal(host.last(), "new sessions start with work; this session keeps work");
	await host.command("profile default nope");
	assert.equal(host.last(), "the default was not changed: unknown profile nope; the profiles are builtin, work");
	assert.equal(parseDocument(JSON.parse(store.text()!)).defaultProfile, "work");
	await host.command("profile use builtin");
	assert.equal(host.last(), "fusion uses profile builtin in this session; disabled: security");
	await host.command("profile list");
	assert.equal(host.last(), "builtin (current)\nwork (default for new sessions)");
	await host.command("profile use nope");
	assert.equal(host.last(), "unknown profile nope; the profiles are builtin, work");
	await host.command("profile default builtin");
	assert.equal(parseDocument(JSON.parse(store.text()!)).defaultProfile, null);
	await host.command("profile");
	assert.match(host.last() ?? "", /^builtin \(current; default for new sessions\)\nwork\nUsage: \/fusion profile/);
	await host.command("config");
	const shown = host.last()?.split("\n") ?? [];
	assert.deepEqual(shown.slice(0, -3), ["fusion configuration: builtin · new sessions start with builtin", ...settingsTable(LEGACY), "profiles file: (in memory)"]);
	// The run history is this instance's own and says where the saved preference lives, apart from the profiles.
	assert.match(shown.slice(-3).join("\n"), /^run history: (on|off) in this instance \([^)]*\)\nsaved history preference for new instances: unset \([^)]*\)\nsettings file: \(in memory\)$/);
	// Completion offers what the last read found.
	assert.deepEqual(host.completions("profile use w"), [{ value: "profile use work", label: "profile use work" }]);
	assert.deepEqual(host.completions("profile save "), [{ value: "profile save work", label: "profile save work" }], "save never offers builtin");
	assert.deepEqual(
		(host.completions("profile default ") as Array<{ value: string }>).map((item) => item.value),
		["profile default builtin", "profile default work"],
	);
});

test("prototype-key profile names are unknown unless explicitly saved, and then work like any profile", async () => {
	for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
		const store = memoryProfileStore();
		const host = sdkHost({ profiles: store, ui: false });
		await host.start();
		await host.command(`profile use ${name}`);
		assert.equal(host.last(), `unknown profile ${name}; the profiles are builtin`);
		await host.command(`profile default ${name}`);
		assert.equal(host.last(), `the default was not changed: unknown profile ${name}; the profiles are builtin`);
		assert.equal(store.text(), undefined, "an unknown default writes nothing");
		await host.command(`profile save ${name}`);
		assert.match(host.last() ?? "", new RegExp(`^saved profile ${name};`), "an inherited name is not an existing profile");
		await host.command(`profile save ${name}`);
		assert.match(host.last() ?? "", new RegExp(`^replaced profile ${name};`));
		await host.command(`profile use ${name}`);
		assert.equal(host.last(), `fusion uses profile ${name} in this session; disabled: security`);
		await host.command(`profile default ${name}`);
		assert.equal((await store.read()).defaultProfile, name);
		const restored = sdkHost({ profiles: store, ui: false });
		await restored.start();
		assert.deepEqual(restored.notices, [], "a stored prototype-key default loads without a warning");
		await restored.command("config");
		assert.match(restored.last() ?? "", new RegExp(`^fusion configuration: ${name} · new sessions start with ${name}`));

		const missingStore = memoryProfileStore(document({}, name));
		const missing = sdkHost({ profiles: missingStore, ui: false });
		await missing.start();
		assert.equal(missing.last(), `fusion: the default profile ${name} is not in (in memory); this session uses the builtin configuration`);
		assert.equal(missingStore.text(), document({}, name), "startup does not rewrite a missing default");
	}
});

test("an edit made to the file elsewhere reaches this session only when a profile is loaded again", async () => {
	const fusionDir = tempDir("external");
	const store = fileProfileStore(() => fusionDir);
	await store.update(() => ({ version: 1, defaultProfile: "work", profiles: { work: LEGACY } }));
	const claude = fakeBackend({ name: "claude" });
	const host = sdkHost({ profiles: store, ui: false, backends: { claude: claude.backend } });
	await host.start();
	await host.on();
	fs.writeFileSync(path.join(fusionDir, PROFILES_FILE), document({ work: WORK }, "work"));
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.equal(claude.starts[0]!.role.model, "opus", "the session keeps the snapshot it loaded");
	await host.command("profile use work");
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.equal(claude.starts[1]!.role.model, "sonnet");
});

/** A claude backend whose first run is held until the case releases it, for a run that stays unfinished. */
async function heldRun(host: ReturnType<typeof sdkHost>, claude: FakeBackend) {
	const call = host.fusion({ role: "implement", task: "long work" });
	const held = await claude.started(1);
	return { call, release: () => held.release() };
}

test("applying settings is refused while any run is unfinished, and saving or changing the default is not", async () => {
	const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }, {}] });
	const store = memoryProfileStore(document({ work: WORK }));
	const host = sdkHost({ profiles: store, backends: { claude: claude.backend }, ui: false });
	await host.start();
	await host.on();
	const run = await heldRun(host, claude);
	await host.command("profile use work");
	assert.equal(
		host.last(),
		"fusion settings stay as they are while runs are unfinished: run-1 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry.",
	);
	await host.command("profile use builtin");
	assert.match(host.last() ?? "", /^fusion settings stay as they are while runs are unfinished/);
	await host.command("profile save snapshot");
	assert.match(host.last() ?? "", /^saved profile snapshot;/);
	await host.command("profile default work");
	assert.equal(host.last(), "new sessions start with work; this session keeps snapshot");
	run.release();
	await run.call;
	await host.command("profile use work");
	assert.equal(host.last(), "fusion uses profile work in this session; disabled: ultracode, security");
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.equal(claude.starts[1]!.role.model, "sonnet");
});

test("the editor stages every change and applies them together, and a run that starts while it is open refuses the apply", async () => {
	const row = (role: string) => (options: string[]) => options.find((option) => option.startsWith(`${role} `));
	const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }, {}] });
	// Cancel leaves everything as it was.
	const cancelled = sdkHost({ dialogs: [row("ultracode"), "enabled: yes", "Back", "Cancel"] });
	await cancelled.start();
	await cancelled.command("config");
	assert.equal(cancelled.last(), "fusion config cancelled; nothing changed");
	assert.match(cancelled.tools.get("fusion")!.description, /ultracode runs on claude with model fable/);

	// Several edits, one apply: ultracode off, implement to pi on a model picked from the host's own list, at a level.
	const registry = { getAvailable: () => [{ provider: "deepseek", id: "deepseek-chat" }, { provider: "openrouter", id: "deepseek/deepseek-r1" }] };
	const host = sdkHost({
		modelRegistry: registry,
		backends: { claude: claude.backend },
		dialogs: [
			row("ultracode"),
			"enabled: yes",
			"Back",
			row("implement"),
			"backend: claude",
			"pi",
			"model: unconfigured",
			(options) => {
				assert.deepEqual(options, ["deepseek/deepseek-chat", "openrouter/deepseek/deepseek-r1", "Type a provider/model id…", "Unconfigured"]);
				return "openrouter/deepseek/deepseek-r1";
			},
			"effort: child default",
			"high",
			"Back",
			"Apply",
		],
	});
	await host.start();
	await host.command("config");
	assert.equal(host.last(), "fusion settings applied to this session; disabled: ultracode, security; save them with /fusion profile save <name>");
	assert.match(host.tools.get("fusion")!.description, /implement runs on pi with model openrouter\/deepseek\/deepseek-r1 at effort high; ultracode is disabled/);
	await host.command("profile list");
	assert.match(host.last() ?? "", /^builtin \(current, modified; default for new sessions\)$/m);
	await host.command("status");
	assert.match(host.last() ?? "", /^fusion: off\nprofile: builtin \(modified\)\n/);
	assert.match(host.last() ?? "", /^implement\s+yes\s+pi\s+openrouter\/deepseek\/deepseek-r1\s+high$/m);
	assert.match(host.last() ?? "", /^ultracode\s+no\s+claude\s+/m);

	// A run admitted while the editor is open: the apply is refused and nothing changes.
	const racing = sdkHost({ backends: { claude: claude.backend } });
	await racing.start();
	await racing.on();
	let run: Awaited<ReturnType<typeof heldRun>> | undefined;
	// The last answer is a dialog still open while a run is admitted, which is what the apply has to notice.
	racing.dialogs.push(row("ask"), "enabled: yes", "Back", async () => {
		run = await heldRun(racing, claude);
		return "Apply";
	});
	await racing.command("config");
	assert.equal(racing.last(), "fusion settings stay as they are while runs are unfinished: run-1 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry.");
	assert.match(racing.tools.get("fusion")!.description, /ask runs on claude with model opus at effort high/, "the ask role is still enabled");
	run!.release();
	await run!.call;
});

test("the editor selects each static codex model for every supported role without changing effort, and profiles keep the exact id", async () => {
	for (const role of ["plan", "implement", "ask"] as const) {
		for (const model of CODEX_MODEL_SUGGESTIONS) {
			const roles = settings({ [role]: { enabled: true, backend: "codex", model: "custom-model", effort: "ultra-deep" } });
			const store = memoryProfileStore(document({ codex: roles }, "codex"));
			const host = sdkHost({
				profiles: store,
				dialogs: [
					(options) => options.find((option) => option.startsWith(`${role} `)),
					"model: custom-model",
					(options) => {
						assert.deepEqual(options, [...CODEX_MODEL_SUGGESTIONS, "Type a codex model id…", "Host default"]);
						return model;
					},
					"Back",
					"Apply",
				],
			});
			await host.start();
			await host.command("config");
			assert.equal(host.last(), "fusion settings applied to this session; disabled: security; save them with /fusion profile save <name>");
			assert.ok(host.tools.get("fusion")!.description.includes(`${role} runs on codex with model ${model} at effort ultra-deep`));
			assert.ok(!host.titles.includes(`Codex model for ${role}: a model id`), "a shortcut does not open the manual input");
			assert.equal(host.dialogs.length, 0);
			await host.command("profile save selected");
			assert.deepEqual((await store.read()).profiles.selected, { ...roles, [role]: { ...roles[role], model } });
		}
	}
});

test("closing the codex model picker or leaving its manual input empty keeps the current model", async () => {
	for (const answers of [[undefined], ["Type a codex model id…", undefined], ["Type a codex model id…", "   "]]) {
		const roles = settings({ ask: { enabled: true, backend: "codex", model: "custom-model", effort: "high" } });
		const host = sdkHost({
			profiles: memoryProfileStore(document({ codex: roles }, "codex")),
			dialogs: [(options) => options.find((option) => option.startsWith("ask ")), "model: custom-model", ...answers, "Back", "Apply"],
		});
		await host.start();
		await host.command("config");
		assert.equal(host.last(), "fusion config: nothing changed");
		assert.ok(host.tools.get("fusion")!.description.includes("ask runs on codex with model custom-model at effort high"));
		assert.equal(host.dialogs.length, 0);
	}
});

/** The Claude picker's options, written out rather than read from the constant so a reorder or rename is caught. */
const CLAUDE_PICKER = ["opus", "opus[1m]", "fable", "claude-opus-5-5", "claude-opus-5-5[1m]", "claude-fable-5-1", "Type a Claude alias or id…"];

/** A Claude role on a model no shortcut names, at a non-default effort except for ultracode, whose one level is fixed. */
const claudeRole = (role: "plan" | "implement" | "ultracode" | "ask") => settings({ [role]: { enabled: true, backend: "claude", model: "custom-alias", effort: role === "ultracode" ? "ultracode" : "low" } });

/** How the fusion tool describes a Claude role on a model, ending where the role's text does so a longer id cannot match. */
const claudeText = (role: string, model: string) => `${role} runs on claude with model ${model}${role === "ultracode" ? ";" : " at effort low;"}`;

test("the claude shortcuts are exactly the static models the picker lists, in its order", () => {
	assert.deepEqual([...CLAUDE_MODEL_SUGGESTIONS], CLAUDE_PICKER.slice(0, -1));
});

test("the editor selects each static claude model for every claude role without manual input or an effort change, and profiles keep the exact string", async () => {
	for (const role of ["plan", "implement", "ultracode", "ask"] as const) {
		for (const model of CLAUDE_PICKER.slice(0, -1)) {
			const roles = claudeRole(role);
			const store = memoryProfileStore(document({ claude: roles }, "claude"));
			const host = sdkHost({
				profiles: store,
				dialogs: [
					(options) => options.find((option) => option.startsWith(`${role} `)),
					"model: custom-alias",
					(options) => {
						assert.deepEqual(options, CLAUDE_PICKER);
						return model;
					},
					"Back",
					"Apply",
				],
			});
			await host.start();
			await host.command("config");
			assert.equal(host.last(), "fusion settings applied to this session; disabled: security; save them with /fusion profile save <name>");
			assert.ok(host.tools.get("fusion")!.description.includes(claudeText(role, model)));
			assert.ok(host.titles.includes(`Claude model for ${role}`));
			assert.ok(!host.titles.includes(`Claude model for ${role}: an alias or id`), "a shortcut does not open the manual editor");
			assert.deepEqual(host.editorPrefills, [], "a shortcut opens no editor");
			assert.deepEqual(host.placeholders, [], "a shortcut opens no input");
			assert.equal(host.dialogs.length, 0);
			await host.command("profile save selected");
			assert.deepEqual((await store.read()).profiles.selected, { ...roles, [role]: { ...roles[role], model } });
			const reloaded = sdkHost({ profiles: store });
			await reloaded.start();
			await reloaded.command("profile use selected");
			assert.ok(reloaded.tools.get("fusion")!.description.includes(claudeText(role, model)));
		}
	}
});

test("the claude manual editor holds the current model as editable text and keeps any typed alias or id, trimmed, through save and reload", async () => {
	for (const role of ["plan", "implement", "ultracode", "ask"] as const) {
		const roles = claudeRole(role);
		const store = memoryProfileStore(document({ claude: roles }, "claude"));
		const host = sdkHost({
			profiles: store,
			dialogs: [(options) => options.find((option) => option.startsWith(`${role} `)), "model: custom-alias", "Type a Claude alias or id…", "  claude-sonnet-5[1m]  ", "Back", "Apply"],
		});
		await host.start();
		await host.command("config");
		assert.equal(host.last(), "fusion settings applied to this session; disabled: security; save them with /fusion profile save <name>");
		assert.ok(host.titles.includes(`Claude model for ${role}: an alias or id`));
		assert.deepEqual(host.editorPrefills, ["custom-alias"], "the editor holds the current model");
		assert.deepEqual(host.placeholders, [], "no input opens, whose argument would only be a placeholder");
		assert.ok(host.tools.get("fusion")!.description.includes(claudeText(role, "claude-sonnet-5[1m]")));
		assert.equal(host.dialogs.length, 0);
		await host.command("profile save typed");
		assert.deepEqual((await store.read()).profiles.typed, { ...roles, [role]: { ...roles[role], model: "claude-sonnet-5[1m]" } });
		const reloaded = sdkHost({ profiles: store });
		await reloaded.start();
		await reloaded.command("profile use typed");
		assert.ok(reloaded.tools.get("fusion")!.description.includes(claudeText(role, "claude-sonnet-5[1m]")));
	}
});

test("closing the claude model picker, cancelling its manual editor or leaving it blank keeps the current model", async () => {
	for (const answers of [[undefined], ["Type a Claude alias or id…", undefined], ["Type a Claude alias or id…", ""], ["Type a Claude alias or id…", "   "]]) {
		const host = sdkHost({
			profiles: memoryProfileStore(document({ claude: claudeRole("ask") }, "claude")),
			dialogs: [(options) => options.find((option) => option.startsWith("ask ")), "model: custom-alias", ...answers, "Back", "Apply"],
		});
		await host.start();
		await host.command("config");
		assert.equal(host.last(), "fusion config: nothing changed");
		assert.deepEqual(host.editorPrefills, answers.length === 1 ? [] : ["custom-alias"]);
		assert.deepEqual(host.placeholders, []);
		assert.ok(host.tools.get("fusion")!.description.includes(claudeText("ask", "custom-alias")));
		assert.equal(host.dialogs.length, 0);
	}
});

test("pi's own extension editor holds the prefilled model as editable text: enter keeps it, an edit changes it, escape cancels and clearing submits nothing", () => {
	// The built-in dark theme, read from the installed package, with no watcher; nothing here opens a terminal or a session.
	initTheme("dark", false);
	const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } } as unknown as TUI;
	// Pi's app manager is not exported; the component asks it only whether a key is the external-editor one, which none here is.
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as ConstructorParameters<typeof ExtensionEditorComponent>[1];
	const edit = (keys: string[]) => {
		const results: Array<string | undefined> = [];
		const editor = new ExtensionEditorComponent(tui, keybindings, "Claude model for plan: an alias or id", "custom-alias", (value) => results.push(value), () => results.push(undefined));
		editor.focused = true;
		editor.render(80);
		for (const key of keys) editor.handleInput(key);
		return results;
	};
	assert.deepEqual(edit(["\r"]), ["custom-alias"]);
	assert.deepEqual(edit(["\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "o", "p", "u", "s", "\r"]), ["custom-opus"]);
	assert.deepEqual(edit(["\x1b"]), [undefined]);
	assert.deepEqual(edit(["\x15", "\r"]), [""]);
});

test("a host with dialogs but no editor shows the configuration instead of editing it, and still offers the profile chooser", async () => {
	const host = sdkHost({ editor: false, dialogs: [undefined] });
	await host.start();
	await host.command("config");
	assert.deepEqual(host.titles, [], "no dialog opens");
	assert.match(host.last() ?? "", /^fusion configuration: builtin · new sessions start with builtin\n/);
	await host.command("profile");
	assert.deepEqual(host.titles, ["fusion profile: load one into this session"]);
	assert.equal(host.last(), "fusion profile: nothing changed");
});

test("the editor puts a role on codex with the host's defaults, offers codex levels as suggestions, and keeps a typed model", async () => {
	const row = (role: string) => (options: string[]) => options.find((option) => option.startsWith(`${role} `));
	const host = sdkHost({
		dialogs: [
			row("implement"),
			(options) => {
				assert.equal(options[1], "backend: claude");
				return options[1];
			},
			(options) => {
				assert.deepEqual(options, ["claude", "pi", "codex"]);
				return "codex";
			},
			(options) => {
				assert.deepEqual(options.slice(2, 4), ["model: host default", "effort: host default"], "a codex role naming neither runs on the host's own defaults");
				return options[2];
			},
			(options) => {
				assert.deepEqual(options, ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "Type a codex model id…", "Host default"]);
				return "Type a codex model id…";
			},
			"gpt 5",
			"model: host default",
			"Type a codex model id…",
			"gpt-5-codex",
			"effort: host default",
			(options) => {
				assert.deepEqual(options, ["low", "medium", "high", "xhigh", "Type a codex effort…", "host default"], "the levels are suggestions, so one can be typed");
				return "xhigh";
			},
			// A typed level with whitespace in it is refused and the effort stays as it was.
			"effort: xhigh",
			"Type a codex effort…",
			"very high",
			// A single token the suggestions do not list is the model's own to take or refuse, so the editor keeps it.
			"effort: xhigh",
			"Type a codex effort…",
			"none",
			"Back",
			"Apply",
		],
	});
	await host.start();
	await host.command("config");
	assert.ok(host.notices.some(([text]) => text === "gpt 5 has whitespace in it, which no codex model id has; the model is unchanged"));
	assert.ok(host.notices.some(([text]) => text === "very high has whitespace in it, which no codex effort has; the effort is unchanged"));
	assert.equal(host.last(), "fusion settings applied to this session; disabled: security; save them with /fusion profile save <name>");
	assert.match(host.tools.get("fusion")!.description, /implement runs on codex with model gpt-5-codex at effort none/);
});

test("the editor takes a codex role back to the host's defaults, and the table and description say so", async () => {
	const roles = builtinSettings(captureBaseline({} as NodeJS.ProcessEnv));
	roles.ask = { enabled: true, backend: "codex", model: "gpt-5-codex", effort: "high" };
	const host = sdkHost({
		profiles: memoryProfileStore(serializeDocument({ version: 1, defaultProfile: "codex", profiles: { codex: roles } })),
		dialogs: [
			(options) => options.find((option) => option.startsWith("ask ")),
			"model: gpt-5-codex",
			"Host default",
			"effort: high",
			"host default",
			(options) => {
				assert.deepEqual(options.slice(2, 4), ["model: host default", "effort: host default"], "neither field holds the label as a value");
				return "Back";
			},
			"Apply",
		],
	});
	await host.start();
	await host.command("config");
	assert.equal(host.last(), "fusion settings applied to this session; disabled: security; save them with /fusion profile save <name>");
	assert.match(host.tools.get("fusion")!.description, /ask runs on codex with the host's default codex model;/);
});

test("an empty answer changes nothing, and a backend changed and changed back starts from that backend's own defaults", async () => {
	const host = sdkHost({
		dialogs: [
			(options) => options.find((option) => option.startsWith("ask ")),
			"model: opus",
			"Type a Claude alias or id…",
			"",
			"Back",
			"Apply",
			"Cancel",
		],
	});
	await host.start();
	await host.command("config");
	// An empty input leaves the model as it was, so this draft is the built-in one and applying it changes nothing.
	assert.equal(host.notices.at(-1)?.[0], "fusion config: nothing changed");
	const blanked = sdkHost({ dialogs: [(options) => options.find((option) => option.startsWith("plan ")), "backend: claude", "pi", "Back", (options) => options.find((option) => option.startsWith("plan ")), "backend: pi", "claude", "Back", "Apply"] });
	await blanked.start();
	await blanked.command("config");
	assert.equal(blanked.last(), "fusion config: nothing changed", "a backend changed and changed back starts from that backend's own defaults again");
});

test("a re-registration keeps the host's active tools exactly as they were, under an allow list, while off, and between changes", async () => {
	const store = memoryProfileStore(document({ work: WORK, other: settings({ ask: { enabled: false, backend: "claude" } }) }));
	// The host allows `write` as well, and the user has it off: a refresh must not turn it back on.
	const allowed = ["read", "bash", "write", "fusion", "fusion_control", "claude", "claude_control", "fusion_activate", "fusion_deactivate"];
	const host = sdkHost({ profiles: store, allowed, ui: false });
	await host.start();
	assert.deepEqual(host.active, ["read", "bash", "fusion_activate"], "fusion starts off");
	await host.command("profile use other");
	assert.deepEqual(host.active, ["read", "bash", "fusion_activate"], "a profile applied while off brings back nothing the allow list names");
	await host.command("on");
	const on = ["read", "bash", "fusion", "claude", "fusion_control", "claude_control", "fusion_deactivate"];
	assert.deepEqual(host.active, on);
	const before = host.registrations.length;
	await host.command("profile use work");
	assert.ok(host.registrations.length > before, "applying a profile re-registered the guidance");
	assert.deepEqual(host.active, on, "write stays off, and activation stays hidden while on");

	// The list is read fresh for each re-registration, so a change made between two applications is kept.
	host.active.splice(host.active.indexOf("bash"), 1);
	await host.command("profile use other");
	assert.deepEqual(host.active, ["read", "fusion", "claude", "fusion_control", "claude_control", "fusion_deactivate"]);

	// While off, a profile change re-registers the tools and leaves them hidden; on gives back what off hid.
	await host.command("off");
	assert.deepEqual(host.active, ["read", "fusion_activate"]);
	await host.command("profile use work");
	assert.equal(host.last(), "fusion uses profile work in this session; disabled: ultracode, security");
	assert.deepEqual(host.active, ["read", "fusion_activate"], "nothing the allow list names came back while fusion is off");
	assert.match(host.tools.get("fusion")!.description, /implement runs on claude with model sonnet/, "and the hidden tools carry the new guidance");
	await host.command("on");
	assert.deepEqual(host.active, ["read", "fusion", "claude", "fusion_control", "claude_control", "fusion_deactivate"]);
	// A profile whose guidance is the same as the current one re-registers nothing.
	const settled = host.registrations.length;
	await host.command("profile use work");
	assert.equal(host.registrations.length, settled);
});

test("a guidance refresh that throws puts the previous configuration and its guidance back", async () => {
	const store = memoryProfileStore(document({ work: WORK }));
	const host = sdkHost({ profiles: store, ui: false });
	await host.start();
	const tools = host.tools;
	const original = tools.get("fusion")!.description;
	// The next registration of the claude tool throws, as a stale extension runtime's would.
	let armed = true;
	const set = tools.set.bind(tools);
	tools.set = ((name: string, tool: Tool) => {
		if (armed && name === "claude") {
			armed = false;
			throw new Error("extension runtime is stale");
		}
		return set(name, tool);
	}) as typeof tools.set;
	await host.command("profile use work");
	assert.equal(host.last(), "fusion settings stay as they are: the host's tool guidance did not change: extension runtime is stale");
	assert.equal(tools.get("fusion")!.description, original, "the fusion tool, re-registered first, was put back");
	await host.command("profile list");
	assert.match(host.last() ?? "", /^builtin \(current/);
});

test("a failed guidance refresh rolls back settings, both tool definitions and the complete active list", async () => {
	const allowed = ["read", "bash", "write", "fusion", "claude", "fusion_control", "claude_control", "fusion_activate", "fusion_deactivate"];
	for (const enabled of [false, true]) {
		for (const tool of ["fusion", "claude"]) {
			for (const failDuringRegistration of [false, true]) {
				const host = sdkHost({ profiles: memoryProfileStore(document({ work: WORK })), allowed, ui: false });
				await host.start();
				if (enabled) await host.on();
				const originalTools = ["fusion", "claude"].map((name) => {
					const definition = host.tools.get(name)!;
					return [definition.description, definition.promptGuidelines, definition.parameters];
				});
				const active = [...host.active];
				const set = host.tools.set.bind(host.tools);
				let armed = true;
				host.tools.set = ((name: string, definition: Tool) => {
					const result = set(name, definition);
					if (armed && name === tool) {
						armed = false;
						if (failDuringRegistration) throw new Error("extension refresh failed after replacing its definition");
						host.failNextToolChange();
					}
					return result;
				}) as typeof host.tools.set;
				await host.command("profile use work");
				const error = failDuringRegistration ? "extension refresh failed after replacing its definition" : "the host refused the tool list";
				assert.equal(host.last(), `fusion settings stay as they are: the host's tool guidance did not change: ${error}`);
				assert.deepEqual(host.active, active, `${tool}: a partial restoration loses no active tool and enables no hidden tool`);
				assert.deepEqual(["fusion", "claude"].map((name) => {
					const definition = host.tools.get(name)!;
					return [definition.description, definition.promptGuidelines, definition.parameters];
				}), originalTools);
				await host.command("config");
				assert.match(host.last() ?? "", /^fusion configuration: builtin ·/);
				await host.command("profile use work");
				assert.equal(host.last(), "fusion uses profile work in this session; disabled: ultracode, security", "a one-shot failure does not prevent a later retry");
				assert.deepEqual(host.active, active);
			}
		}
	}
});

test("the profile chooser lists every profile with its marks and loads the one picked, and closing it changes nothing", async () => {
	const store = memoryProfileStore(document({ work: WORK }, "work"));
	const host = sdkHost({
		profiles: store,
		dialogs: [
			(options) => {
				assert.deepEqual(options, ["builtin", "work (current; default for new sessions)"]);
				return "builtin";
			},
			undefined,
		],
	});
	await host.start();
	await host.command("profile");
	assert.equal(host.titles.at(-1), "fusion profile: load one into this session");
	assert.equal(host.last(), "fusion uses profile builtin in this session; disabled: security");
	await host.command("profile");
	assert.equal(host.last(), "fusion profile: nothing changed");
	assert.match(host.tools.get("fusion")!.description, /ultracode runs on claude with model fable/);
});

/** The tools a session has while fusion is on, under the default host's own active list. */
const ON_TOOLS = ["read", "bash", "fusion", "claude", "fusion_control", "claude_control", "fusion_deactivate"];

test("fusion starts off: only the activation tool is offered, a direct call starts and records nothing, and status says so", async () => {
	const claude = fakeBackend({ name: "claude" });
	const host = sdkHost({ backends: { claude: claude.backend }, ui: false });
	await host.start();
	assert.deepEqual(host.active, ["read", "bash", "fusion_activate"]);
	// A call made from guidance the host had before the mask still lands here, and is refused before anything.
	for (const tool of ["fusion", "claude"]) {
		assert.equal((await host.call(tool, { role: "implement", task: "x" })).error, "fusion is off; turn it on with /fusion on, or ask for Fusion by name");
	}
	assert.equal(claude.starts.length, 0);
	assert.deepEqual(host.branch, []);
	await host.command("status");
	assert.match(host.last() ?? "", /^fusion: off\nprofile: builtin\nhistory: [^\n]*\n\n[\s\S]*?\n\nno runs in this Pi session yet/);
	// Neither config nor a profile command, nor a second session_start, turns it on.
	await host.command("profile list");
	await host.start();
	assert.deepEqual(host.active, ["read", "bash", "fusion_activate"]);
	await host.command("on");
	await host.start();
	assert.deepEqual(host.active, ON_TOOLS, "a late session_start never undoes an activation");
	await host.shutdown();
});

test("the mode tools and the commands make the same change, each idempotent, keeping every unrelated tool as it is", async () => {
	const host = sdkHost({ ui: false });
	await host.start();
	const activated = await host.call("fusion_activate", {});
	assert.match(activated.text ?? "", /^Fusion is on\./);
	assert.deepEqual(activated.details, { enabled: true, changed: true });
	assert.deepEqual(host.active, ON_TOOLS);
	assert.deepEqual((await host.call("fusion_activate", {})).details, { enabled: true, changed: false }, "a stale second activation changes nothing");
	assert.deepEqual(host.active, ON_TOOLS);

	// A tool the user turned on and one they turned off while on both survive the round trip.
	host.active.push("grep");
	host.active.splice(host.active.indexOf("claude_control"), 1);
	const deactivated = await host.call("fusion_deactivate", {});
	assert.match(deactivated.text ?? "", /^Fusion is off\. From your next step you work directly/);
	assert.deepEqual(deactivated.details, { enabled: false, changed: true });
	assert.deepEqual(host.active, ["read", "bash", "grep", "fusion_activate"]);
	assert.deepEqual((await host.call("fusion_deactivate", {})).details, { enabled: false, changed: false });
	await host.command("on");
	assert.deepEqual(host.active, ["read", "bash", "grep", "fusion", "claude", "fusion_control", "fusion_deactivate"]);
	await host.command("off");
	assert.deepEqual(host.active, ["read", "bash", "grep", "fusion_activate"]);
	await host.call("fusion_activate", {});
	assert.deepEqual(host.active, ["read", "bash", "grep", "fusion", "claude", "fusion_control", "fusion_deactivate"], "the tool gives back what the command took");
});

test("tool activation reminds once at the next host settlement, without turning Fusion off", async () => {
	const host = sdkHost();
	await host.start();
	await host.settled();
	assert.deepEqual(host.notices, [], "starting off has no reminder");
	await host.call("fusion_activate", {});
	assert.deepEqual(host.notices, [], "activation waits for the host to settle");
	await host.settled();
	assert.deepEqual(host.notices, [["Fusion remains on. Use /fusion off or ask to turn it off when you're done.", "info"]]);
	assert.deepEqual(host.active, ON_TOOLS, "the reminder keeps Fusion available");
	await host.call("fusion_activate", {});
	await host.settled();
	assert.equal(host.notices.length, 1, "a stale activation does not rearm the reminder");
	await host.call("fusion_deactivate", {});
	await host.call("fusion_activate", {});
	await host.settled();
	assert.equal(host.notices.length, 2, "a new activation gets its own reminder");
	await host.shutdown();
});

test("manual activation and successful deactivation clear a pending activation reminder", async () => {
	const host = sdkHost();
	await host.start();
	await host.command("on");
	host.notices.length = 0;
	await host.settled();
	assert.deepEqual(host.notices, [], "manual activation needs no reminder");
	await host.command("off");
	await host.call("fusion_activate", {});
	await host.command("on");
	host.notices.length = 0;
	await host.settled();
	assert.deepEqual(host.notices, [], "manual on suppresses a pending reminder even when already on");
	assert.deepEqual(host.active, ON_TOOLS);
	for (const off of [() => host.command("off"), () => host.call("fusion_deactivate", {})]) {
		await host.command("off");
		await host.call("fusion_activate", {});
		await off();
		host.notices.length = 0;
		await host.settled();
		assert.deepEqual(host.notices, [], "turning off clears the pending reminder");
		await host.command("on");
		host.notices.length = 0;
		await host.settled();
		assert.deepEqual(host.notices, [], "an old reminder stays cleared after manual reactivation");
	}
	await host.shutdown();
});

test("deactivation is refused while a run is running, waiting or finishing, by the tool and the command alike, and cancels nothing", async () => {
	const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }, { questions: ["Which name?"] }, {}] });
	const host = sdkHost({ backends: { claude: claude.backend }, ui: false });
	await host.start();
	await host.on();
	const run = await heldRun(host, claude);
	const refused = await host.call("fusion_deactivate", {});
	assert.equal(refused.error, "fusion stays on while runs are unfinished: run-1 (implement). Wait for each run or cancel it with fusion_control, then ask again.");
	await host.command("off");
	assert.equal(host.last(), "fusion stays on while runs are unfinished: run-1 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry /fusion off.");
	assert.deepEqual(host.active, ON_TOOLS, "the host keeps its way to the run, and its way out");
	run.release();
	assert.equal((await run.call).error, undefined, "a refused deactivation cancels nothing: the run ends as it would have");

	const asked = await host.fusion({ role: "ask", task: "a question" });
	assert.equal(asked.details.state, "waiting");
	assert.match((await host.call("fusion_deactivate", {})).error ?? "", /^fusion stays on while runs are unfinished: run-2 \(ask\)\./);
	await host.call("fusion_control", { action: "message", run: "run-2", message: "call it foo" });
	await host.call("fusion_control", { action: "wait", run: "run-2" });
	assert.deepEqual((await host.call("fusion_deactivate", {})).details, { enabled: false, changed: true });
	await host.shutdown();
});

test("an empty saved subset stays empty, and a host that excludes a mode tool keeps it out while the command still switches", async () => {
	// The user had none of the workflow tools active when fusion started: on gives back none of them.
	const bare = sdkHost({ initial: ["read"], ui: false });
	for (const name of ["fusion", "claude", "fusion_control", "claude_control"]) bare.active.splice(0, bare.active.length, ...bare.active.filter((tool) => tool !== name));
	await bare.start();
	assert.deepEqual(bare.active, ["read", "fusion_activate"]);
	await bare.command("on");
	assert.deepEqual(bare.active, ["read", "fusion_deactivate"], "an empty subset is not a request for all four");

	// An allow list that names the workflow tools but no mode tool: nothing forces a mode tool in.
	const allowed = ["read", "bash", "fusion", "fusion_control", "claude", "claude_control"];
	const strict = sdkHost({ allowed, ui: false });
	await strict.start();
	assert.deepEqual(strict.active, ["read", "bash"]);
	await strict.command("on");
	assert.deepEqual(strict.active, ["read", "bash", "fusion", "claude", "fusion_control", "claude_control"]);
	await strict.command("profile use builtin");
	assert.deepEqual(strict.active, ["read", "bash", "fusion", "claude", "fusion_control", "claude_control"], "a re-registration under the allow list brings no mode tool back");
	await strict.command("off");
	assert.deepEqual(strict.active, ["read", "bash"]);
});

test("a host that fails mid-update leaves the mode and the saved subset as they were, and an aborted call changes nothing", async () => {
	const host = sdkHost({ ui: false });
	await host.start();
	host.failNextToolChange();
	await host.command("on");
	assert.equal(host.last(), "fusion stays off: the host's tool list did not change: the host refused the tool list");
	assert.deepEqual(host.active, ["read", "bash", "fusion_activate"], "the partial change was put back");
	await host.command("status");
	assert.match(host.last() ?? "", /^fusion: off/);
	const aborted = AbortSignal.abort();
	assert.equal((await host.call("fusion_activate", {}, aborted)).error, "fusion stays off: the call was cancelled");
	assert.deepEqual(host.active, ["read", "bash", "fusion_activate"]);
	await host.command("on");
	assert.deepEqual(host.active, ON_TOOLS, "the subset saved at startup is still the one on gives back");
	host.failNextToolChange();
	assert.equal((await host.call("fusion_deactivate", {})).error, "fusion stays on: the host's tool list did not change: the host refused the tool list");
	assert.deepEqual(host.active, ON_TOOLS);
	assert.equal((await host.call("fusion_deactivate", {}, aborted)).error, "fusion stays on: the call was cancelled");
	assert.deepEqual(host.active, ON_TOOLS);
});

test("a host that never emits session_start is masked by its first command or call", async () => {
	const claude = fakeBackend({ name: "claude" });
	const commanded = sdkHost({ backends: { claude: claude.backend }, ui: false });
	assert.ok(commanded.active.includes("fusion"), "before anything binds, the SDK's own activation stands");
	await commanded.command("status");
	assert.deepEqual(commanded.active, ["read", "bash", "fusion_activate"]);
	const called = sdkHost({ backends: { claude: claude.backend }, ui: false });
	assert.match((await called.fusion({ role: "implement", task: "x" })).error ?? "", /^fusion is off/);
	assert.deepEqual(called.active, ["read", "bash", "fusion_activate"]);
	assert.equal(claude.starts.length, 0);
});

test("the mode tools carry only their own guidance, and the workflow guidance says it applies while fusion is on", () => {
	const host = sdkHost({ ui: false });
	const activate = host.tools.get("fusion_activate")!;
	const deactivate = host.tools.get("fusion_deactivate")!;
	for (const tool of [activate, deactivate]) {
		assert.equal(tool.executionMode, "sequential");
		const text = [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
		assert.match(text, /explicitly asks/);
		assert.doesNotMatch(text, /do not edit files|delegate implementation|role plan|Route section/, "no orchestration mandate rides on a mode tool");
	}
	assert.match(activate.promptGuidelines!.join("\n"), /names a role, a model or a harness without asking for Fusion, such as a plan, a security audit, ultracode, Claude or Pi, does not qualify/);
	assert.match(activate.promptGuidelines!.join("\n"), /Fusion having been used earlier in this conversation/);
	assert.match(deactivate.promptGuidelines!.join("\n"), /never because a task ended/);
	for (const name of ["fusion", "claude"]) {
		assert.match(host.tools.get(name)!.promptGuidelines![0]!, new RegExp(`^These ${name} guidelines apply while Fusion is on`));
	}
});
