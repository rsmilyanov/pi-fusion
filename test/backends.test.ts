import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { claudeBackend, type Role } from "../extensions/backends/claude.ts";
import { createCodexBackend } from "../extensions/backends/codex.ts";
import { CODEX_FOREIGN_SESSION, CODEX_NO_CHECKPOINT } from "../extensions/backends/codex-outcome.ts";
import { hostBackend, isPiModel, keptRef, keptSelection, piModelParts, resolvedSelectionOf, sessionRefOf } from "../extensions/backends/types.ts";
import { ASK_MODES, type AskMode, type ChildRun as ExportedChildRun, codexResumeCommand, failed, ROLE_NAMES } from "../extensions/fusion.ts";
import { ChildTree } from "../extensions/process-tree.ts";
import { canChangeFiles, isReviewable, KNOWN_ROLE_NAMES, ROLE_SPECS, runsOn } from "../extensions/roles.ts";
import { CODEX_VARIABLES, PRODUCTION_DEFAULT_VARIABLES, productionDefaults, tripwires } from "./tripwire.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fakeClaude = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.PI_FUSION_CLAUDE_BIN = fakeClaude;

const implementRole: Role = {
	name: "implement",
	model: "opus",
	effort: "high",
	tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
	permissionMode: "bypassPermissions",
	contract: "implement.md",
};

/**
 * Every module a file names, whatever form the reference takes: a static import, a bare import, a re-export, or a
 * dynamic import or require with a literal path. TypeScript's own scanner reads it, so a module named in a comment
 * or in a string is not mistaken for a dependency, which a regular expression over the source would be.
 */
const modulesNamedIn = (source: string): string[] => ts.preProcessFile(source, true, true).importedFiles.map((reference) => reference.fileName);

const dependenciesOf = (name: string): string[] => modulesNamedIn(fs.readFileSync(path.join(repoRoot, "extensions", name), "utf8"));

/**
 * Every host-side production module of every extension this repository ships: the TypeScript ones, with declarations
 * left out, because a `.d.mts` naming a module is a type reference rather than something a process imports. The plain
 * ESM beside them is the child's own program and the modules it is composed of, which run in a child and not here.
 */
const productionModules = (dir = path.join(repoRoot, "extensions")): string[] =>
	fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(m|c)?ts$/.test(entry.name) && !/\.d\.(m|c)?ts$/.test(entry.name))
		.map((entry) => path.join(entry.parentPath, entry.name));

/** Fails to compile once the adapter's mode and the host's list of ask modes are no longer the same two values. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const MODE_STAYS_ASK_MODE: Exactly<NonNullable<Role["mode"]>, AskMode> = true;

/**
 * Fails to compile once the host's exported `ChildRun` stops being the Claude run: its consumers read the Claude
 * role's own fields, and a run typed over the host's narrower view of a role would drop effort, tools and permission
 * mode from every one of them. The shared lifecycle has its own generic run type, which is not this export.
 */
const CHILD_RUN_STAYS_CLAUDE: Exactly<ExportedChildRun["role"], Role> = true;

test("the host and the shared boundary depend on no backend SDK", () => {
	for (const name of ["fusion.ts", "backends/types.ts", "process-tree.ts", "roles.ts"]) {
		assert.ok(!dependenciesOf(name).includes("@anthropic-ai/claude-agent-sdk"), `${name} must reach a child through the backend boundary, not through the SDK`);
	}
});

test("the shared boundary depends on nothing, and the process-tree helper only on node itself", () => {
	assert.deepEqual(dependenciesOf("backends/types.ts"), [], "the boundary types must stand on their own");
	for (const name of dependenciesOf("process-tree.ts")) {
		assert.match(name, /^node:/, "the process-tree helper must not depend on a backend or on the host extension");
	}
});

test("the role capabilities depend on the boundary and on nothing else", () => {
	for (const name of dependenciesOf("roles.ts")) {
		assert.equal(name, "./backends/types.ts", "role capabilities must name no host, no backend and no adapter");
	}
});

test("the pi binding is a binding, not an adapter: it depends on the boundary alone and names no SDK", () => {
	const names = dependenciesOf("backends/pi-binding.ts");
	assert.deepEqual(names, ["./types.ts"], `a role binding must name no host, no process and no SDK; it names ${names.join(", ")}`);
});

test("the codex binding is a binding, not an adapter: it depends on the boundary alone and names no SDK", () => {
	const names = dependenciesOf("backends/codex-binding.ts");
	assert.deepEqual(names, ["./types.ts"], `a role binding must name no host, no process, no protocol and no SDK; it names ${names.join(", ")}`);
});

test("nothing outside the host, the profiles and the codex backend's own modules reaches into the codex binding", () => {
	// The binding is read by routing and by the settings' display label, and by the codex backend's composition and
	// outcome mapping for its role shape. The registration of that backend is the host's own, pinned below.
	const importers = productionModules()
		.filter((file) => modulesNamedIn(fs.readFileSync(file, "utf8")).some((name) => /(^|\/)codex-binding\.ts$/.test(name)))
		.map((file) => path.relative(path.join(repoRoot, "extensions"), file))
		.sort();
	assert.deepEqual(importers, ["backends/codex-outcome.ts", "backends/codex.ts", "fusion.ts", "profiles.ts"]);
});

/** The one declaration of `backends` in the host's source, parsed: the registry every routed call looks its backend up in. */
function hostRegistry(): { declaration: ts.VariableDeclaration; file: ts.SourceFile } {
	const file = ts.createSourceFile("fusion.ts", fs.readFileSync(path.join(repoRoot, "extensions", "fusion.ts"), "utf8"), ts.ScriptTarget.Latest, true);
	const found: ts.VariableDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		// Typed as the registry, which tells it from the role-capability list the settings editor keeps under the same name.
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "backends" && node.type?.getText(file).includes("HostBackend")) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	assert.equal(found.length, 1, "the host declares one backend registry, so one is all this has to read");
	return { declaration: found[0]!, file };
}

test("the host registers claude, pi and codex by default, with the host's own registrations spread over them as they are", () => {
	// Pinned out of the source before anything runs: the defaults first, each a factory call, and the host's own keys
	// spread last with nothing between them and the lookup. A spread copies own keys only and copies an undefined one as
	// undefined, so a key a host set to undefined is a backend left out, never this build's default in its place; a
	// nullish fallback here would turn every `codex: undefined` of a test into a production codex app-server.
	const { declaration, file } = hostRegistry();
	assert.equal(
		declaration.getText(file),
		"backends: Partial<Record<BackendName, HostBackend>> = { claude: hostBackend(claudeBackend), pi: hostBackend(createPiBackend()), codex: hostBackend(createCodexBackend()), ...options.backends }",
	);
	assert.ok(ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0, "the registry is a const: nothing reassigns it after the load");
	const initializer = declaration.initializer!;
	assert.ok(ts.isObjectLiteralExpression(initializer));
	const last = initializer.properties.at(-1)!;
	assert.ok(ts.isSpreadAssignment(last) && last.expression.getText(file) === "options.backends", "the host's own registrations come last and unwrapped");
	// Every read of the registry is an index by a routed backend name or the list of what is registered, and none of
	// them falls back to anything when the entry is undefined.
	const source = file.getFullText();
	const reads = [...source.matchAll(/\bbackends\[([^\]]+)\]/g)].map((match) => match[1]);
	// The `0` is the settings editor's own local list of the backends a role runs on, not the registry.
	assert.deepEqual(reads, ["route.backend", "0", "route.backend"], "a registry lookup is by the routed backend alone");
	assert.equal([...source.matchAll(/backends\[route\.backend\]\s*(\?\?|\|\|)/g)].length, 0, "and no lookup falls back to a default");
	// The same expression shape, evaluated over values that are not backends: the overlay semantics the audit relies on.
	const marker = (name: string) => ({ name }) as never;
	const own = { codex: undefined } as Partial<Record<string, unknown>>;
	const overlaid: Record<string, unknown> = { claude: marker("claude"), pi: marker("pi"), codex: marker("codex"), ...own };
	assert.ok(Object.hasOwn(overlaid, "codex") && overlaid.codex === undefined, "an explicit undefined removes the default");
	const inherited: Record<string, unknown> = { claude: marker("claude"), pi: marker("pi"), codex: marker("codex"), ...(Object.create({ codex: undefined, pi: marker("inherited") }) as object) };
	assert.deepEqual([(overlaid.claude as { name: string }).name, (inherited.pi as { name: string }).name, (inherited.codex as { name: string }).name], ["claude", "pi", "codex"], "an inherited key is never admitted over a default");
});

test("this build's default codex backend is lazy: constructing it reads, locates and starts nothing, even with no codex anywhere", () => {
	// The production factory with no seams, exactly as the host calls it at load, under an environment that names no
	// codex binary that exists and a PATH that holds none. Only its pure members are read; `run`, its one entry point,
	// is never called, so nothing here could reach an app-server, a home or a login.
	const kept = { PATH: process.env.PATH, PI_FUSION_CODEX_BIN: process.env.PI_FUSION_CODEX_BIN };
	process.env.PATH = "";
	process.env.PI_FUSION_CODEX_BIN = "/nowhere/codex";
	try {
		const backend = hostBackend(createCodexBackend());
		assert.equal(backend.name, "codex");
		assert.equal(backend.control().open, true, "a codex run's input is open from its admission, holding steers until its turn is named");
		assert.deepEqual(backend.session({ kind: "new" }), { kind: "new" });
		const baseline = { inputTokens: 30, cachedInputTokens: 20, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 34 };
		assert.deepEqual(backend.session({ kind: "resume", ref: { backend: "codex", sessionId: "thr-1", checkpoint: "turn-1", baseline } }), { kind: "resume", id: "thr-1", at: "turn-1", baseline });
		assert.deepEqual(backend.session({ kind: "fork", from: { backend: "codex", sessionId: "thr-1", checkpoint: "turn-1", baseline } }), { kind: "fork", from: "thr-1", at: "turn-1", baseline });
		assert.throws(() => backend.session({ kind: "resume", ref: { backend: "codex", sessionId: "thr-1", checkpoint: "turn-1" } }), { message: CODEX_NO_CHECKPOINT });
		assert.throws(() => backend.session({ kind: "fork", from: { backend: "claude", sessionId: "thr-1", checkpoint: "turn-1" } }), { message: CODEX_FOREIGN_SESSION });
	} finally {
		for (const [name, value] of Object.entries(kept)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	// And with every seam a recording one: constructing and mapping touch none of them.
	const reached: string[] = [];
	const seam = (name: string) => () => {
		reached.push(name);
		throw new Error(`${name} reached`);
	};
	const fenced = createCodexBackend({ readContract: seam("contract"), launch: seam("launch"), start: seam("start"), clientInfo: seam("clientInfo"), now: seam("now") });
	fenced.control();
	fenced.session({ kind: "new" });
	assert.deepEqual(reached, []);
});

test("the codex transport is a transport over its own protocol readers: it takes only the line framer from pi, and only the codex backend reaches it", () => {
	assert.deepEqual(dependenciesOf("backends/codex-protocol.ts"), ["node:path"], "the protocol readers are pure: no process, no stream and no package");
	assert.deepEqual(dependenciesOf("backends/codex-transport.ts").sort(), ["../process-tree.ts", "./codex-protocol.ts", "./pi-transport.ts", "node:stream"]);
	// What it takes from pi is the generic byte-capped framer and the timer ceiling, and no pi lifecycle, protocol or
	// diagnostic: those are pi's own and the codex lifecycle has its own. The pi transport's own imports are a node
	// builtin, the process tree and the import-free bootstrap constants, so no SDK or runtime is reached through it.
	const file = path.join(repoRoot, "extensions", "backends", "codex-transport.ts");
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
	const fromPi = source.statements
		.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "./pi-transport.ts")
		.flatMap((statement) => {
			const bindings = statement.importClause?.namedBindings;
			return bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => element.name.text) : ["<not named>"];
		})
		.sort();
	assert.deepEqual(fromPi, ["LineFramer", "MAX_TIMER_MS", "PiLine"]);
	assert.deepEqual(dependenciesOf("backends/pi-transport.ts").sort(), ["../process-tree.ts", "./pi-bootstrap-protocol.mjs", "node:stream", "node:string_decoder"]);
	assert.deepEqual(dependenciesOf("backends/pi-bootstrap-protocol.mjs"), []);
	const importers = productionModules()
		.filter((candidate) => modulesNamedIn(fs.readFileSync(candidate, "utf8")).some((name) => /(^|\/)codex-(transport|protocol)\.ts$/.test(name)))
		.map((candidate) => path.relative(path.join(repoRoot, "extensions"), candidate))
		.sort();
	assert.deepEqual(importers, ["backends/codex-outcome.ts", "backends/codex-transport.ts", "backends/codex.ts"], "only the codex backend's own composition and outcome mapping reach the codex transport and protocol");
});

test("the codex backend composes its own modules, and the host reaches it only through its factory: no other backend or package does", () => {
	assert.deepEqual(dependenciesOf("backends/codex.ts").sort(), ["../process-tree.ts", "./codex-binding.ts", "./codex-launch.ts", "./codex-outcome.ts", "./codex-protocol.ts", "./codex-transport.ts", "./types.ts", "node:fs", "node:path", "node:url"]);
	// The mapping is pure: the boundary, the binding's role shape and the protocol and transport types, no process or file.
	assert.deepEqual(dependenciesOf("backends/codex-outcome.ts").sort(), ["./codex-binding.ts", "./codex-protocol.ts", "./codex-transport.ts", "./types.ts"]);
	const importers = productionModules()
		.filter((candidate) => modulesNamedIn(fs.readFileSync(candidate, "utf8")).some((name) => /(^|\/)codex(-outcome)?\.ts$/.test(name)))
		.map((candidate) => path.relative(path.join(repoRoot, "extensions"), candidate))
		.sort();
	assert.deepEqual(importers, ["backends/codex.ts", "fusion.ts"], "the host registers the codex backend, and nothing else reaches it");
	// What the host takes from it is the factory and nothing else: no transport, outcome mapping or contract path.
	const file = path.join(repoRoot, "extensions", "fusion.ts");
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
	const fromCodex = source.statements
		.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "./backends/codex.ts")
		.flatMap((statement) => {
			const bindings = statement.importClause?.namedBindings;
			return bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => element.name.text) : ["<not named>"];
		});
	assert.deepEqual(fromCodex, ["createCodexBackend"]);
});

test("the pi outcome mapping is pure: node's own path helper, this backend's own modules, and nothing else", () => {
	const names = dependenciesOf("backends/pi-outcome.ts");
	// `node:path` is there for one thing, deciding whether a recorded session file is absolute; everything else it
	// names is a value-shape it maps from. A host, another backend, a card and a package are all outside that.
	const allowed = ["node:path", "./types.ts", "./pi-binding.ts", "./pi-prepare.ts", "./pi-task.ts", "./pi-transport.ts", "./pi-session-restore.ts", "./pi-question-routing.ts", "../process-tree.ts"];
	for (const name of names) {
		assert.ok(allowed.includes(name), `the outcome mapping must name no host, no adapter and no package; it names ${name}`);
	}
	for (const forbidden of ["./claude.ts", "../fusion.ts", "../cards.ts"]) {
		assert.ok(!names.includes(forbidden), `the outcome mapping must not depend on ${forbidden}`);
	}
});

test("the pi storage layout depends on node itself, so a path is composed before any package is loaded", () => {
	const names = dependenciesOf("backends/pi-storage.ts");
	assert.ok(names.length > 0, "the storage layout does its own file work, so it names node's own modules");
	for (const name of names) assert.match(name, /^node:/, `the storage layout must name no host, no backend and no SDK; it names ${names.join(", ")}`);
});

test("the program a Pi child runs is the child's alone, and the host reads the two protocol constants from a module that imports nothing", () => {
	// The host extension reaches the transport through the pi backend, so whatever the transport names is loaded in this
	// host's own process. What reading the two constants off the bootstrap cost was the dependency itself: the host
	// evaluated the child's entry module, so an install missing that program was a module error at import time instead
	// of the fixed existence refusal the loader composes for it by name. It is not a claim about the modules behind
	// that entry — the host imports `pi-control-extension.mjs` and `pi-question-tool.mjs` through the restore and the
	// launch anyway — nor about the public SDK, which the child's own program loads when it runs.
	assert.deepEqual(dependenciesOf("backends/pi-bootstrap-protocol.mjs"), [], "the shared protocol constants must stand on their own, so a host pays nothing to read them");
	const transport = dependenciesOf("backends/pi-transport.ts");
	assert.ok(transport.includes("./pi-bootstrap-protocol.mjs"), `the transport must read the diagnostic marker and the startup exit code from the protocol module; it names ${transport.join(", ")}`);
	assert.ok(!transport.includes("./pi-bootstrap.mjs"), "the transport must not import the program a child runs");
	// And no other host module either, through any form a reference takes. `extensions/backends/pi-launch.ts` still
	// names that file, as the path it composes for a launch rather than a module it imports, which is exactly the
	// difference the compiler's own scanner reads and a pattern over the text would not.
	for (const file of productionModules()) {
		const named = modulesNamedIn(fs.readFileSync(file, "utf8"));
		assert.ok(
			!named.some((name) => name.endsWith("pi-bootstrap.mjs")),
			`${relative(file)} imports the program a Pi child runs, which belongs in the child; the host reads what it shares with it from ./pi-bootstrap-protocol.mjs`,
		);
	}
	const launch = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "pi-launch.ts"), "utf8");
	assert.ok(launch.includes('"pi-bootstrap.mjs"'), "the launch module no longer names the child's program as a path, so the audit above is reading files that never mention it");
	assert.deepEqual(modulesNamedIn(launch).filter((name) => name.endsWith("pi-bootstrap.mjs")), [], "and it names it as that path alone");
});

test("the preload that resolves the host's own Pi is the child's alone, and the launch names it as a path", () => {
	// Importing the preload registers its resolve hook in whatever process imported it, which in this host would
	// redirect the host's own imports: the launch composes its path and restates its one variable instead.
	for (const file of productionModules()) {
		const named = modulesNamedIn(fs.readFileSync(file, "utf8"));
		assert.ok(!named.some((name) => name.endsWith("pi-sdk-resolve.mjs")), `${relative(file)} imports the preload a Pi child is started with`);
	}
	assert.deepEqual(dependenciesOf("backends/pi-sdk-resolve.mjs"), ["node:module", "node:path", "node:url"], "the preload stands on node itself, because it runs before anything else in the child");
	const launch = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "pi-launch.ts"), "utf8");
	assert.ok(launch.includes('"pi-sdk-resolve.mjs"'), "the launch module no longer names the preload as a path");
});

/**
 * Every test file the audit below reads, walked rather than listed: a registration written in a file one directory
 * down would be outside `test/*.test.ts`, which is where the runner looks, and still a registration. `test/spikes`
 * is left out by name, because those are manual harnesses that run no case of this suite, and anything that is not
 * a `.test.ts` is left out with them. The order is the walk's own, so the pins below can be written in it.
 */
function testFiles(dir = path.join(repoRoot, "test")): string[] {
	const found: string[] = [];
	for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const at = path.join(dir, item.name);
		if (item.isDirectory()) {
			if (item.name !== "spikes") found.push(...testFiles(at));
		} else if (item.name.endsWith(".test.ts")) found.push(at);
	}
	return found;
}

/** A path as the pins below name one, so a walk on Windows reads back the same as a walk here. */
const relative = (file: string): string => path.relative(repoRoot, file).split(path.sep).join("/");

/**
 * Every registration of the Fusion extension in one file, as the source text of the whole call: a call of the default
 * export of `extensions/fusion.ts`, under whatever name that file imported it as, found through the compiler's own
 * parser rather than a pattern over the text. That is what makes it robust to the forms a registration actually
 * takes — a call that spans lines or sits inside a helper comes back whole, an import is no call at all, and a
 * `host.fusion(...)` of a test's own helper is a property access rather than this.
 *
 * What it does not see, said plainly: it follows the default import and nothing else. A file that reached the
 * extension through a namespace import, a re-export, a dynamic import or a reference passed around as a value would
 * register one this finds no call for. That is why the population below is pinned as well as the markers — a
 * detector that stopped seeing the registrations that are there fails on the counts instead of passing silently.
 */
function fusionRegistrations(source: string): string[] {
	const file = ts.createSourceFile("registration.ts", source, ts.ScriptTarget.Latest, true);
	let local: string | undefined;
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const from = statement.moduleSpecifier;
		if (!ts.isStringLiteral(from) || !from.text.endsWith("extensions/fusion.ts")) continue;
		const name = statement.importClause?.name;
		if (name) local = name.text;
	}
	if (local === undefined) return [];
	const calls: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === local) calls.push(node.getText(file));
		ts.forEachChild(node, visit);
	};
	visit(file);
	return calls;
}

/**
 * Where the suite registers the extension today, and how often in each place. It is pinned, not counted, for two
 * reasons: a registration that appears somewhere new is a decision somebody should make on purpose, and a detector
 * that quietly stopped finding the calls that are there would otherwise pass this whole audit with nothing to check.
 */
const REGISTRATIONS: Record<string, number> = {
	"test/control.test.ts": 1,
	"test/extension.test.ts": 4,
	"test/lifecycle.test.ts": 1,
	"test/profiles.test.ts": 1,
	"test/routing.test.ts": 2,
	"test/session.test.ts": 1,
};
const REGISTRATIONS_TOTAL = 10;

test("every Fusion registration in the suite names the backends it takes, and the registrations are the ones pinned here", () => {
	// A registration that names neither marker would run with the pi backend this build registers, which is a real
	// harness, and with the codex backend this build registers, which is a real app-server: a case that routed to one would start a child
	// instead of failing in a way a test can read. So every registration has to say which of the two it is, and a bare
	// one that somebody adds later fails here. The marker is the combined `tripwires()`: a registration that names only
	// the pi tripwire leaves codex unfenced, and is no more acceptable than a bare one.
	const TRIPWIRE = "tripwires";
	const DEFAULTS = "productionDefaults";
	const defaults: string[] = [];
	const counted: Record<string, number> = {};
	for (const file of testFiles()) {
		const where = relative(file);
		for (const call of fusionRegistrations(fs.readFileSync(file, "utf8"))) {
			counted[where] = (counted[where] ?? 0) + 1;
			const tripwire = /\.\.\.tripwires\(\)/.test(call);
			const production = call.includes(DEFAULTS);
			assert.ok(tripwire || production, `${where} registers the extension without naming ${TRIPWIRE} or ${DEFAULTS}: ${call}`);
			assert.ok(!(tripwire && production), `${where} registers the extension naming both ${TRIPWIRE} and ${DEFAULTS}, which cannot both be what it takes: ${call}`);
			// Left out, the settings store is the user's own pi-fusion/settings.json, so a registration that names none
			// would read the user's saved history preference; productionDefaults() names one of its own, checked below.
			assert.ok(production || /\bsettings:/.test(call), `${where} registers the extension without a settings store of its own, so it would read the user's settings file: ${call}`);
			if (production) defaults.push(where);
		}
	}
	assert.deepEqual(counted, REGISTRATIONS, "the suite registers the extension somewhere new, or the detector above stopped seeing a registration that is still there");
	assert.equal(
		Object.values(counted).reduce((all, one) => all + one, 0),
		REGISTRATIONS_TOTAL,
		"the total is pinned beside the map so a count moved from one file to another still has to be looked at",
	);
	assert.deepEqual(defaults, ["test/extension.test.ts", "test/routing.test.ts"], "exactly two cases read this build's own pi registration, and every other one keeps the tripwire in its place");
});

/** The source of `test/tripwire.ts`, parsed, and the one function in it a registration audit reads by name. */
function tripwireFunction(name: string): ts.FunctionDeclaration {
	const source = fs.readFileSync(path.join(repoRoot, "test", "tripwire.ts"), "utf8");
	const file = ts.createSourceFile("tripwire.ts", source, ts.ScriptTarget.Latest, true);
	const found = file.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
	assert.ok(found?.body, `test/tripwire.ts declares no function ${name}`);
	return found;
}

test("the production-default registration keeps the codex tripwire, because no missing-model refusal would stop a codex call there", () => {
	// A codex role runs on the host's own default model when it names none, so the binding's missing-model refusal that
	// keeps the two production-default cases away from a real pi child has no codex counterpart. What keeps them away
	// from the production codex backend this build registers is the tripwire, and it is read
	// here out of the source: every value the function returns registers the codex tripwire and nothing over it.
	const returns: ts.ReturnStatement[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isReturnStatement(node)) returns.push(node);
		else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
	};
	ts.forEachChild(tripwireFunction("productionDefaults").body!, visit);
	assert.equal(returns.length, 1, "productionDefaults returns one value, so one is all this has to read");
	const returned = returns[0]!.expression;
	assert.ok(returned && ts.isObjectLiteralExpression(returned), "productionDefaults returns an object literal this can read");
	const backends = returned.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === "backends");
	assert.ok(backends && ts.isPropertyAssignment(backends) && ts.isObjectLiteralExpression(backends.initializer), "productionDefaults registers no backends of its own, so nothing fences codex");
	assert.deepEqual(
		backends.initializer.properties.map((property) => property.getText()),
		["...codexTripwire()"],
		"productionDefaults registers the codex tripwire and nothing else: no pi tripwire, which would hide the binding these cases read, and nothing over codex",
	);

	const settings = returned.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === "settings");
	assert.ok(
		settings && ts.isPropertyAssignment(settings) && settings.initializer.getText() === "memorySettingsStore()",
		"productionDefaults reads and writes settings in memory, never the user's own settings file",
	);

	// And what it returns, with every variable it refuses cleared for the call: this build's own claude and pi, which
	// it leaves alone, and the codex tripwire. No entry point of it is called, so nothing here is a reach.
	const kept = PRODUCTION_DEFAULT_VARIABLES.map((name) => [name, process.env[name]] as const);
	for (const [name] of kept) delete process.env[name];
	try {
		const registered = productionDefaults().backends ?? {};
		assert.deepEqual(Object.keys(registered), ["codex"]);
		assert.equal(registered.codex?.name, "codex");
	} finally {
		for (const [name, value] of kept) if (value !== undefined) process.env[name] = value;
	}
	// The variables it refuses include every codex one a later launch would read: both selection variables of each
	// role codex runs, and the binary override.
	assert.deepEqual(CODEX_VARIABLES, ["PI_FUSION_CODEX_PLAN_MODEL", "PI_FUSION_CODEX_PLAN_EFFORT", "PI_FUSION_CODEX_IMPLEMENT_MODEL", "PI_FUSION_CODEX_IMPLEMENT_EFFORT", "PI_FUSION_CODEX_ASK_MODEL", "PI_FUSION_CODEX_ASK_EFFORT", "PI_FUSION_CODEX_BIN"]);
	for (const name of CODEX_VARIABLES) assert.ok(PRODUCTION_DEFAULT_VARIABLES.includes(name), `${name} is not refused by a production-default registration`);
	const previous = process.env.PI_FUSION_CODEX_BIN;
	process.env.PI_FUSION_CODEX_BIN = "/nowhere/codex";
	try {
		assert.throws(() => productionDefaults(), /PI_FUSION_CODEX_BIN is still set/);
	} finally {
		if (previous === undefined) delete process.env.PI_FUSION_CODEX_BIN;
		else process.env.PI_FUSION_CODEX_BIN = previous;
	}
});

test("the combined tripwires fence pi and codex, each under its own name", () => {
	const fenced = tripwires();
	assert.deepEqual(Object.keys(fenced), ["pi", "codex"]);
	assert.deepEqual([fenced.pi.name, fenced.codex.name], ["pi", "codex"], "a backend registered under another name than its own is refused at registration");
});

test("a reach of either tripwire that a case swallowed still fails its file, and a file that reached neither passes", () => {
	// Each probe is a test file of its own, run by a node process of its own, so the reach it makes on purpose fails
	// that process's hook and not this suite's. The probes import the tripwires and call one entry point: nothing in
	// them registers the extension or starts a child of any harness.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-tripwire-"));
	const module = pathToFileURL(path.join(repoRoot, "test", "tripwire.ts")).href;
	const env = { ...process.env };
	// The runner marks the files it starts; a probe that inherited the mark would report to a parent that is not there.
	delete env.NODE_TEST_CONTEXT;
	delete env.PI_FUSION_CHILD;
	const probe = (name: string, body: string): { status: number | null; output: string } => {
		const file = path.join(dir, `${name}.test.ts`);
		fs.writeFileSync(file, `import test from "node:test";\nimport { tripwires } from ${JSON.stringify(module)};\ntest(${JSON.stringify(name)}, async () => {\n${body}\n});\n`);
		const ran = spawnSync(process.execPath, ["--test", file], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
		return { status: ran.status, output: `${ran.stdout}${ran.stderr}` };
	};
	try {
		const clean = probe("clean", "\ttripwires();");
		assert.equal(clean.status, 0, `a file that reached no tripwire failed:\n${clean.output}`);
		for (const backend of ["pi", "codex"]) {
			const reached = probe(`${backend}-reach`, `\tawait tripwires().${backend}.run({} as never).catch(() => {});`);
			assert.equal(reached.status, 1, `a swallowed ${backend} reach did not fail its file:\n${reached.output}`);
			assert.match(reached.output, new RegExp(`a case reached the ${backend} backend tripwire`), `the ${backend} probe failed for another reason:\n${reached.output}`);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * The words a POSIX shell would read from a command made of plain words, single-quoted spans and `\'`, and nothing else. It
 * reads, it never runs: anything a shell would expand, substitute, escape or redirect outside single quotes is refused,
 * so a hint that passes is one whose every argument is literal text.
 */
function literalShellWords(command: string): string[] {
	const words: string[] = [];
	let word: string | undefined;
	for (let at = 0; at < command.length; at++) {
		const char = command[at]!;
		if (char === " ") {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else if (char === "'") {
			const end = command.indexOf("'", at + 1);
			if (end === -1) throw new Error(`an unclosed quote at ${at}`);
			word = (word ?? "") + command.slice(at + 1, end);
			at = end;
		} else if (char === "\\" && command[at + 1] === "'") {
			// The one escape the hint uses: a quote between two quoted spans.
			word = (word ?? "") + "'";
			at += 1;
		} else if (/[\s$`"\\;&|<>()*?[\]{}~#!]/.test(char) || (char === "=" && word === undefined)) {
			throw new Error(`${JSON.stringify(char)} at ${at} would be read by the shell, not as text`);
		} else word = (word ?? "") + char;
	}
	if (word !== undefined) words.push(word);
	return words;
}

test("a codex resume hint names a plain thread id as it is, and any other as one literal argument that cannot be an option", () => {
	for (const plain of ["thr-1", "thread-1", "019a2b3c-4d5e-7f00-8000-0123456789ab", "a_b.c:d/e@f+g=h,i%j"]) {
		assert.equal(codexResumeCommand(plain), `codex resume ${plain}`, "an ordinary id keeps the hint it always had");
	}
	const hostile = ["$(touch /tmp/pwned)", "`id`", "it's a thread", "thread 1", "a\tb", "x;rm -rf ~", '"quoted"', "line\nbreak", "~", "*", "-rf", "--help", "-", "'", "=ls"];
	for (const id of hostile) {
		const command = codexResumeCommand(id);
		const words = literalShellWords(command);
		const expected = id.startsWith("-") ? ["codex", "resume", "--", id] : ["codex", "resume", id];
		assert.deepEqual(words, expected, `${JSON.stringify(id)} is read back as exactly one literal argument: ${command}`);
	}
	assert.equal(codexResumeCommand("$(touch /tmp/pwned)"), "codex resume '$(touch /tmp/pwned)'");
	assert.equal(codexResumeCommand("it's"), "codex resume 'it'\\''s'");
	assert.equal(codexResumeCommand("-rf"), "codex resume -- '-rf'");
	// zsh expands a word that starts with `=` into a command path, so a leading one is quoted; an interior one is plain.
	assert.equal(codexResumeCommand("=ls"), "codex resume '=ls'");
	assert.equal(codexResumeCommand("a=b"), "codex resume a=b");
	// The reader itself refuses what a shell would interpret, so the check above cannot pass by reading too little.
	for (const unsafe of ["codex resume $(id)", "codex resume `id`", 'codex resume "x"', "codex resume a;b", "codex resume 'open", "codex resume =ls"]) assert.throws(() => literalShellWords(unsafe), unsafe);
});

test("a pi model is a provider and a model id split at the first slash, so a provider's own slashes survive", () => {
	assert.deepEqual(piModelParts("deepseek/deepseek-chat"), { provider: "deepseek", model: "deepseek-chat" });
	assert.deepEqual(piModelParts("openrouter/deepseek/deepseek-chat"), { provider: "openrouter", model: "deepseek/deepseek-chat" });
	for (const value of ["deepseek-chat", "/deepseek-chat", "deepseek/", "", "  ", 7, null, undefined, {}]) {
		assert.equal(piModelParts(value), undefined, JSON.stringify(value));
	}
	assert.equal(isPiModel("openrouter/deepseek/deepseek-chat"), true);
	assert.equal(isPiModel("deepseek-chat"), false);
	// The record grammar is the same one, so a model id with slashes reads back as the selection it was written as.
	assert.deepEqual(resolvedSelectionOf({ model: "openrouter/deepseek/deepseek-chat", effort: "medium" }, "pi"), { model: "openrouter/deepseek/deepseek-chat", effort: "medium" });
	assert.equal(resolvedSelectionOf({ model: "deepseek-chat", effort: "medium" }, "pi"), undefined);
});

test("a codex reference is only ever one that says so, and never carries a pi session file", () => {
	assert.deepEqual(sessionRefOf({ backend: "codex", sessionId: "thread-1" }, "codex"), { backend: "codex", sessionId: "thread-1" });
	assert.deepEqual(sessionRefOf({ backend: "codex", sessionId: "thread-1", checkpoint: "turn-2" }), { backend: "codex", sessionId: "thread-1", checkpoint: "turn-2" });
	const refused: unknown[] = [
		{ sessionId: "thread-1" },
		{ backend: "codex", sessionId: "thread-1", sessionFile: "/sessions/pi-1.jsonl" },
		{ backend: "codex", sessionId: "thread-1", sessionFile: undefined, checkpoint: "" },
		{ backend: "codex", sessionId: " " },
		{ backend: "codex" },
		{ backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl" },
		{ backend: "claude", sessionId: "s-1" },
		["codex"],
		null,
	];
	for (const value of refused) assert.equal(sessionRefOf(value, "codex"), undefined, JSON.stringify(value));
	assert.equal(sessionRefOf({ sessionId: "thread-1" }), undefined, "an untagged value read with no backend named is no reference, and never a codex one");
	assert.deepEqual(sessionRefOf({ sessionId: "s-1" }, "claude"), { backend: "claude", sessionId: "s-1" }, "an untagged reference is still claude's");
	assert.equal(sessionRefOf({ backend: "codex", sessionId: "thread-1" }, "claude"), undefined);
	assert.equal(sessionRefOf({ backend: "codex", sessionId: "thread-1" }, "pi"), undefined);
	assert.equal(sessionRefOf({ backend: "codex", sessionId: "thread-1", sessionFile: "/sessions/pi-1.jsonl" }, "pi"), undefined, "nor is a mixed one read as pi");
	// What a monitor keeps is read by the same grammar, and a field past the ceiling drops the whole reference.
	assert.deepEqual(keptRef({ backend: "codex", sessionId: "thread-1", checkpoint: "turn-2" }, "codex", 8), { backend: "codex", sessionId: "thread-1", checkpoint: "turn-2" });
	assert.equal(keptRef({ backend: "codex", sessionId: "thread-1", checkpoint: "turn-2-long" }, "codex", 8), undefined);
	assert.equal(keptRef({ backend: "codex", sessionId: "thread-1", sessionFile: "/f" }, "codex"), undefined);
});

test("each backend's selection grammar is its own: codex needs a provider, pi and claude an effort", () => {
	assert.deepEqual(resolvedSelectionOf({ model: "gpt-5-codex", provider: "openai" }, "codex"), { model: "gpt-5-codex", provider: "openai" });
	assert.deepEqual(resolvedSelectionOf({ model: "gpt-5-codex", provider: "openai", effort: "xhigh" }, "codex"), { model: "gpt-5-codex", provider: "openai", effort: "xhigh" });
	assert.deepEqual(resolvedSelectionOf({ model: "gpt-5-codex", provider: "openai", effort: "any-level", extra: 1 }, "codex"), { model: "gpt-5-codex", provider: "openai", effort: "any-level" }, "an effort is a token codex takes or refuses, not one this host lists");
	const refused: unknown[] = [
		{ model: "gpt-5-codex" },
		{ model: "gpt-5-codex", provider: "" },
		{ model: "gpt-5-codex", provider: "open ai" },
		{ model: " gpt-5-codex", provider: "openai" },
		{ model: "", provider: "openai" },
		{ provider: "openai" },
		{ model: "gpt-5-codex", provider: "openai", effort: "" },
		{ model: "gpt-5-codex", provider: "openai", effort: "very high" },
		{ model: "gpt-5-codex", provider: "openai", effort: null },
		{ model: "gpt-5-codex", provider: 7 },
		[],
	];
	for (const value of refused) assert.equal(resolvedSelectionOf(value, "codex"), undefined, JSON.stringify(value));
	// Pi still needs a valid thinking level, and Claude an effort; a provider beside either changes nothing they read.
	assert.equal(resolvedSelectionOf({ model: "deepseek/deepseek-chat" }, "pi"), undefined);
	assert.equal(resolvedSelectionOf({ model: "deepseek/deepseek-chat", effort: "ultra" }, "pi"), undefined);
	assert.deepEqual(resolvedSelectionOf({ model: "deepseek/deepseek-chat", provider: "deepseek", effort: "high" }, "pi"), { model: "deepseek/deepseek-chat", effort: "high" });
	assert.equal(resolvedSelectionOf({ model: "opus" }, "claude"), undefined);
	assert.deepEqual(resolvedSelectionOf({ model: "opus", provider: "anthropic", effort: "high" }, "claude"), { model: "opus", effort: "high" });
	assert.deepEqual(keptSelection({ model: "gpt-5", provider: "openai" }, "codex", 6), { model: "gpt-5", provider: "openai" });
	assert.equal(keptSelection({ model: "gpt-5", provider: "openai-long" }, "codex", 6), undefined, "a provider past the ceiling drops the whole selection");
	assert.equal(keptSelection({ model: "gpt-5", provider: "openai", effort: "minimal" }, "codex", 6), undefined, "and so does an effort");
});

test("a backend the host holds keeps its own role and session shapes behind the boundary", async () => {
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
	const held = hostBackend(claudeBackend);
	assert.equal(held.name, "claude");
	const session = held.session({ kind: "resume", ref: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } });
	assert.deepEqual(session, { kind: "resume", id: "s-1", at: "c-1" }, "the host reads the session its backend made and builds none of its own");
	const child = await held.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, input: held.control(), onProgress: () => {} });
	assert.equal(failed(child), false);
	assert.equal(child.role.name, "implement");
	assert.equal(child.role.model, "opus");
});

test("every role a record may name has capabilities, and the host advertises the roles it can run", () => {
	assert.deepEqual([...KNOWN_ROLE_NAMES].sort(), ["ask", "implement", "plan", "security", "ultracode"]);
	// `ROLE_NAMES` is the claude binding's own list, which is what the compatibility tool advertises: security runs on
	// the pi backend alone, so it is not in it, and the primary tool advertises every role a record may name.
	assert.deepEqual([...ROLE_NAMES].sort(), ["ask", "implement", "plan", "ultracode"], "security runs on pi alone, so the claude binding has no role of that name");
	for (const name of KNOWN_ROLE_NAMES) assert.equal(ROLE_SPECS[name].name, name);
	assert.deepEqual(
		KNOWN_ROLE_NAMES.filter((name) => ROLE_SPECS[name].canChangeFiles),
		["plan", "implement", "ultracode", "security"],
	);
	assert.deepEqual(
		KNOWN_ROLE_NAMES.filter((name) => ROLE_SPECS[name].reviewable),
		["implement", "ultracode", "security"],
	);
	assert.deepEqual(ROLE_SPECS.ultracode.backends, ["claude"]);
	assert.deepEqual(ROLE_SPECS.security.backends, ["pi"]);
	assert.equal(runsOn("security", "pi"), true, "and the backend it does run on binds it");
	assert.deepEqual([...ROLE_SPECS.implement.backends].sort(), ["claude", "codex", "pi"]);
	assert.deepEqual([...ROLE_SPECS.ask.backends].sort(), ["claude", "codex", "pi"]);
	assert.deepEqual([...ROLE_SPECS.plan.backends].sort(), ["claude", "codex", "pi"], "codex runs plan beside claude and pi, continued from its recorded checkpoint");
	assert.equal(runsOn("plan", "codex"), true);
	for (const role of ["ultracode", "security"]) assert.equal(runsOn(role, "codex"), false, role);
	assert.equal(canChangeFiles("ask"), false);
	assert.equal(canChangeFiles("nobody"), true, "a role nothing knows is treated as one that can change files");
	assert.equal(isReviewable("nobody"), false);
	assert.equal(runsOn("security", "claude"), false);
	assert.equal(runsOn("ultracode", "pi"), false);
});

test("the Claude backend does not depend on the host extension", () => {
	const names = dependenciesOf("backends/claude.ts");
	assert.ok(
		!names.some((name) => name.endsWith("fusion.ts")),
		`the backend must not depend on the extension that routes to it; it names ${names.join(", ")}`,
	);
});

test("a module reference is found in every form it takes, and nowhere else", () => {
	const source = [
		'// import "commented-out.ts";',
		'/* import "block-comment.ts"; */',
		'import plain from "static.ts";',
		"import { single } from './single-quote.ts';",
		'import "bare.ts";',
		'import type { Only } from "type-only.ts";',
		'export { re } from "re-export.ts";',
		'export type { Type } from "type-re-export.ts";',
		'export * from "star.ts";',
		'const quoted = \'import "in-a-string.ts";\';',
		'const lazy = await import("dynamic.ts");',
		'const required = require("required.ts");',
		"const computed = await import(namedElsewhere);",
	].join("\n");
	assert.deepEqual(modulesNamedIn(source), [
		"static.ts",
		"./single-quote.ts",
		"bare.ts",
		"type-only.ts",
		"re-export.ts",
		"type-re-export.ts",
		"star.ts",
		"dynamic.ts",
		"required.ts",
	]);
});

test("the Claude role's mode is the host's own list of ask modes", () => {
	assert.equal(MODE_STAYS_ASK_MODE, true);
	for (const mode of ASK_MODES) {
		// Compiles only while every ask mode the host validates still fits the mode the adapter's role takes.
		const role: Role = { ...implementRole, name: "ask", mode };
		assert.equal(role.mode, mode);
	}
});

test("the exported child run is the Claude run, so its consumers still read the role's effort, tools and permission mode", async () => {
	assert.equal(CHILD_RUN_STAYS_CLAUDE, true);
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
	const child: ExportedChildRun = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, onProgress: () => {} });
	assert.deepEqual([child.role.effort, child.role.permissionMode, child.role.tools], ["high", "bypassPermissions", ["Read", "Bash", "Edit", "Write", "Grep", "Glob"]]);
});

test("a run goes through the backend boundary", async () => {
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
	assert.equal(claudeBackend.name, "claude");
	const input = claudeBackend.control();
	assert.equal(input.open, true);
	const child = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, input, onProgress: () => {} });
	assert.equal(failed(child), false);
	assert.equal(child.text, "## Changed\nfoo.ts");
	assert.equal(child.role, implementRole);
	assert.equal(input.open, false, "the run closes its input when the child has no work left");
});

test("the claude backend maps an intent to its own session request, and refuses another backend's", () => {
	assert.match(claudeBackend.session({ kind: "new" }).id, UUID);
	assert.deepEqual(claudeBackend.session({ kind: "resume", ref: { backend: "claude", sessionId: "s-1" } }), { kind: "resume", id: "s-1" });
	assert.deepEqual(claudeBackend.session({ kind: "resume", ref: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } }), { kind: "resume", id: "s-1", at: "c-1" });
	const forked = claudeBackend.session({ kind: "fork", from: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } });
	assert.match(forked.id, UUID);
	assert.deepEqual({ kind: forked.kind, from: (forked as { from: string }).from, at: (forked as { at?: string }).at }, { kind: "fork", from: "s-1", at: "c-1" });
	const pi = { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-9" } as const;
	assert.throws(() => claudeBackend.session({ kind: "resume", ref: pi }), /pi session pi-1 cannot be continued by the claude backend/);
	assert.throws(() => claudeBackend.session({ kind: "fork", from: pi }), /pi session pi-1 cannot be continued by the claude backend/);
});

test("a run reports the claude session it ran in, with a checkpoint only where one is trusted", async () => {
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
	const ok = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, onProgress: () => {} });
	assert.deepEqual(ok.session, { backend: "claude", sessionId: ok.sessionId, checkpoint: ok.checkpoint });
	process.env.FAKE_CLAUDE_SCENARIO = "error";
	const fork = { kind: "fork", id: "11111111-1111-4111-8111-111111111111", from: "s-1", at: "c-1" } as const;
	const failedFork = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, session: fork, signal: undefined, onProgress: () => {} });
	assert.equal(failed(failedFork), true);
	assert.deepEqual(failedFork.session, { backend: "claude", sessionId: failedFork.sessionId, checkpoint: "c-1" }, "a failed fork keeps the checkpoint it forked at, never the tip it failed on");
	const failedNew = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, onProgress: () => {} });
	assert.deepEqual(failedNew.session, { backend: "claude", sessionId: failedNew.sessionId }, "a failed first call has an identity and no trusted checkpoint");
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
});

test("the process tree reports how its child exited, and its stderr", async () => {
	const tree = new ChildTree(200);
	const child = tree.spawn({ command: process.execPath, args: ["-e", "process.stderr.write('trouble'); process.exit(3)"], env: process.env });
	assert.equal(tree.spawned, true);
	assert.equal(typeof child.kill, "function");
	const exit = await tree.exited();
	assert.equal(exit.code, 3);
	assert.equal(exit.signal, null);
	assert.equal(tree.stderr, "trouble");
	assert.equal(tree.stoppedBy(exit), false, "a child that exited on its own was stopped by nothing this sent");
});

test("killing the process tree stops a child that would run on", async () => {
	const tree = new ChildTree(200);
	tree.spawn({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 60_000)"], env: process.env });
	tree.kill();
	const exit = await tree.exited();
	assert.equal(exit.signal, "SIGTERM");
	assert.equal(tree.stoppedBy(exit), true, "a signal this sent is this shutdown, not the child's own outcome");
});
