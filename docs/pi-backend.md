# The Pi backend

The `pi` backend runs a headless Pi child in the host's working directory. It is registered beside `claude` and [`codex`](codex-backend.md); a [profile](profiles.md) or a call's `backend` selects it. There is no backend-disable variable, automatic fallback to Claude, or provider client implemented by Fusion.

Pi supports `plan`, `implement`, `ask`, and `security`. `ultracode` is Claude-only. Security is **disabled in `builtin`**: enable it through settings or a profile before calling or continuing it. A model parameter or environment variable does not enable a disabled role.

## Runtime requirements

- An npm Pi package the child can import, not a compiled Pi binary, and a compatible `node` on `PATH`. The SDK preload needs `node:module.registerHooks`; manual runs used Node 24.
- A provider and exact model id from the call, a recorded selection, or the role's settings. Pi roles have no default model. Models are written as `provider/model-id`, split at the first slash; the rest of the id is opaque.
- Credentials and model configuration the child can use. The host environment and its existing `auth.json` and `models.json` are inputs, not copied provider configuration.

A child resolves the SDK and `typebox` from the **host's own Pi package**, found through `getPackageDir()` and selected by `pi-sdk-resolve.mjs` before the bootstrap loads. It does not use a development dependency beside this extension just because one happens to be installed. No package is installed automatically. The bootstrap checks required public exports and returned shapes; a newer version is not assumed compatible merely because its version number is higher.

Host extensions and skills are not automatically loaded into children. In particular, a provider implemented only by a host extension is not automatically available there. Every shipped Pi role names no extension or skill resource, and there is no user parameter for adding one. A model in the host's picker can therefore still be refused by a child.

## Architecture and ownership

```text
Host Pi session
  extensions/fusion.ts
    mode, configuration, handles, writer slot, questions, branch records
      |
      +-- backends/claude.ts --> Claude Agent SDK --> Claude Code child
      |
      +-- backends/codex.ts --> codex app-server (host install) --> Codex child
      |     (see codex-backend.md)
      |
      +-- backends/pi-backend.ts
            storage --> prepare/restore --> task --> outcome
                           |                |
                           +---- pi-transport.ts ----+
                                      | native RPC   |
                                      v              |
                              node + SDK preload     |
                              pi-bootstrap.mjs       |
                              public Pi SDK session  |
                                      |              |
                              tools/model requests   |
                                                     |
                         process-tree.ts <-----------+
                         process launch and bounded cleanup
```

`backends/types.ts` is the SDK-neutral boundary. The host accepts a backend's outcome before publishing a session or checkpoint. The Pi backend composes the helpers; preparation and task handling each stop the child they own, while outcome mapping decides whether storage may be removed and whether success remains success.

No host module imports the child's bootstrap program. Shared startup constants live in `pi-bootstrap-protocol.mjs`. At extension load, Fusion checks the internal child marker, contracts, and bootstrap existence before registering backends. The marker makes Fusion register nothing in a Pi child, preventing recursive delegation.

See the [contributor module map](development.md#module-map) for file-level ownership.

## One call's lifecycle

```text
resolve role/model and session intent
  -> prepare storage and write bootstrap input
  -> launch child; readiness requires a correlated get_state answer
  -> verify session, selection, and usage baseline
       continuation: preflight file, navigate/fork, read identity + exact leaf
  -> send one task prompt; accept steers while it runs
  -> prompt acknowledged + child agent_settled
  -> close input and freeze turn evidence
  -> read state, leaf, usage, and last assistant text
  -> stop child once and inspect cleanup
  -> map outcome; remove or retain call storage
  -> host accepts outcome and records it
```

The bootstrap's `serving` diagnostic is not readiness. A prompt acknowledgement is not task completion. The child's `agent_settled` is used because `agent_end` can precede automatic retry, compaction, or queued work. Separately, the **host's** `agent_settled` handler shows the [activation reminder](fusion-command.md#turning-fusion-on-and-off); it does not stop children or switch Fusion off.

The bootstrap uses in-memory settings, explicit tool lists, automatic compaction, and Pi retry with three retries and a two-second base delay. Steering and follow-up modes are `one-at-a-time`. It reads no user or project settings file. The base system prompt is Pi's own, with exactly the role contract appended. Project/ancestor instruction files remain available; context from the Fusion child agent directory is excluded. When a workspace lies inside that agent directory, the same file can be both global context and a project ancestor: it is suppressed because public loader metadata cannot distinguish the two.

Each role's required tools and both internal control commands must be registered when the session is built. Resource discovery for extensions, skills, prompt templates, and themes is off. Internal callers can name existing local extension/skill paths, which are checked before SDK loading and accounted for after loading; URL/package specifiers, missing resources, undeclared bundled resources, prompt templates, themes, and this host's own extension are refused. These checks constrain composition, not what trusted code can do.

### What counts as completion

A successful task requires:

- The turn's records were observed, with no extension error and a finished assistant answer (`stop`). A failed tool call alone is evidence, not a failed run.
- The same session id, session file, model, and thinking level read back; both streaming and compaction are false; `pendingMessageCount` is **exactly `0`**. A missing, malformed, or positive count refuses success.
- The leaf moved, the usage readings yield a usable nonnegative delta, and the child can name its last assistant text.
- Shutdown reported an ending with no cleanup concern. A completed turn is demoted to failure if cleanup remains uncertain; its new leaf is not published as a trusted checkpoint.

There is no queue-draining loop, polling for completion, or automatic resend. Evidence freezes before awaiting an in-flight steer or shutting down, so late records cannot repair missing turn evidence. Successful usage is the task's delta against preparation, not the entire resumed session or the live stream's counts. Live activity and tool counts can still include shutdown-time records; they are progress, not the authority for the turn.

## Continuation and checkpoints

A Pi reference contains the session id, **absolute session file**, and a trusted checkpoint, with the model/thinking selection kept beside it. A continuation must repeat that selection unless the call explicitly overrides a permitted field. A level the constructor clamps to another level refuses the call rather than silently changing the recorded selection.

Before opening a recorded file, the bootstrap checks nonempty JSONL framing, a final newline, the current session-format version, the expected session id, and the checkpoint's presence. It refuses malformed, old-format, missing, or mismatched files rather than skipping lines, repairing them, migrating them, or selecting another session. This is not full entry-schema or tree validation, and it is a preflight snapshot, not protection against concurrent modification.

After opening, the host verifies the session, the control command's registration, its acknowledgement without extension error, and the exact resulting identity and leaf. A host fork must produce a different session id **and** file, and those returned values are used, never a predicted filename. These readbacks are sequential snapshots, not proof of the fork's bytes, parentage, or persistence on disk.

Checkpoints are the actual leaf at settlement, including compaction and non-assistant entries; Fusion does not rewrite them into assistant-message ids. Strict leaf checks can refuse legitimate Pi operations:

- Navigating to an already-current checkpoint can be a native no-op that passes.
- Moving to a user or custom-message target can leave the leaf at its parent rather than the target.
- Forking can strip a label checkpoint or append rebuilt labels beyond the target.
- Session construction can append a missing thinking-level entry, advancing the leaf and leaving a transcript change even if later startup checks refuse the call.

There is no alternative target, transcript surgery, or replay-based repair. Some shapes are source-inferred rather than measured; see [Evidence and limits](#evidence-and-limits). A refusal costs a continuation, not permission to guess a checkpoint. [Runs](runs.md#backends-in-a-record) owns the recovery policy: failed resumes preserve the previous successful record, failed forks can retain their verified fork identity at its starting checkpoint, and a new run with no verified session/checkpoint cannot be continued.

`/pi-fusion-navigate` and `/pi-fusion-fork` are internal conversation-history commands, not Git operations. Ordinary tasks beginning with either are refused; mentioning or quoting them inside a task is fine. Only restore handling sends them as commands. Neither navigation nor a host fork undoes working-tree changes.

## Storage and credentials

The root is the host's agent directory (`PI_CODING_AGENT_DIR`, normally `~/.pi/agent`):

```text
<host agent dir>/
  auth.json                     existing shared credentials; Pi may rotate them
  models.json                   existing user model configuration
  bin/                          existing host helpers; reused through child PATH
  pi-fusion/
    profiles.json               named role settings, separate from child storage
    settings.json               Fusion's own saved preferences (history), not Pi's settings.json
    history/                    optional host run history
    children/                   stable child agent directory
      bin/                      helpers Pi downloads for children
      catalog/models-store.json shared child model catalog
      sessions/<project-slug>/  durable Pi child transcripts
    calls/<role>-<random>/      one invocation, including each continuation
      bootstrap.json            launch input
      cache/jiti/               per-call compiler cache
      cache/node/               per-call Node cache when inherited as enabled
      auth.json                 private auth path when host has none
      models.json               absent placeholder path when host has none
```

Fusion creates its directories private (`0700`) and input/catalog files private (`0600`) on platforms where modes apply. Existing directories are checked for kind/access, not owner or mode, and storage checks follow symbolic links: this layout is not filesystem confinement. A fresh catalog is published as a complete directory through rename; an existing catalog is never emptied, overwritten, or parsed by Fusion. A catalog directory missing its store is refused with repair instructions rather than letting concurrent children recreate the file unlocked.

Stable sessions, catalog, and helper caches survive calls. Only the call directory is disposed of. Any cleanup concern retains it; removal that was attempted but failed adds a note and does not by itself turn successful work into failure. There is **no garbage collector or cleanup command**. Match a retained directory to a run by role and creation time, not handle: the backend has no handle to label it with. Remove it only after resolving the cleanup concern and establishing that nothing of the call is running.

Fusion creates neither a user `models.json` nor a user `auth.json`, copies no credential, and implements no auth store. When the host has no auth file, Pi is given the call's private path. When one exists, Pi reads that **same file** and may refresh and rewrite it in place. An adjacent `auth.json.lock` can arise from a read and is not proof of a write.

Shared-auth limits, from the measured SDK and source:

- The synchronous initial-read lock and asynchronous refresh lock have different retry/stale behavior; they are not one lock guarantee.
- Writes use `writeFileSync`, not a crash-atomic rename. A crash mid-write can truncate the file.
- Stale/compromised locks, external deletion/replacement, and failures after a remote token was minted are not qualified by the fixture measurements.
- Provider-specific credential fields survive only if the refresh callback returns them. Dummy-token fixtures do not prove behavior for every provider or real refresh-token family.

### Environment, network, and search helpers

The child inherits the host environment, provider keys included. Fusion retargets its agent directory and compiler caches into the layout above. Node's compile cache stays disabled when inherited absent/empty. `PI_OFFLINE` is copied **exactly**, not normalized into a boolean.

The host's `bin` is appended to the child's `PATH`, after existing entries, without trimming or deduplicating. An absent/empty `PATH`, or a host bin path containing the platform's path delimiter, is left unchanged; helper reuse is an optimization, not a reason to refuse the call. Fusion writes nothing into the host bin.

Children may make model requests, refresh their shared model catalog, or download helpers. Catalog refresh is permitted, not forced. In Pi 0.85.1 measurements, any defined `PI_OFFLINE` value suppressed catalog refresh, while the helper path treated `0` and empty as false and could still download. Do not treat offline mode as an egress boundary or assume all SDK paths parse it alike.

For shipped roles, `grep` and `find` use the public Pi factories with one bounded helper retry. One model-issued tool call makes **at most two builtin attempts**, retrying immediately only for an `Error` with the exact message:

```text
ripgrep (rg) is not available and could not be downloaded
fd is not available and could not be downloaded
```

A retry sends one fixed, credential-free update. Cancellation is checked before that notice and before the second attempt; a throwing notice callback propagates without retry. Other/reworded messages and non-`Error` failures pass through. This is text-based compatibility, not proof of error origin and not a repair of Pi's cold-cache shared-archive race. The second attempt re-enters the whole acquisition path and can download or contend again. There is no lock, warmup, preseed, sleep, SDK patch, or setting. An internal call naming an extension gets none of Fusion's custom tools; it must supply any requested question tool itself, so an explicit tool override is not silently replaced.

The earlier upstream helper proposal was declined and never submitted; no SDK source was modified. Current behavior is the Fusion-side wrapper, not that proposal.

## Cleanup and failure handling

Cleanup is bounded, best effort, and **not process isolation**. Before aborting a live task, transport makes one descendant observation, writes `clear_queue` then `abort`, spends a bounded wait on an admitted abort, and runs owned process-tree cleanup. That observation has its own process-table timeout and is additive before the cleanup deadline.

Discovery uses `ps` on Unix (`LC_ALL=C`) and PowerShell/CIM on Windows, with a default five-second table-read timeout and 16 MiB output cap. It follows parent-PID links, remembers descendants, and checks fresh identity/start stamps before signalling. Malformed rows are skipped; some parseable rows do not prove complete visibility. Table failures are sticky. If the root exits before its first verified live-root observation, discovery is unavailable even when a later table read succeeds.

There is no mandatory discovery preflight and no continuous survey. Observation cannot close the launch-to-handoff gap or recover descendants already re-parented before it. Remembered, identity-verified descendants can still be stopped after an observed root exits.

The reported concern labels are:

```text
root-unstoppable  stdio-held  discovery-unavailable  leftovers
skipped          deadline-hit  streams-unclosed     unverified
```

Any concern retains call storage and prevents publishing the completed turn's checkpoint. Cancellation remains cancellation, but it carries the same cleanup warning across controls, notices, reports, history, and dashboard. See [Aborting a run](runs.md#aborting-a-run) for manual attention. File changes are not rolled back. A survivor may hold ports, consume resources, cause external effects, or keep writing the shared tree after the writer slot is released; retaining call storage protects neither that tree nor external systems. Blindly retrying can repeat completed work.

### Reading a refusal

| What failed | What to check |
| --- | --- |
| No model / disabled role | Role settings first; configure `provider/model-id` and enable the role separately |
| SDK/startup | Importable host package, required public API, and `node` on `PATH` |
| Model/credential configuration | Every composed provider/configuration, not only the requested model; aggregate Pi errors can concern unused providers |
| Restore/checkpoint | Recorded file, current format, exact identity/leaf; start a new run rather than repair/replay automatically |
| Selection | Exact provider/model and requested thinking level; clamping refuses the call |
| Idle state / pending messages | Work did not satisfy completion; no drain or resend is attempted |
| Cleanup/storage warning | Inspect surviving processes and working-tree changes before retrying or deleting storage |

Startup diagnostics name the stage and SDK where known. Model/credential and construction refusals use fixed text rather than repeating foreign errors that can quote credentials. An absent models file is supported and is not itself a fault. Startup without a useful diagnostic can include a labelled **Child stderr** excerpt of the last 4 KiB; truncation is marked, empty stderr adds nothing. This is arbitrary child output, not redacted text. Reports, tool output, and diagnostic excerpts may be sensitive; fixed lifecycle wording is not a general redaction guarantee.

## Evidence and limits

The deterministic suite uses fakes/doubles and starts **no real Pi child or paid inference**. It tests host policy, parsing, sequencing, and mapping, not native Pi semantics. See [Development](development.md#test-strategy).

Manual evidence has narrower scopes:

| Harness | What it measures | Qualification boundary |
| --- | --- | --- |
| `pi-session-lifecycle.mjs`, `production` group | Real composition: continuation/fork gates, native questions, cancellation, detached-descendant cleanup | Linux/Node 24 on Pi 0.85.1 and 1.0.1; scripted loopback model, not a live provider |
| Other session-lifecycle groups | Public SDK sessions and fixture-generated controls | Their host record ledger is a simulation, not `fusion.ts` |
| `pi-config-writes.mjs` | Storage, bootstrap, resources, auth rotation, catalog/helper behavior | Not production transport; helper acceptance is Linux x64/Node 24.18.0/Pi 0.85.1 |
| `pi-auth.mjs` | Public model-runtime credential store | No session, model request, RPC, or registered backend; skew legs need explicit `--package` |
| `pi-profile-guidance.mjs` | Real host tool/prompt refresh and mode/profile changes | No model inference or child; does not prove a model follows guidance |

The session harness's full fifteen cases passed on Pi 1.0.1 on 2026-10-03, including production children using the host-SDK preload; a mixed-install case ran a child on 0.85.1 despite 1.0.1 beside the bootstrap. These are recorded manual measurements, not results of this documentation cleanup, and they qualify nothing about the Codex backend, whose [evidence](codex-backend.md#evidence) is separate. The production group injects a wrapped start that calls `startPiChild`; it does not route through `fusion.ts` or exercise the default start binding. Its exact `PI_OFFLINE=1` requirement is a harness precondition, not a sandbox; that group has no fetch guard or general network boundary.

Current/older assistant checkpoints, an assistant-target fork, and a user-target refusal have been measured in the production group. Custom-message/label checkpoints, reconstruction appending a missing thinking entry, a fork file absent on disk at inspection, and the actual leaf after the refused user-target move remain unmeasured there. Native behavior can differ across versions (including aborts with queued work and overflow recovery). No macOS, Windows, live-provider, paid-inference, or native `security` run is qualified by these results. Security routing/reviews are tested against in-memory backends only.

Manual commands and fixture safety scopes live in [Development](development.md#manual-harnesses). Historical plans, detailed round logs, deviations, and the declined upstream proposal remain in Git history. Their possible outside-root effects remain unknown where recorded; consolidating these docs authorizes no investigation or cleanup of those artifacts, real profiles, caches, or processes.
