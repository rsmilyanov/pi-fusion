import assert from "node:assert/strict";
import { after } from "node:test";
import { PI_ROLE_NAMES, piEffortVariable, piModelVariable } from "../extensions/backends/pi-binding.ts";
import type { HostBackend, SessionIntent } from "../extensions/backends/types.ts";
import type { FusionOptions } from "../extensions/fusion.ts";
import { memoryProfileStore } from "../extensions/profile-store.ts";
import { memorySettingsStore } from "../extensions/settings-store.ts";
import { KNOWN_ROLE_NAMES, runsOn } from "../extensions/roles.ts";

/**
 * The pi and codex backends the test hosts register in place of the ones this build registers by default.
 * Every registration takes both through `tripwires()` but the two `productionDefaults()` registrations, which take
 * this build's own pi backend and reach no method of it: each deletes every variable a pi role could resolve a model
 * from first, so the registration is refused while one is still set and the explicit pi call is then refused by the
 * binding for having no model, before a session, a control or a run is asked for. Those two still take the codex
 * tripwire, because nothing would refuse a codex call there: a codex role runs on the host's own default model when it
 * names none, so no missing-model refusal stands between this build's codex registration and a real app-server.
 *
 * Nothing in the suite is about running a real Pi or Codex child: a case that reached a production backend would
 * compose storage, write a call input and launch a harness instead of failing in a way a test can read. So every entry
 * point of a tripwire records that it was reached and refuses, and the hook at the bottom is what says none of them
 * was — for the whole file, and not for the one case that happened to notice.
 *
 * A host that injects a backend of its own puts it over these, which is why `tripwires()` is spread first:
 * `{ ...tripwires(), ...ownBackends }`. A case that wants this build's own pi registration instead says so with
 * `productionDefaults()`, which is the one other thing a registration call may name.
 */

/** What every pi entry point refuses with, and all it says: reaching one is the suite's own mistake, not a run's. */
export const PI_TRIPWIRE = "the suite reached the pi backend tripwire";

/** The same for codex, named apart so a reach says which harness it would have started. */
export const CODEX_TRIPWIRE = "the suite reached the codex backend tripwire";

/** Each entry point a case reached, per backend and in order. Empty lists are the only acceptable value, and the hook below says so. */
const reaches = { pi: [] as string[], codex: [] as string[] };

/** A backend under `name` every entry point of which records its reach before it throws `message`. */
function tripwire(name: keyof typeof reaches, message: string): HostBackend {
	return {
		name,
		control: (): never => {
			reaches[name].push("control");
			throw new Error(message);
		},
		session: (intent: SessionIntent): never => {
			reaches[name].push(`session ${intent.kind}`);
			throw new Error(message);
		},
		run: async (): Promise<never> => {
			reaches[name].push("run");
			throw new Error(message);
		},
	};
}

/** The pi tripwire alone. A host registration takes `tripwires()`, which is this and the codex one together. */
export function piTripwire(): { pi: HostBackend } {
	return { pi: tripwire("pi", PI_TRIPWIRE) };
}

/** The codex tripwire alone: what `productionDefaults()` registers, and what `tripwires()` adds to the pi one. */
export function codexTripwire(): { codex: HostBackend } {
	return { codex: tripwire("codex", CODEX_TRIPWIRE) };
}

/** The backends an ordinary host registers to keep every production child harness out of it, ready to spread over its own. */
export function tripwires(): { pi: HostBackend; codex: HostBackend } {
	return { ...piTripwire(), ...codexTripwire() };
}

/** What a case reached of one backend's tripwires so far, for a case that checks its own as well as the file-level hook. */
export const tripwireReaches = (backend: keyof typeof reaches): string[] => [...reaches[backend]];

/**
 * Every variable a pi role could take a selection from, which a production-default registration has to clear: the
 * roles are the binding's own exported list rather than a copy of it, and each role's two variable names come from
 * the binding's own helpers. A role this build binds on Pi later is therefore guarded here the day it is added,
 * instead of leaving a registration that takes the defaults with a model it could still resolve.
 */
export const PI_SELECTION_VARIABLES = PI_ROLE_NAMES.flatMap((role) => [piModelVariable(role), piEffortVariable(role)]);

/**
 * Every variable a codex role could take a selection from, for the roles the role table runs on codex, by the prefix
 * the baseline reads them with, and the variable that would point a codex launch at a binary. None of them is what
 * keeps a production-default registration safe — the codex tripwire is — but each would bind a later codex launch to
 * something on this machine, so a registration that takes the defaults leaves them unset too.
 */
export const CODEX_VARIABLES = [
	...KNOWN_ROLE_NAMES.filter((role) => runsOn(role, "codex")).flatMap((role) => [`PI_FUSION_CODEX_${role.toUpperCase()}_MODEL`, `PI_FUSION_CODEX_${role.toUpperCase()}_EFFORT`]),
	"PI_FUSION_CODEX_BIN",
];

/** Everything a production-default registration refuses to start with set: what a case clears before it asks for one. */
export const PRODUCTION_DEFAULT_VARIABLES = [...PI_SELECTION_VARIABLES, ...CODEX_VARIABLES];

/**
 * The options a registration that is about this build's own backends passes, which is the marker that says so: the
 * two cases that read the production pi registration name this, every other registration names `tripwires`, and
 * `test/backends.test.ts` reads both out of the source. It is not cosmetic — a production-default registration is
 * only safe while no pi role can resolve a model, because the binding's refusal is the one thing between such a case
 * and a real child, so a variable still set here fails the call that asked for the defaults rather than the run. Codex
 * has no such refusal, which is why the codex tripwire is registered here whatever this build registers for codex.
 */
export function productionDefaults(): FusionOptions {
	const set = PRODUCTION_DEFAULT_VARIABLES.filter((name) => process.env[name] !== undefined);
	if (set.length) throw new Error(`a production-default registration must leave a pi role no model to resolve and codex nothing to launch with, and ${set.join(", ")} is still set`);
	// This build's own claude and pi backends, the codex tripwire, and never the user's own profiles or settings
	// file: no registration of the suite reads or writes either.
	return { backends: { ...codexTripwire() }, profiles: memoryProfileStore(), settings: memorySettingsStore() };
}

/**
 * Registered at module level, when a file imports this, rather than inside any case: a case that swallowed what an
 * entry point threw — a tool whose error becomes a returned message, a run whose failure becomes a report — would
 * otherwise pass while having reached a backend that in production is a real child. The reach is recorded before
 * the throw for the same reason, and this hook fails the whole file on it whichever case did it.
 */
after(() => {
	assert.deepEqual(reaches.pi, [], "a case reached the pi backend tripwire, which in production is a real pi child");
	assert.deepEqual(reaches.codex, [], "a case reached the codex backend tripwire, which in production is a real codex app-server");
});
