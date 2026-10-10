import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	CODEX_CONTRACT_FILES,
	CODEX_HOST_DEFAULT,
	CODEX_MODES,
	CODEX_ROLE_NAMES,
	codexEffortVariable,
	codexModelVariable,
	codexParams,
	codexRole,
	codexVariableFallback,
} from "../extensions/backends/codex-binding.ts";
import { KNOWN_ROLE_NAMES, runsOn } from "../extensions/roles.ts";

/**
 * The Codex binding on its own: what a call resolves to, from which setting, and what it refuses. Pure: no host, no
 * backend and no child, and every environment it reads is one this file passes in.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NO_ENV = {} as NodeJS.ProcessEnv;
const IMPLEMENT = { name: "implement", contract: "implement.md", sandboxMode: "workspace-write", approvalPolicy: "never" } as const;
const PLAN = { name: "plan", contract: "plan.md", sandboxMode: "workspace-write", approvalPolicy: "never" } as const;
const ask = (mode: "answer" | "review") => ({ name: "ask", contract: `ask-${mode}.md`, mode, sandboxMode: "read-only", approvalPolicy: "never" }) as const;

test("the codex binding binds the roles the role table runs on codex, and no other", () => {
	assert.deepEqual([...CODEX_ROLE_NAMES], KNOWN_ROLE_NAMES.filter((role) => runsOn(role, "codex")));
	assert.deepEqual([...CODEX_ROLE_NAMES], ["plan", "implement", "ask"]);
	// A name an object inherits is no role: the lookups read own properties only.
	for (const role of ["ultracode", "security", "audit", "constructor", "toString", "__proto__"]) {
		assert.throws(() => codexRole({ role }, undefined, NO_ENV), new RegExp(`^Error: role ${role} does not run on the codex backend; use one of plan, implement, ask$`), role);
		assert.throws(() => codexParams({ role }), new RegExp(`^Error: role ${role} does not run on the codex backend`), role);
	}
});

test("a role that names no model binds none, so the host's own codex default is what runs and the display label never reaches a runtime", () => {
	const implement = codexRole({ role: "implement" }, undefined, NO_ENV);
	assert.deepEqual(implement, IMPLEMENT);
	for (const field of ["model", "provider", "effort"]) assert.equal(field in implement, false, `${field} is held as a key though nothing named it`);
	assert.equal(CODEX_HOST_DEFAULT, "host default");
	assert.ok(!(Object.values(implement) as string[]).includes(CODEX_HOST_DEFAULT));
	assert.deepEqual(codexRole({ role: "ask" }, undefined, NO_ENV), ask("answer"));
	assert.deepEqual(codexRole({ role: "ask", mode: "review" }, undefined, NO_ENV), ask("review"));
	const plan = codexRole({ role: "plan" }, undefined, NO_ENV);
	assert.deepEqual(plan, PLAN, "a plan run reads only the shared plan contract");
	for (const field of ["model", "provider", "effort", "mode"]) assert.equal(field in plan, false, `${field} is held as a key though nothing named it`);
});

test("an ask run reads in a read-only sandbox and a plan or implement run writes in its workspace, all with no approval ever asked", () => {
	assert.equal(codexRole({ role: "ask" }, undefined, NO_ENV).sandboxMode, "read-only");
	assert.equal(codexRole({ role: "ask", mode: "review" }, undefined, NO_ENV).sandboxMode, "read-only");
	assert.equal(codexRole({ role: "implement" }, undefined, NO_ENV).sandboxMode, "workspace-write");
	assert.equal(codexRole({ role: "plan" }, undefined, NO_ENV).sandboxMode, "workspace-write", "a plan run writes its own notes and scratch files, as on every backend");
	for (const role of CODEX_ROLE_NAMES) assert.equal(codexRole({ role }, undefined, NO_ENV).approvalPolicy, "never");
});

test("the parameters: mode is ask's alone and only answer or review, model and effort are every codex role's, and fresh is plan's alone", () => {
	assert.deepEqual(codexParams({ role: "ask" }), { name: "ask", mode: "answer" });
	assert.deepEqual(codexParams({ role: "ask", mode: "review" }), { name: "ask", mode: "review" });
	assert.deepEqual([...CODEX_MODES], ["answer", "review"]);
	for (const mode of ["summary", "Review", "", " review"]) assert.throws(() => codexParams({ role: "ask", mode }), new RegExp(`^Error: unknown mode ${mode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; use one of answer, review$`), JSON.stringify(mode));
	assert.throws(() => codexParams({ role: "implement", mode: "answer" }), /^Error: mode is not allowed for role implement on the codex backend$/);
	assert.throws(() => codexParams({ role: "plan", mode: "answer" }), /^Error: mode is not allowed for role plan on the codex backend$/);
	for (const role of CODEX_ROLE_NAMES) assert.doesNotThrow(() => codexParams({ role, model: "gpt-5-codex", effort: "high" }), role);
	for (const role of ["implement", "ask"]) {
		for (const fresh of [true, false]) assert.throws(() => codexParams({ role, fresh }), new RegExp(`^Error: fresh is not allowed for role ${role} on the codex backend$`), role);
	}
	// fresh is the route's to read, as on every backend: the binding takes it, true or false, and binds nothing from it.
	for (const fresh of [true, false]) assert.deepEqual(codexRole({ role: "plan", fresh }, undefined, NO_ENV), PLAN, String(fresh));
});

test("the selection comes from the call, then the run it continues, then the fallback, then the role's own variables, field by field", () => {
	const env = { [codexModelVariable("implement")]: " gpt-5-codex ", [codexEffortVariable("implement")]: "medium" } as NodeJS.ProcessEnv;
	assert.equal(codexModelVariable("implement"), "PI_FUSION_CODEX_IMPLEMENT_MODEL");
	assert.equal(codexEffortVariable("ask"), "PI_FUSION_CODEX_ASK_EFFORT");
	assert.deepEqual(codexVariableFallback("implement", env), { model: { value: "gpt-5-codex", from: "PI_FUSION_CODEX_IMPLEMENT_MODEL" }, effort: { value: "medium", from: "PI_FUSION_CODEX_IMPLEMENT_EFFORT" } });
	assert.deepEqual(codexVariableFallback("ask", { PI_FUSION_CODEX_ASK_MODEL: "  " } as NodeJS.ProcessEnv), {}, "a blank variable is unset, not a model");
	// The role's own variables, when the caller passes no fallback.
	assert.deepEqual(codexRole({ role: "implement" }, undefined, env), { ...IMPLEMENT, model: "gpt-5-codex", effort: "medium" });
	// A fallback the caller passes replaces the variables entirely: a profile never borrows a variable for a field it left out.
	const configured = { model: { value: "o3", from: "profile work" } };
	assert.deepEqual(codexRole({ role: "implement" }, undefined, env, configured), { ...IMPLEMENT, model: "o3" });
	// The recorded selection wins over the fallback, provider and effort included.
	const recorded = { model: "gpt-5.5", provider: "openai", effort: "low" };
	assert.deepEqual(codexRole({ role: "implement" }, recorded, env, configured), { ...IMPLEMENT, model: "gpt-5.5", provider: "openai", effort: "low" });
	// The call wins over both for the fields it names, trimmed, and the recorded provider stays with the thread.
	assert.deepEqual(codexRole({ role: "implement", model: " o4-mini ", effort: "xhigh" }, recorded, env, configured), { ...IMPLEMENT, model: "o4-mini", provider: "openai", effort: "xhigh" });
	assert.deepEqual(codexRole({ role: "implement", effort: "high" }, recorded, env), { ...IMPLEMENT, model: "gpt-5.5", provider: "openai", effort: "high" });
	// A recorded selection with no effort leaves the effort to the fallback, which names none here: it stays unset.
	assert.deepEqual(codexRole({ role: "ask" }, { model: "gpt-5.5", provider: "azure" }, NO_ENV), { ...ask("answer"), model: "gpt-5.5", provider: "azure" });
	// The effort is optional on its own: a configured model with no level leaves the level to the host.
	assert.deepEqual(codexRole({ role: "ask" }, undefined, { PI_FUSION_CODEX_ASK_MODEL: "gpt-5-codex" } as NodeJS.ProcessEnv), { ...ask("answer"), model: "gpt-5-codex" });
	// A fresh call has no provider: nothing a call or a configuration names is one.
	assert.equal("provider" in codexRole({ role: "implement", model: "gpt-5-codex" }, undefined, env), false);
	// Role plan reads its own variables by the same precedence, and none of another role's.
	const planEnv = { PI_FUSION_CODEX_PLAN_MODEL: "gpt-5.5", PI_FUSION_CODEX_PLAN_EFFORT: "xhigh", ...env } as NodeJS.ProcessEnv;
	assert.equal(codexModelVariable("plan"), "PI_FUSION_CODEX_PLAN_MODEL");
	assert.deepEqual(codexVariableFallback("plan", planEnv), { model: { value: "gpt-5.5", from: "PI_FUSION_CODEX_PLAN_MODEL" }, effort: { value: "xhigh", from: "PI_FUSION_CODEX_PLAN_EFFORT" } });
	assert.deepEqual(codexRole({ role: "plan" }, undefined, planEnv), { ...PLAN, model: "gpt-5.5", effort: "xhigh" });
	assert.deepEqual(codexRole({ role: "plan" }, undefined, env), PLAN, "the implement variables are not the plan role's");
	assert.deepEqual(codexRole({ role: "plan", model: "o3" }, recorded, planEnv), { ...PLAN, model: "o3", provider: "openai", effort: "low" }, "a continued plan run keeps its provider and recorded effort under a call's model");
	assert.deepEqual(codexRole({ role: "plan" }, undefined, planEnv, configured), { ...PLAN, model: "o3" }, "a configured fallback replaces the plan variables too");
});

test("a value no codex child could take is refused with the setting it came from, and a blank call field never falls through", () => {
	assert.throws(() => codexRole({ role: "implement" }, undefined, { PI_FUSION_CODEX_IMPLEMENT_MODEL: "gpt 5" } as NodeJS.ProcessEnv), /^Error: PI_FUSION_CODEX_IMPLEMENT_MODEL names model "gpt 5", which is not a codex model: name one model id with no whitespace in it, or leave it unset for the host default$/);
	assert.throws(() => codexRole({ role: "ask" }, undefined, { PI_FUSION_CODEX_ASK_EFFORT: "very high" } as NodeJS.ProcessEnv), /^Error: PI_FUSION_CODEX_ASK_EFFORT names effort "very high", which is not a codex effort: name one level with no whitespace in it, or leave it unset for the host default$/);
	assert.throws(() => codexRole({ role: "implement" }, undefined, NO_ENV, { model: { value: "a\tb", from: "profile work (modified)" } }), /^Error: profile work \(modified\) names model "a\\tb", which is not a codex model/);
	assert.throws(() => codexRole({ role: "implement", model: "gpt 5" }, undefined, NO_ENV), /^Error: the call names model "gpt 5", which is not a codex model/);
	assert.throws(() => codexRole({ role: "implement", effort: "x high" }, undefined, NO_ENV), /^Error: the call names effort "x high", which is not a codex effort/);
	const recorded = { model: "gpt-5.5", provider: "openai", effort: "low" };
	for (const blank of ["", " ", "\t"]) {
		assert.throws(() => codexRole({ role: "implement", model: blank }, recorded, NO_ENV), /^Error: the call names an empty model for the codex backend; name one or leave the model parameter out to take the recorded, configured or host default model$/, JSON.stringify(blank));
		assert.throws(() => codexRole({ role: "implement", effort: blank }, recorded, NO_ENV), /^Error: the call names an empty effort for the codex backend/, JSON.stringify(blank));
	}
	// A recorded selection this host did not write is refused rather than repeated.
	assert.throws(() => codexRole({ role: "implement" }, { model: "gpt-5.5", provider: "open ai" }, NO_ENV), /^Error: the selection the run it continues ran with names provider "open ai", which is not a codex model provider$/);
	assert.throws(() => codexRole({ role: "implement" }, { model: "gpt 5.5", provider: "openai" }, NO_ENV), /^Error: the selection the run it continues ran with names model "gpt 5\.5"/);
});

test("every codex role names only a shipped shared contract, with no backend-specific question fallback", () => {
	assert.deepEqual([...CODEX_CONTRACT_FILES].sort(), ["ask-answer.md", "ask-review.md", "implement.md", "plan.md"]);
	for (const name of CODEX_CONTRACT_FILES) assert.ok(fs.existsSync(path.join(repoRoot, "contracts", name)), `contracts/${name} is not shipped`);
	for (const role of CODEX_ROLE_NAMES) {
		for (const mode of role === "ask" ? CODEX_MODES : [undefined]) {
			const bound = codexRole({ role, ...(mode === undefined ? {} : { mode }) }, undefined, NO_ENV);
			assert.ok(CODEX_CONTRACT_FILES.includes(bound.contract));
			assert.equal("addendum" in bound, false);
			assert.match(fs.readFileSync(path.join(repoRoot, "contracts", bound.contract), "utf8"), /ask_orchestrator/);
		}
	}
});
