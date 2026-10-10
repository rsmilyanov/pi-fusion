import { isCodexToken, type ResolvedSelection } from "./types.ts";

/**
 * What a role runs as on the Codex backend: the model, provider and effort a call resolves to, the contract it runs
 * under, and the sandbox and approval policy a Codex thread is started with. This is a binding, not an execution
 * adapter: nothing here starts a child, reads a Codex configuration or knows the app-server
 * protocol. Which models and efforts exist is the child's to say; this module only settles what the call asks for and
 * refuses what no Codex value can be.
 */

/**
 * The roles this build binds on Codex. A plan run is continued by default, from the exact checkpoint and usage baseline
 * its record carries, as any continued Codex run is. `ultracode` is Claude's and `security` is Pi's.
 */
export const CODEX_ROLE_NAMES = ["plan", "implement", "ask"] as const;
export type CodexRoleName = (typeof CODEX_ROLE_NAMES)[number];

export const CODEX_MODES = ["answer", "review"] as const;
export type CodexMode = (typeof CODEX_MODES)[number];

/**
 * How a role that names no model is shown: the host's own Codex configuration chooses it. A display text and never a
 * value: a role's `model` stays unset rather than holding this, so no runtime is ever asked to run a model of this name.
 */
export const CODEX_HOST_DEFAULT = "host default";

/**
 * The Codex sandbox each role is started in: an ask run reads, and a plan or implement run writes inside its workspace,
 * a plan run for its own notes and scratch files, as it does on every backend.
 */
export type CodexSandboxMode = "read-only" | "workspace-write";

/**
 * A Codex child's role. `model`, `provider` and `effort` are absent when nothing named them, which leaves each to the
 * host's own Codex configuration; none of them ever carries a placeholder for that.
 */
export interface CodexRole {
	name: CodexRoleName;
	model?: string;
	/** The model provider a continued thread ran on, repeated with it. A fresh call names none: the call has no field for one. */
	provider?: string;
	effort?: string;
	contract: string;
	mode?: CodexMode;
	sandboxMode: CodexSandboxMode;
	/** Nobody answers an approval request while a child runs unattended, so none is ever made. */
	approvalPolicy: "never";
}

const CODEX_SANDBOX: Record<CodexRoleName, CodexSandboxMode> = { plan: "workspace-write", implement: "workspace-write", ask: "read-only" };

/** The shared contracts a Codex role runs under, with no backend-specific question fallback. */
const CODEX_CONTRACTS: Record<CodexRoleName, string> = { plan: "plan.md", implement: "implement.md", ask: "ask-answer.md" };
const CODEX_ASK_CONTRACTS: Record<CodexMode, string> = { answer: "ask-answer.md", review: "ask-review.md" };

/** Every contract a Codex role names is checked at load, whichever backend a call will use. */
export const CODEX_CONTRACT_FILES: readonly string[] = [...new Set([...Object.values(CODEX_CONTRACTS), ...Object.values(CODEX_ASK_CONTRACTS)])];

/** The call parameters each Codex role takes: `fresh` is a plan call's alone, as it is on every backend. */
const CODEX_ROLE_PARAMETERS: Record<"fresh" | "mode" | "model" | "effort", readonly CodexRoleName[]> = {
	fresh: ["plan"],
	mode: ["ask"],
	model: ["plan", "implement", "ask"],
	effort: ["plan", "implement", "ask"],
};

/** What a call asks of a Codex role: the role it names, an ask run's mode, and the selection it overrides. */
export interface CodexCall {
	role: string;
	mode?: string;
	model?: string;
	effort?: string;
	fresh?: boolean;
}

/** The variables that configure a role's Codex binding. Unset, the host's own Codex configuration chooses. */
export const codexModelVariable = (role: string): string => `PI_FUSION_CODEX_${role.toUpperCase()}_MODEL`;
export const codexEffortVariable = (role: string): string => `PI_FUSION_CODEX_${role.toUpperCase()}_EFFORT`;

const isCodexRoleName = (role: string): role is CodexRoleName => (CODEX_ROLE_NAMES as readonly string[]).includes(role);

/**
 * The role and mode a Codex call names, or an error naming what the role cannot take. This is the parameter half of
 * the binding: it settles nothing about a model, so a call can be refused for its parameters before anything asks
 * whether this build runs Codex at all.
 */
export function codexParams(call: CodexCall): { name: CodexRoleName; mode: CodexMode } {
	if (!isCodexRoleName(call.role)) throw new Error(`role ${call.role} does not run on the codex backend; use one of ${CODEX_ROLE_NAMES.join(", ")}`);
	const name = call.role;
	for (const [parameter, roles] of Object.entries(CODEX_ROLE_PARAMETERS)) {
		if (call[parameter as keyof CodexCall] !== undefined && !roles.includes(name)) throw new Error(`${parameter} is not allowed for role ${name} on the codex backend`);
	}
	if (call.mode !== undefined && !(CODEX_MODES as readonly string[]).includes(call.mode)) throw new Error(`unknown mode ${call.mode}; use one of ${CODEX_MODES.join(", ")}`);
	return { name, mode: (call.mode ?? "answer") as CodexMode };
}

/** Where a field of the selection came from, so a value no Codex child could take says which setting to correct. */
export interface CodexChosen {
	value: string;
	from: string;
}

/**
 * What a role falls back on when neither the call nor the run it continues names a field, each value with the setting
 * it came from. Either may be absent: Codex has a default of its own, which is the host's Codex configuration.
 */
export interface CodexFallback {
	model?: CodexChosen;
	effort?: CodexChosen;
}

/** The fallback the role's own variables are, which is what a host that passes no configuration gets. */
export function codexVariableFallback(role: string, env: NodeJS.ProcessEnv = process.env): CodexFallback {
	const model = env[codexModelVariable(role)]?.trim();
	const effort = env[codexEffortVariable(role)]?.trim();
	return {
		...(model ? { model: { value: model, from: codexModelVariable(role) } } : {}),
		...(effort ? { effort: { value: effort, from: codexEffortVariable(role) } } : {}),
	};
}

const chosen = (field: "model" | "effort", call: string | undefined, recorded: string | undefined, configured: CodexChosen | undefined): CodexChosen | undefined => {
	if (call !== undefined) {
		const named = call.trim();
		// A blank field is a mistake rather than a way of asking for the host default: leaving it out is how a call asks for that.
		if (!named) throw new Error(`the call names an empty ${field} for the codex backend; name one or leave the ${field} parameter out to take the recorded, configured or host default ${field}`);
		return { value: named, from: "the call" };
	}
	// The selection the run actually ran with wins over a configuration that has changed since, so a continuation repeats it.
	if (recorded !== undefined) return { value: recorded, from: "the selection the run it continues ran with" };
	return configured;
};

/** Refuses a value no Codex child could take as one model id or one effort, naming the setting it came from. */
const token = (field: "model" | "effort", value: CodexChosen | undefined): string | undefined => {
	if (value === undefined) return undefined;
	if (!isCodexToken(value.value)) throw new Error(`${value.from} names ${field} ${JSON.stringify(value.value)}, which is not a codex ${field}: name one ${field === "model" ? "model id" : "level"} with no whitespace in it, or leave it unset for the host default`);
	return value.value;
};

/**
 * The Codex role a call runs, with the model, provider and effort it resolved to: the call's own override first, then
 * the selection the run it continues actually ran with, then the fallback — the session's configuration, or the
 * role's own variables when the caller passes none. Nothing is required: a field nothing names stays unset, and the
 * host's own Codex configuration chooses it. The provider has no call parameter and no setting, so it is the recorded
 * one or none; a continuation keeps the provider its thread ran on even when the call names another model.
 */
export function codexRole(call: CodexCall, recorded?: ResolvedSelection, env: NodeJS.ProcessEnv = process.env, fallback?: CodexFallback): CodexRole {
	const { name, mode } = codexParams(call);
	const base = fallback ?? codexVariableFallback(name, env);
	const model = token("model", chosen("model", call.model, recorded?.model, base.model));
	const effort = token("effort", chosen("effort", call.effort, recorded?.effort, base.effort));
	const provider = recorded?.provider;
	if (provider !== undefined && !isCodexToken(provider)) throw new Error(`the selection the run it continues ran with names provider ${JSON.stringify(provider)}, which is not a codex model provider`);
	return {
		name,
		...(model === undefined ? {} : { model }),
		...(provider === undefined ? {} : { provider }),
		...(effort === undefined ? {} : { effort }),
		contract: name === "ask" ? CODEX_ASK_CONTRACTS[mode] : CODEX_CONTRACTS[name],
		...(name === "ask" ? { mode } : {}),
		sandboxMode: CODEX_SANDBOX[name],
		approvalPolicy: "never",
	};
}
