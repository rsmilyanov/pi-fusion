# Repository guidance

Pi-Fusion is one Pi extension. Code is the source of truth; use [CONTEXT.md](CONTEXT.md)'s vocabulary and the owning page under [docs/](docs/) for behavior.

## Commands

```bash
npm install            # includes the Claude SDK's bundled binary (~200 MB)
npm run typecheck      # tsc -p . (noEmit); no linter or formatter
npm test               # node --test --test-timeout=60000 "test/*.test.ts"
node --test test/control.test.ts
node --test --test-name-pattern="continue" test/control.test.ts
```

Tests past 60 seconds are cancelled and named. Browser tests use `PI_FUSION_CHROME`, platform install paths, then Chromium on `PATH`; they skip without a browser. [Development](docs/development.md) owns the module map and manual harness instructions.

## Editing conventions

- Relative TypeScript imports carry `.ts` (`allowImportingTsExtensions`). Child/preload programs use `.mjs`, with `.d.mts` where needed.
- Tabs, semicolons, long lines. Put `/** ... */` comments above declarations and explain why, not merely what.
- Change role behavior in `contracts/*.md`. Shared plan/implement/ask contracts stay vendor-neutral; backend-specific contracts may name their requirements.
- Keep runtime fixes and documentation consolidation separate. User-facing behavior changes belong in the owning topic page in the same commit.
- Document current behavior from code, not completed implementation plans. Keep TODOs, open issues, future proposals, and scoped qualification evidence. Prefer ASCII diagrams and short tables/bullets to walls of prose; link to the owning page rather than repeating detail.
- Commit only when asked: concise imperative subject (up to about 150 characters), no AI or `Co-Authored-By` trailers.

## Entry point and boundaries

`extensions/fusion.ts` exports `fusion(pi, options?)`: delegation/control pairs `fusion`/`fusion_control` and compatibility `claude`/`claude_control`, two mode tools, `/fusion`, the run-message renderer, and `session_start`, `agent_settled`, `session_shutdown`, `session_before_tree` handlers.

Load order: internal child marker, required contracts for every backend/ask mode, Pi bootstrap existence, then backend registration. A Pi child with `PI_FUSION_CHILD=pi` registers nothing before any contract check; this is not a user setting.

- Host: mode, configuration, routing, handles, scheduling, questions, branch records; no direct backend-SDK import.
- `backends/types.ts`: import-free, SDK-neutral requests/outcomes. Each backend owns its binding, session/role shapes, protocol, and SDK options; registration key must match backend name.
- Claude SDK belongs in `backends/claude.ts`. Pi composition belongs in `backends/pi-backend.ts`; host directory/package accessors load Pi lazily, but only the bootstrap constructs its child runtime.
- Launch `pi-bootstrap.mjs` and `pi-sdk-resolve.mjs` by path, never import them into the host. Transport reads shared constants from import-free `pi-bootstrap-protocol.mjs`.
- Codex is an app-server client with no SDK or npm dependency: `codex-binding.ts` (imports only `types.ts`), `codex-launch.ts`, `codex-protocol.ts`, `codex-transport.ts`, `codex-outcome.ts`, `codex.ts`. The transport reuses only Pi's generic `LineFramer`/timer helpers; only Codex modules import its protocol/transport, and the host reaches it through `createCodexBackend()` alone, whose construction reads, locates, and starts nothing. The host's `codex` is located only when a run starts.
- `process-tree.ts` owns launching/cleanup through SDK-neutral options. Owned cleanup and streamed stderr are independent opt-ins; preserve the legacy Claude path.

See [Pi backend](docs/pi-backend.md) and [Codex backend](docs/codex-backend.md) for architecture, lifecycle checks, and qualification limits.

## Mode and configuration invariants

- Fusion starts off in each instance; nothing delegates, continues, hands off, or reviews while off. Mode is memory-only.
- On/off share synchronous implementations. Off refuses every unfinished run (running, waiting, finishing), cancels nothing, respects allow lists/exclusions, and preserves unrelated active tools.
- Tool activation arms one reminder on the **host's** `agent_settled`: clear before notification, suppress for `/fusion on`, clear on successful off. It is neither child completion nor automatic deactivation.
- Settings apply only with no unfinished run. Application/admission binding remain synchronous after the last await. Refresh preserves the entire active-tool list; on failure roll settings back and attempt guidance/list restoration, not guaranteed recovery.
- Builtin disables `security` (Pi-only); enable it through settings/profiles, not a model parameter/variable. Saved profiles keep their enabled settings. Ultracode is Claude-only. Codex supports `plan`/`implement`/`ask` (see [Codex evidence](docs/codex-backend.md#evidence)), and builtin routes nothing there.
- Disabled roles refuse fresh calls and continuations before a handle. Role/profile lookups use own properties, never inherited keys.
- Fresh calls use configured routing unless overridden; another backend uses its captured legacy defaults, not the configured backend's selection. Continuations retain recorded backend/settings unless permitted fields are explicitly overridden.
- Independent review is a fresh configured `ask` run, inheriting nothing from the source. Disabled ask refuses manual review and quietly skips automatic review.

## Run and record invariants

- One active file-changing run across backends, waiting included; ask may run beside it. Each question gets one answer; a competing host answer must not become an accidental steer.
- `/tree` refuses unfinished runs; shutdown cancels active work and awaits final recording.
- `recordDecision` alone authorizes persistence: outcome identity, never progress or a predicted fork path. Contradictory outcomes fail and publish no identity to branch/history.
- Untagged entries are Claude. Claude keeps flat session/checkpoint/model/effort; missing older settings use captured legacy defaults with notice. Pi keeps a structured reference and verified selection.
- Failed resumes preserve the last successful record. Failed forks can retain their verified starting identity/checkpoint. Unrepeatable Pi handles remain readable but refuse explicit/implicit continuation: retry without `continue` (plan also needs `fresh: true`), never an older-plan/default guess.
- Pi success requires settled evidence, exact identity/selection, idle state with `pendingMessageCount === 0`, moved leaf, usable per-call usage, and clean reported shutdown. Ordinary tasks cannot invoke internal navigation/fork commands.

### Codex

- Inherits the host's binary, environment, home, auth, configuration, MCP, remote-control, and multi-agent settings: no isolation, no cwd or trust write, no historical sandbox guard.
- A continuable record needs the thread, admitted completed turn as checkpoint, cumulative usage baseline there, and verified selection with provider. Incomplete older records stay readable, are never upgraded, and refuse explicit/implicit continuation before any contract read, lookup, or spawn.
- Resume requires the exact recorded tip. A fork requires a verified different thread id and records its own completed starting tip, never the source's, without a baseline.
- Per-call usage is the total less the baseline in five core counts. A fresh thread names no provider; a plan handoff carries model/effort only. Cost is unknown and never estimated.
- Steers are one-shot to the admitted turn: accepted is queued, not consumed; nothing retries or replays.
- Every backend run requires a callable question callback before contract read, lookup or spawn (already cancelled calls remain cancellation). The whole connection opts into the experimental API. Fresh threads register `ask_orchestrator`; resumes/forks register nothing and trust Codex's restoration. Only shared role contracts are injected; no inventory probe, capability marker or tool-less-thread fallback.
- Questions come only from the run's own live turn, each answered once and never on the read loop. Other `ask_orchestrator` calls get `success: false` without failing the run. See [Questions](docs/questions.md#on-codex).
- Success requires admitted-turn completion, a final message, usage at/above the baseline, idle readback, verified selection (reroutes are telemetry, not selection), and clean shutdown.

### Cleanup and hints

- Preparation/task own their child's single stop. Outcome mapping owns cleanup concerns, success demotion, disposition, and the single cleanup notice; add no second stop/warning composer above them.
- Cleanup is bounded best effort, not isolation. Discovery failure is sticky, including a root never observed alive; uncertainty retains call storage and publishes no new successful checkpoint. No mandatory preflight, background survey, replay/resend, or steer retry.
- Hints follow the invoking delegation/control pair; both controls manage all runs, Pi and Codex continuation guidance always names `fusion`, user commands stay `/fusion ...`.

## Tests and safety

The default suite starts no real Claude/Pi/Codex child or paid model request, and no test host call locates a native `codex`. Preserve that boundary:

- Extension hosts inject `tripwires()` (Pi and Codex) and `memoryProfileStore()`. The two `productionDefaults()` registrations test Pi missing-model refusals before any backend entry point and still inject the Codex tripwire, since Codex's host-default model leaves no such refusal. Own doubles spread over the tripwires: `{ ...tripwires(), pi: own }`.
- Activate through the registered tool, never a default-on option; explicitly enable security in its cases.
- `fake-claude.mjs` uses real SDK objects around fake protocol; `fake-pi.mjs` speaks native RPC without SDK; `fake-pi-backend.ts` is an in-memory lifecycle backend; `fake-codex.mjs` speaks literal app-server JSON-RPC from builtins only, never an SDK, and is launched by path through injected seams. These test different layers.
- A case that routes to Codex overrides `codex` with an own double or this build's backend over explicit fake seams, never relying on `codex: undefined` alone. `backends.test.ts` audits the registry overlay, tripwire/`productionDefaults()` use, and Codex import boundaries from source.
- Pi stage tests use doubles/fenced fake subprocesses. The bootstrap suite's two unfenced calls inspect public exports/accessors only: no real session/model runtime.
- Await a run's end (`control wait`) before persistence assertions; terminal status can precede snapshot/entry.
- Manual `test/spikes/` harnesses stay outside the glob; native/provider qualification needs explicit agreement. Path checks, offline settings, and fetch preloads are not sandboxes. Retain version/platform and source-vs-measurement distinctions.

Dashboard DOM stays node-built and framework-free: no inline script/style/event attributes, HTML injection APIs, `eval`, `new Function`, CSS `url()` or `@import`. Preserve terminal escape/control stripping without transforming the host's tool data.
