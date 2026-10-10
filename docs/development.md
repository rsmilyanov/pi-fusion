# Development

## Commands

```bash
npm install
npm run typecheck
npm test
node --test test/control.test.ts
node --test --test-name-pattern="continue" test/control.test.ts
```

The suite uses Node's native TypeScript stripping and a 60-second per-test timeout. Typecheck is the only static check; there is no linter or formatter. `npm install` also installs the Claude Agent SDK's bundled binary (about 200 MB), but tests do not run that binary. The Codex backend adds no dependency: it uses the host's own `codex` at run time, and no test needs one installed.

Editing conventions and invariants live in [AGENTS.md](../AGENTS.md); vocabulary lives in [CONTEXT.md](../CONTEXT.md). Keep user-facing changes in the owning topic page. Code defines current behavior. Keep completed implementation plans out of the docs; retain TODOs, open issues, future proposals, and scoped evidence.

## Module map

```text
fusion.ts                     host lifecycle and registration
  +-- roles/profiles/store    capabilities and session configuration
  +-- backends/types.ts       SDK-neutral boundary
  |     +-- claude.ts         Claude SDK and stream/questions
  |     +-- pi-backend.ts     Pi composition (see below)
  |     +-- codex.ts          Codex app-server composition (registered)
  +-- process-tree.ts         launch and descendant cleanup
  +-- cards/dashboard        terminal and browser monitoring
  |     +-- dashboard-archive.ts  read-only history archive
  +-- changes/history/budget snapshots, persistence, accounting
  +-- handoff/review          prompts and eligibility
```

| Module under `extensions/` | Responsibility |
| --- | --- |
| `fusion.ts` | Tools/command, mode, configuration application, admission, handles, branch records, questions, controls, reviews, and host lifecycle handlers |
| `roles.ts` | Supported backends, writer-slot and review eligibility per role |
| `profiles.ts`, `profile-store.ts` | Captured legacy defaults, settings validation/copies, global profiles file and queued atomic replacement |
| `settings-store.ts` | Fusion's own `settings.json`: the saved history preference and plan context cap, validation, and file/memory stores over the profile store's queue and atomic write |
| `backends/types.ts` | Session references/intents, selection, request/outcome/event/callback shapes; imports nothing |
| `backends/claude.ts` | Claude SDK options, input/question bridges, stream loop; SDK concerns stay here |
| `backends/pi-binding.ts` | Pure Pi role/model/effort binding, contracts, and tool/resource lists |
| `backends/codex-binding.ts` | Pure role/selection/contract binding, sandbox and approval policy; imports only `types.ts` |
| `backends/codex-launch.ts` | POSIX binary lookup, inherited environment/cwd, predicted home and launch options; starts nothing |
| `backends/codex-protocol.ts` | Strict-minimum app-server readers, based on Codex 0.160.0 source; sandbox policy read for its tag only |
| `backends/codex-transport.ts` | Bounded JSONL/request lifecycle, scoped turn evidence, questions off the read loop, one-shot steers and owned shutdown; display notifications are unfiltered; imported only by Codex modules |
| `backends/codex.ts`, `codex-outcome.ts` | Lazy call composition, checks, steer queue and one shutdown; pure selection, disposition, checkpoint/baseline, usage and display mapping. Factory construction reads, locates and starts nothing. See [Codex architecture](codex-backend.md#architecture) and [evidence](codex-backend.md#evidence) |
| `backends/pi-storage.ts`, `pi-launch.ts` | Owned layout/catalog publication, call input, environment, launch options, and lazy host agent/package accessors |
| `backends/pi-bootstrap.mjs` | Child-only public SDK construction, strict input/resource/session checks, in-memory settings, and native RPC serving |
| `backends/pi-sdk-resolve.mjs`, `pi-bootstrap-protocol.mjs` | Child resolve preload; separately, import-free startup constants shared with transport |
| `backends/pi-control-extension.mjs`, `pi-session-restore.ts` | Child navigation/fork commands and host restore/readback sequence |
| `backends/pi-question-tool.mjs`, `pi-question-routing.ts` | Blocking child input tool and host dialog arbitration |
| `backends/pi-helper-retry.mjs` | One bounded retry around public search tools, not an SDK patch |
| `backends/pi-transport.ts` | Native RPC framing/correlation, bounded writer/dialogs, readiness/turn lifecycle, and shutdown |
| `backends/pi-prepare.ts`, `pi-task.ts` | Preparation identity/selection/usage baseline; one task's evidence, steers, readbacks, and single stop |
| `backends/pi-outcome.ts`, `pi-backend.ts` | Pure diagnostics/disposition/demotion/progress mapping; composition and finalization |
| `process-tree.ts` | SDK-independent process launching and legacy/owned descendant cleanup |
| `cards.ts`, `dashboard.ts`, `dashboard/` | Terminal rendering/widget; bounded store, read-only HTTP server, plain DOM page |
| `dashboard-archive.ts` | Archive eligibility from branch evidence (recorded or request lineage); bounded per-record summaries and identity cache; lazy detail re-read from disk; 30-entry keyset pages; reads through `History` and writes nothing |
| `changes.ts`, `history.ts`, `budget.ts` | Git snapshots; opt-in host run history; running-total cost ledger |
| `handoff.ts`, `review.ts` | Plan cap/model-change handoff; independent review eligibility and quoted prompt data |

Role behavior belongs in `contracts/*.md`. Review **selection** belongs in `fusion.ts`: every review uses the session's configured `ask` backend/model/effort, not the reviewed role's backend or model. Backend architecture, storage, and runtime limitations are in [Pi backend](pi-backend.md) and [Codex backend](codex-backend.md).

## Test strategy

`npm test` starts **no real Claude/Pi/Codex child and no paid inference**, and no test host call locates a native `codex`. It tests policy/protocols with fakes and doubles. A fake subprocess is still a process; it is not a native backend session.

| Layer | Fixture / tests | What a pass establishes |
| --- | --- | --- |
| Claude backend | `fake-claude.mjs`, `child.test.ts`, backend tests | Real SDK objects speaking stream-json to a fake binary |
| Host lifecycle | `fake-pi-backend.ts`, `lifecycle.test.ts`, controls/session/routing/records tests | Admission, writer slot, records, continuations, questions, reviews, and cross-backend policy |
| Pi native protocol | `fake-pi.mjs`, `pi-transport.test.ts`, `pi-backend-transport.test.ts` | Host framing, request/event order, composition, and process cleanup against literal RPC replies |
| Pi helper stages | Binding/storage/launch/bootstrap/restore/question/prepare/task/outcome/backend tests | Validation, sequencing, gates, accounting, and mapping against scripted doubles or fenced fake subprocesses |
| Codex app-server protocol | `fake-codex.mjs`, `codex-transport.test.ts` | Readers, framing, correlation, scoped turn/question evidence, denials, failures and cleanup against literal JSON-RPC from a builtins-only fake launched by path |
| Codex backend composition | `fake-codex.mjs`, `codex-backend.test.ts` | Fresh/resume/fork sequencing, tip/readback/selection checks, checkpoint/baseline and per-call accounting, steers/questions, demotion, cancellation and one shutdown through injected fake seams |
| Codex qualification harness | `codex-harness.test.ts`, `test/spikes/codex-app-server*.mjs` | CLI/guard and PASS/FAIL/UNPROVEN/SKIP rules, usage/steer/question verdicts, explicit `--fake` cases, request-shape parity and fixture retention. Guards never pass a case; fake passes are not native qualification |
| Codex binding and host | `codex-binding.test.ts`, routing/lifecycle/profiles/dashboard/browser Codex cases | Pure role binding; routing/handoffs, controls, records, presentation, accounting and review with an in-memory double; delegated runs, failed resumes, reviews, steers and answered/cancelled questions with the fake-backed backend |
| Configuration/mode | `profiles.test.ts` | Settings/store/commands, off-by-default, reminder, refresh/rollback, and allow-list preservation against a modeled host |
| Presentation/persistence | Cards, dashboard, dashboard-archive, browser, history, changes, budget, review tests | Bounded/safe rendering and storage, archive eligibility/paging/pruning against real temporary history, Git snapshots, cost ledger, and review prompts/eligibility |

```text
extension test host
  +-- tripwires()                 -> Pi + Codex entry points throw
  |     +-- { pi: own }           -> injected Pi double/fake
  |     +-- { codex: own }        -> injected Codex double/fake
  +-- productionDefaults()       -> Pi missing-model refusals only
        +-- Codex tripwire kept  -> no native Codex entry
```

- Tripwires record every reach. File-level assertions catch accidental routing even if the host turns the throw into a report.
- Registry overlays spread injected entries last; explicit `undefined` removes a default without fallback. A routed Codex case needs an own double/fake, never `codex: undefined` alone.
- The two `productionDefaults()` hosts never run a backend. They refuse with Pi/Codex selection variables or `PI_FUSION_CODEX_BIN` set; Codex needs a tripwire because an omitted model uses its host default.
- `test/backends.test.ts` audits registrations, overlays and import boundaries, and constructs the default Codex backend without calling `run`. Every registration uses `tripwires()` or `productionDefaults()`, never both.
- Every host injects a memory profile store and a memory settings store: no user `profiles.json` or `settings.json` reads/writes. `test/backends.test.ts` audits that each registration names a settings store. `control.test.ts` and `extension.test.ts`, whose cases assert history behavior, clear `PI_FUSION_HISTORY` at load so the shell's value cannot change them; cases that need it set it themselves. Codex tests use no native binary, home, auth or `PATH` lookup.

[`test/fake-codex.mjs`](../test/fake-codex.mjs) is the literal app-server layer, separate from in-memory binding doubles. `FAKE_CODEX_SCENARIO` selects behavior; `FAKE_CODEX_LOG` records each input line in a per-case temporary file. Its other variables script replies, persisted-thread history, usage, steers and questions; the fixture source owns that catalogue. None is a production request field.

Tests launch the fake by path with the host's Node, the SDK fence and app-server arguments, using narrowed bounds and cleanup graces. Nothing locates a Codex binary.

Activate Fusion through the registered mode tool, not a default-on test option. Security tests must explicitly enable that role. Add scenarios to `fake-claude.mjs` rather than mocking the SDK; `FAKE_CLAUDE_SCENARIO` selects one, `PI_FUSION_CLAUDE_BIN` selects the fake, and `FAKE_CLAUDE_LOG` records its stdin.

A terminal state can precede a run's final Git snapshot and branch entry. Wait for the run's own end (`control wait`) before asserting persistence, not merely for `status: done`.

`test/backends.test.ts` and related static checks use the TypeScript parser/scanner to pin registration, SDK import boundaries, and loader order. They are source checks, not evidence that a real install or default start binding was exercised. The bootstrap suite's two unfenced calls inspect public exports and `getAgentDir()` only; neither constructs a session/model runtime. Its SDK fence is a resolution rule, not a sandbox.

The dashboard browser test looks for `PI_FUSION_CHROME`, usual platform paths, then Chromium on `PATH`, and skips if absent. Static dashboard checks prohibit inline script/style/event attributes, HTML injection APIs, `eval`, `new Function`, CSS `url()` and `@import`. Build DOM nodes individually.

## Manual harnesses

These stay under `test/spikes/`, outside the default test glob. Run them only as an explicitly agreed qualification step, one at a time in the foreground. Every harness below except the Codex one is a Pi harness; none qualifies Claude.

### Codex app-server

```bash
node test/spikes/codex-app-server.mjs --list                    # catalogue only; exits 2
node test/spikes/codex-app-server.mjs --run --case model-free   # Q1, Q2, Q7, Q9
node test/spikes/codex-app-server.mjs --run --case Q6 --keep
node test/spikes/codex-app-server.mjs --run --case Q2 --model <id> # named-model readback, no turn
node test/spikes/codex-app-server.mjs --run --fake --case Q1,Q2,Q4,Q6,Q7,Q9   # NOT NATIVE
node test/spikes/codex-app-server.mjs --run --fake --case Q14                  # NOT NATIVE
node test/spikes/codex-app-server.mjs --run --fake --case Q10,Q11,Q12,Q13,Q19  # G2 cases, NOT NATIVE
node test/spikes/codex-app-server.mjs --run --fake --case Q15,Q16              # G3 cases, NOT NATIVE
```

- Native runs inherit the user's Codex install, environment, home, configuration, login, MCP, remote-control and multi-agent settings **unsanitized**, as production does. Do not use the sanitized Pi controller below or add credentials, copied homes or API keys.
- Model cases make provider requests on that login/quota with **unknown USD cost**. Each native run needs its own explicit agreement; threads may leave rollouts, logs or state in the existing Codex home.
- Nothing starts without `--run` and an explicit `--case`; argument guards exit 2 before loading production modules. `--fake` is deterministic evidence, never native qualification.
- The [qualification harness section](codex-backend.md#qualification-harness) owns cases and verdict rules. Its pure half is `codex-app-server-cases.mjs`; automated coverage is in the [test-layer table](#test-strategy).
- Record Codex/platform/Node versions, selected and skipped cases, exit status, **full output**, and any kept fixture root. Native results live only in [Codex evidence](codex-backend.md#evidence).

For the Pi harnesses, use direct Node, not `npx`, with dependencies already installed. Record Node/Pi versions, selected cases, exit status, stdout/stderr, skipped cases, and the kept fixture root. A short success excerpt is not a substitute for reading the complete selected run's footer and evidence. Use a sanitized controller environment as well as each harness's own synthesized child environment; do not supply real credentials or reuse a real profile.

### Session lifecycle

```bash
node test/spikes/pi-session-lifecycle.mjs --list                  # catalogue only; exits 2
node test/spikes/pi-session-lifecycle.mjs --case production --keep
node test/spikes/pi-session-lifecycle.mjs --case row3-fork-at --keep
node test/spikes/pi-session-lifecycle.mjs --case=stage-b --keep
node test/spikes/pi-session-lifecycle.mjs --keep                   # all cases
```

`stage-a` and `stage-b` use generated public-SDK bootstraps and a **simulated** host record ledger. `production` drives `createPiBackend` through storage, bootstrap, transport, restore, questions, task, outcome, and cleanup. Its wrapped start passes the launch unchanged to `startPiChild`; it does not exercise `fusion.ts` routing or the default start binding.

Production launches require the composed environment to carry exactly `PI_OFFLINE=1`, root-contained writable/input paths, and no composed catalog base URL. A scripted loopback service is the only model endpoint configured; there is no fetch guard/egress boundary in this group. PID files are fixture assertion/emergency-cleanup oracles, never inputs to production discovery. The detached case is Linux-only. Launch-to-handoff and descendant-to-pid-file windows remain limitations, not isolation guarantees.

Exit 0 means every selected case passed, 1 means failed/unproven, and 2 means no case ran (including `--list`, unmatched/missing selectors, or unknown arguments). Both `--case value` and `--case=value` are accepted. `--keep` retains the fixture root for inspection.

### Configuration, resources, auth, and helpers

```bash
node test/spikes/pi-config-writes.mjs --stage impl --keep
# Read the implementation result before starting a separate historical run:
node test/spikes/pi-config-writes.mjs --stage historical --keep
node test/spikes/pi-config-writes.mjs --stage impl --case P7 --keep
```

Stages are `impl`, `historical`, or `all` (default). `--case` selects a case/group; `--pi <absolute CLI path>` adds an installed-CLI comparison where the historical cases support it. The implementation stage drives storage/input/launch/bootstrap through `pi-storage-caller.mjs`, **not production transport**. P5 covers explicit resources and preflight controls, P6 fixture OAuth rotation/failure, and P7 catalog/helper acquisition and bounded-retry behavior.

`pi-fetch-guard.mjs` wraps only `globalThis.fetch` in preloaded fixture processes, refuses unowned origins, and prevents automatic redirects. It covers no raw socket, other client, or subprocess. P7's `pi-helper-interposer.mjs` loads **after** that guard and maps exact release/asset URLs to owned loopback listeners; it is not a proxy or sandbox. P5's SDK fence and generated `npm`/`git` shims are narrow controls, not filesystem/network confinement.

A native retry notice proves the wrapper matched its failure branch, not an independently counted number of underlying executions or an exact failing syscall. The at-most-two bound comes from wrapper source and fake tests. A recovered call is not relabelled first-attempt success; helper acceptance remains scoped to Linux x64/Node 24.18.0/Pi 0.85.1.

### Credential store and profile guidance

```bash
node test/spikes/pi-auth.mjs --keep
node test/spikes/pi-auth.mjs --case A3 --keep
node test/spikes/pi-auth.mjs --case A1,A5 --keep
node test/spikes/pi-auth.mjs --package /absolute/path/to/another/pi-package --keep
node test/spikes/pi-auth.mjs --case C1 --keep
node test/spikes/pi-profile-guidance.mjs
```

Auth uses `pi-auth-driver.mjs` and a loopback token service with literal dummy credentials. It constructs a public model runtime/credential store, not a session, model request, RPC client, or registered backend. `--case` accepts comma-separated names/groups; skew legs are **NOT RUN** unless `--package` names another installed Pi package. C1 is a separate fake-package leakage control, not native SDK evidence. The driver's observation code does not read shared credential bytes; the controller snapshots them only before/after all drivers have exited.

Profile guidance constructs a real host session under a throwaway root and tests mode/profile changes through slash commands without inference. Mode tools are invoked directly, outside an agent loop: this measures resulting tools/prompts, not a model choosing or obeying them. It starts no child and configures no provider.

### Sanitized controller example (Unix)

Replace both absolute paths before running. This preserves `PATH` deliberately, clears other inherited variables, owns normal home/temp/cache/Git paths, keeps full logs, and runs one selected harness directly:

```bash
env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  /bin/bash --noprofile --norc -c '
    umask 077
    root="$(mktemp -d)" || exit 1
    mkdir -p "$root"/{home,tmp,config,cache,data,state,appdata,localappdata,agent,work,logs,git-template,git-hooks}
    : > "$root/gitconfig"
    export HOME="$root/home" USERPROFILE="$root/home"
    export TMPDIR="$root/tmp" TMP="$root/tmp" TEMP="$root/tmp"
    export XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache"
    export XDG_DATA_HOME="$root/data" XDG_STATE_HOME="$root/state"
    export APPDATA="$root/appdata" LOCALAPPDATA="$root/localappdata"
    export PI_CODING_AGENT_DIR="$root/agent" PI_OFFLINE=1
    export JITI_FS_CACHE="$root/cache/jiti" NODE_COMPILE_CACHE="$root/cache/node"
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$root/gitconfig"
    export GIT_TEMPLATE_DIR="$root/git-template" GIT_TERMINAL_PROMPT=0
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0="$root/git-hooks"
    cd "$root/work" || exit 1
    /absolute/path/to/node /absolute/path/to/pi-fusion/test/spikes/pi-session-lifecycle.mjs \
      --case production --keep > "$root/logs/stdout" 2> "$root/logs/stderr"
    status=$?
    printf "root=%s exit=%s\n" "$root" "$status"
    exit "$status"
  '
```

Use a fresh sanitized setup for another qualification stage. Retargeting customary paths and disabling inherited Git configuration do not disable repository-local configuration or confine every filesystem write. Harness cleanup is bounded and owned, not a universal process kill. Inspect retained fixtures only within the agreed scope.

## Evidence discipline

```text
source inspection       -> what the inspected version's code says
fake / double test      -> behavior against scripted shapes
manual native measurement -> behavior on the recorded host/version

Neither source nor fake evidence becomes native qualification.
No measurement guarantees another version, platform or provider.
```

Record versions/platforms and skipped cases in the owning [Pi evidence](pi-backend.md#evidence-and-limits) or [Codex evidence](codex-backend.md#evidence) section. Link those results rather than copying qualification summaries here.

Historical round logs remain in Git; code defines current behavior. Earlier deviations and possible outside-root effects remain unknown where recorded. Documentation cleanup authorizes no investigation or cleanup of those artifacts, real profiles, caches, or processes, and no upstream issue submission. The declined helper proposal was never submitted and no SDK source was modified.
