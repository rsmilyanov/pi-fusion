# The Codex backend

**Registered and opt-in.** Codex supports `plan`, `implement`, and `ask`; builtin routes no role there. Name `backend: "codex"` or configure a role in [settings](profiles.md). Code defines current behavior; [Evidence](#evidence) records the narrower qualification scope.

## Architecture

```text
extensions/fusion.ts                   handles, routing, questions, records
  |
  +-- codex-binding.ts                 role, selection, contract, sandbox
  +-- codex.ts                         call order, steer queue, one shutdown
        +-- codex-launch.ts            host binary/environment/cwd
        +-- codex-transport.ts         bounded stdio JSON-RPC, owned cleanup
        |     +-- codex-protocol.ts    strict-minimum readers
        |     +-- process-tree.ts      process launch/descendant cleanup
        +-- codex-outcome.ts           checks, usage, disposition, display
                  |
                  v
          host recordDecision          accepts outcome before persistence
```

Sources: [`codex.ts`](../extensions/backends/codex.ts), [`codex-outcome.ts`](../extensions/backends/codex-outcome.ts), and the [module map](development.md#module-map). There is no Codex SDK or npm dependency. Transport reuses Pi's generic framing/timer helpers, not its backend lifecycle.

`createCodexBackend()` reads, locates, and starts nothing. Binary lookup happens only when a run starts; an absent Codex install does not prevent Fusion, Claude, or Pi from loading.

## What this build runs

| Capability | Behavior |
| --- | --- |
| Roles | `plan` and `implement`: `workspace-write`; `ask` in either mode: `read-only`; approval policy `never` |
| Plan scope | Shared contract permits only its own notes/scratch files, as on every backend |
| Unavailable | `ultracode`, `security`, `fresh` outside `plan`, or `mode` outside `ask`: refused before admission |
| Sessions | Fresh threads; resume/fork only with a trusted checkpoint, paired usage baseline, and repeatable selection |
| Questions | Required callback; whole-connection experimental API opt-in; fresh threads register `ask_orchestrator`, continuations trust its restoration ([Questions](questions.md#on-codex)) |
| Controls | `status`, `wait`, `cancel`, and one-shot steers to the admitted turn |
| Writer slot | `plan`/`implement` hold the single file-changing slot across backends; `ask` may run beside them |
| Reviews | Fresh configured `ask` run; inherits nothing from its source; disabled ask refuses manual review and quietly skips automatic review |
| Follow-up | Use `fusion` with `continue`, or start a new run carrying the report as context |

Stats/status/dashboard offer `codex resume <thread id>` from the accepted outcome only. This is an intended manual recovery hint, **not natively measured**. Forks name their own thread. Shell-unsafe ids are single-quoted; ids beginning with `-` follow `--`.

## Inheritance, not isolation

Source: [`codex-launch.ts`](../extensions/backends/codex-launch.ts).

```text
host install and environment (unchanged)
  +-- PI_FUSION_CODEX_BIN, else first executable codex on PATH
  +-- host working directory -> child's process cwd
  +-- CODEX_HOME, else user's ~/.codex
        +-- configuration / profiles / login
        +-- MCP / remote-control / multi-agent settings
        +-- rollouts, logs and state may remain here

Fusion supplies role sandbox mode + approvalPolicy: never
Fusion does not isolate or re-audit the inherited configuration
```

- No install, download, login, credential copy, configuration write, or separate API key. Home prediction is compared with the child's reported home, not created or read by Fusion.
- Lookup/launch are POSIX-only. Windows refuses when a run starts; macOS executes the same code but is unmeasured. Linux qualification is limited to the host/version in [Evidence](#evidence).
- Writable roots, network access, shell policy, MCP, remote-control and multi-agent features remain the user's. Enabled servers/features are live; subagent work and spend are outside Fusion's reports.
- Only the reported sandbox **tag** is checked against the role. Continuations request/check the mode again; no historical sandbox record or comparison exists.
- Hosted web search is inherited, neither enabled nor disabled by Fusion. Q4 observed no search item; that is not proof that search is disabled. The shared ask contract requires sources or an explicit unchecked fact.

**Requests omit cwd.** In Codex 0.160.0 source, naming a cwd can write a trust entry for an untrusted writable project. Fusion instead binds the process cwd by realpath and checks the reported cwd. Q2/Q9 measured this without changing `config.toml` on one host. A cwd-naming fallback is **not implemented** and would require explicit consent because of that possible trust write.

## One call

Source: [`runCodexCall` / `drive`](../extensions/backends/codex.ts).

```text
map new/resume/fork intent
  | invalid continuation -> refuse before contract read, lookup or spawn
  | already cancelled    -> finish without starting a child
  | no callable question callback -> refuse before contract read, lookup or spawn
  v
read shared role contract only
  -> locate binary / compose launch / read client version
  -> spawn -> initialize -> initialized -> verify reported home
  v
thread/start OR thread/resume OR thread/fork
  -> verify thread, cwd realpath, sandbox tag, approval, named model/provider
  -> continuation: thread/turns/list -> verify latest completed tip
  v
turn/start (prompt, optional effort)
  +-- queued steers -> this turn, once each
  +-- own-turn ask_orchestrator -> host question -> one tool result
  +-- scoped notifications -> turn evidence, separate from live display
  v
turn.done -> close input -> completed result / terminal-error check
  -> thread/read barrier -> final snapshot + idle/selection/usage checks
  -> one shutdown -> outcome mapping -> host recordDecision
```

| Request | Fields Fusion supplies |
| --- | --- |
| Thread start | Optional model; sandbox, approval, shared developer instructions; the dynamic question tool |
| Resume | Thread id, recorded provider/selection, role fields, `excludeTurns: true`; no tool registration |
| Fork | Source thread, checkpoint as `lastTurnId`, recorded provider/selection, role fields, `excludeTurns: true`; no tool registration |
| Turn start | Thread id, text input, optional effort; no model/provider/cwd/sandbox |
| Steer | Thread id, admitted turn as `expectedTurnId`, text input |

No request supplies cwd, a config map, base instructions, effort on a thread request, or another dynamic tool. Nothing rewinds or replays; Fusion writes no trust/configuration/auth file.

Approval requests are declined and listed as denied tools. Unsupported server requests fail the run. An unhostable `ask_orchestrator` call instead receives `success: false` and the run may continue; [Questions](questions.md#on-codex) owns that flow.

The live display filters unfiltered transport notifications to the verified primary thread and admitted turn. Foreign/subagent final text, usage and tool calls do not enter its report or monitor.

## Continuation and fork

Sources: [`codexSession`](../extensions/backends/codex-outcome.ts), [`drive`](../extensions/backends/codex.ts), and [host recovery policy](runs.md#recovery-policy).

```text
record: tagged thread + checkpoint + baseline + selection/provider
  | missing/incomplete -> readable only; never upgraded or guessed
  v
same host session                  another host session
  thread/resume                      thread/fork through checkpoint
  latest tip == checkpoint?          different thread id?
  tip completed?                     latest tip completed?
    no -> refuse before turn/start     no -> refuse before turn/start
    yes -> one new turn                yes -> own starting checkpoint
                                                -> one new turn

success -> own admitted completed turn + cumulative total there
failure -> resume: previous record unchanged
           fork: own verified starting tip, no baseline (readable only)
```

- Mapping rejects another backend's reference or a missing checkpoint/baseline **before** reading contracts, locating a binary, or spawning.
- Resume needs the exact recorded completed tip. A failed/cancelled admitted turn may move the actual tip even though the previous record remains authoritative. Later resumes then refuse; nothing automatically forks, rewinds, or replays to recover it.
- Fork must name a new thread and, when reported, the correct source. Its completed starting tip is that new thread's own evidence, never assumed to equal the source checkpoint. A fork without a completed tip remains readable under its new id alone.
- A failed fork after a verified starting tip keeps that tip without a baseline, so it cannot continue. A success settles checkpoint and baseline together on its own admitted turn.
- Recovery is a new run without `continue`, carrying the report; `plan` also needs `fresh: true`. Older records without the checkpoint/baseline pair are never upgraded.

Native coverage is in [G2](#g2-cases) and [G3](#g3-cases). Forking through an older checkpoint behind the source's current tip is supported from the inspected source but unmeasured natively.

## Plan runs

Source: host routing/handoff in [`fusion.ts`](../extensions/fusion.ts) and [`handoff.ts`](../extensions/handoff.ts). No native `plan` call was measured.

```text
plan call without continue
  +-- fresh: true / no earlier plan -> new thread
  +-- latest Codex plan
        +-- unusable record         -> refuse; never choose an older plan
        +-- different model or cap  -> fresh thread + last report
        +-- otherwise               -> resume/fork exact recorded checkpoint

explicit continue -> exact named run; warn at cap, never hand off
```

The role uses only `contracts/plan.md` and `workspace-write`, with the required [question callback](questions.md#on-codex). Reading a record cannot prove its thread is still at the checkpoint; the backend checks the tip before a turn. A continuation refused for an unusable record or moved tip does not trigger a fallback handoff; use `fresh: true`.

A cap handoff carries recorded model and effort unless overridden; a model handoff uses the named model and call/configured effort. **No handoff carries the provider:** a fresh thread uses the host's own Codex provider, unchecked against the earlier run. Only continuations pin it. See [The context cap](runs.md#the-context-cap).

## Steers

Source: [`CodexSteerQueue`](../extensions/backends/codex.ts). Native scope: [G2 Q13](#g2-cases), one `ask` steer on the historical no-callback connection.

```text
control message / /fusion steer
  +-- question waiting -> answer, not steer
  +-- input closed     -> run ending
  +-- 32 queued        -> refuse now; nothing retained
  +-- input open       -> queue
                           -> admitted turn -> one turn/steer attempt
                           -> close/cancel  -> drop anything unsent

accepted for delivery != model read it != model acted on it
```

The input opens at admission; messages wait until the turn is named, then send in order. It closes on turn end, call end, or cancellation. No retry, replay, guessed turn, or resend.

| Report count | Meaning |
| --- | --- |
| Taken into turn input | Child accepted it; delivery only |
| Refused | Child answered with an error |
| Sent with no answer | Delivery is unknown after the request bound/child exit; a steer timeout alone does not end the run |
| Not sent | Transport would not send it |
| Dropped | Still queued when input closed |

Controls say **queued**, not read. A full open queue refuses immediately; it keeps nothing for a later retry.

## Selection

Sources: [`codexRole`](../extensions/backends/codex-binding.ts), [`verifySelection`](../extensions/backends/codex-outcome.ts), and [configuration precedence](configuration.md#the-codex-backends-variables).

```text
model / effort
  call override
    -> recorded selection for continuation
    -> role settings (or captured defaults for another-backend override)
    -> unset: host's Codex configuration chooses

provider
  fresh thread / handoff -> host's Codex configuration
  continuation          -> recorded provider, even with a model override
```

An omitted model displays `host default`, then `host default -> <model>` after readback; the label is never sent as a model. Requested effort goes only on turn/start. Models/efforts receive lexical binding checks, not a model inventory or pre-admission capability probe.

Configured selection comes from the thread start/resume/fork answer and post-turn thread/read, **not** per-turn reroute telemetry.

| Readback | Decision |
| --- | --- |
| Model null | Keep start answer's model, with a note |
| Model different / provider different | Fail |
| Named effort missing or different | Fail |
| Unnamed effort | Readback, else start answer with a note, else none with a note |
| Explicit-model turn rerouted | Fail |
| Host-default turn rerouted | Keep configured selection; note from/to/reason |

Notes are appended as `Note: ...` paragraphs.

## Success, failure and cleanup

Sources: [`drive`](../extensions/backends/codex.ts), [`finishCodexRun` / `exitConcerns`](../extensions/backends/codex-outcome.ts).

| Checkpoint in the code path | Checks made |
| --- | --- |
| `turn.done` | Admitted turn's completed result and terminal-error count |
| Post-turn barrier | Non-empty own-turn final message, usable usage, total at/above baseline, cwd, idle state and selection |
| Outcome mapping | Shutdown report, actual clean exit, transport failure and cleanup concerns |

```text
verified work + clean shutdown -> success checkpoint + baseline
verified work + cleanup concern -> failure; thread/selection readable only
aborted / failed outcome       -> no new successful checkpoint
                                 (failed fork may keep its starting tip)
```

Current check gaps, from source inspection (not native measurement):

| Gap | Consequence |
| --- | --- |
| Signal abort during shutdown is not rechecked before mapping | A previously successful verdict can still publish a checkpoint |
| Barrier snapshot's terminal errors and a `completed` result's non-null completion error are not checked | These errors can escape the success gate |

Retryable error notices are not completion. Failed, self-interrupted, crashed, timed-out and unsupported-request turns fail; turn/start is never retried. Cancellation requests interrupt for a known turn and bounded shutdown, not rollback.

Preparation/call composition owns one shutdown. A transport already finalized returns the same memoized report. Outcome mapping alone composes the cleanup notice and demotes unsafe success; verified selection by itself is never success or persistence authority.

Cleanup is **bounded best effort, not isolation**. Discovery failure is sticky; there is no mandatory preflight or background survey. A survivor can keep writing after the writer slot is released. Inspect survivors and working-tree/external effects before retrying. File changes are not undone; see [manual attention](runs.md#aborting-a-run).

## Records and usage

Sources: [`codex-outcome.ts`](../extensions/backends/codex-outcome.ts), shared record grammar in [`types.ts`](../extensions/backends/types.ts), and host [`recordDecision`](../extensions/fusion.ts).

```text
accepted Codex record
  reference: backend=codex, sessionId=thread
             checkpoint=own admitted completed turn
             baseline=cumulative total at that turn's barrier
  selection: configured model + provider + optional effort

per-call usage: fresh -> final total
               continued -> final total - recorded baseline
context share: latest last.inputTokens / modelContextWindow
```

- The five core baseline counts are input, cached input, output, reasoning output and total: non-negative safe integers, cached input within input. Checkpoint/baseline are paired; a baseline without a checkpoint is unreadable. Scalar session/checkpoint/model/effort fields are diagnostics, not Codex persistence authority.
- Usage is never a sum of `last` notifications. Re-emitted totals replace earlier counts. Any core total below its baseline prevents usage publication for that update and fails final verification without a new checkpoint/baseline.
- Input already includes cached input; cache read is displayed beside it, never added again.
- Cache write is optional diagnostic data, not a success/budget/cap gate. The reader treats an omitted value as 0. Continued display uses its difference only with a recorded value and non-decreasing total; otherwise displayed 0 means **unobserved**, not a measured zero.
- **Cache-write vs input remains unqualified:** Q14 reported no positive cache write. Fusion leaves input unchanged and does not sum/clamp cache write against it.
- Context publishes only with positive latest response input and window; otherwise both clear, the share is unknown and no cap applies. It is neither cumulative total nor per-call delta nor exact occupancy.
- Usage covers only the parent thread. Subagent usage/spend is outside the report. Cost is **unknown**, never estimated or represented as zero.
- Tokens count toward the host session ledger; the dollar estimate excludes Codex and says so. The first admitted Codex run warns once when USD controls are configured. Those controls act on priced Claude/Pi totals, not Codex spend; see [Budget](configuration.md#session-usage-and-budget).

## Evidence

Qualification is a record of measurements, not an implementation roadmap. G1/G2/G3 are historical case-group names.

| Kind | Boundary |
| --- | --- |
| Source inspection | Codex **0.160.0** app-server shapes, including stable developer instructions/model/effort fields, continuation/steer methods and experimental dynamic tools/restoration; later versions may differ |
| Deterministic fake/double | Literal JSON-RPC via `test/fake-codex.mjs` and in-memory hosts; verifies sequencing/checks/mapping against scripted shapes, not native semantics. See [test layers](development.md#test-strategy) |
| Manual native measurement | The cases below on **one Linux x64 host**, Node **24.18**, on **2026-10-04**; child user agent reported app-server **0.160**, not independently verified |

Measured host-default selection: `gpt-6.1-sol`, provider `openai`, effort `high` where verified. Other platforms/versions are unmeasured; no model, provider or changed-default switch was qualified.

| Group | Recorded native coverage | Result / measured commit |
| --- | --- | --- |
| [G1](#g1-cases) | Fresh `implement`/`ask`, handshake/start/readback, cancellation and owned shutdown | PASS: Q1/Q2/Q3/Q4/Q7/Q9 at `c2f2477`; Q6 at `cf8f0cd` |
| [Q14](#q14-usage-measurement) | Two-turn fresh-thread usage observation, outside G1/G2 | PASS once at `625061e` |
| [G2](#g2-cases) | `ask` resume, moved-tip refusal, current-tip fork, one steer and recorded same-model round trip | PASS: Q10/Q11/Q12/Q13/Q19 at `cff6a9e` |
| [G3](#g3-cases) | `ask` questions on fresh/resumed/forked threads, and waiting-question cancellation | PASS: Q15/Q16 at `84aa4ff` |

```text
G1 / Q14 / G2 measurements: no question callback
  -> stable connection; no experimentalApi or dynamic tools

shipping delegations / G3 measurements: question callback
  -> whole-connection experimentalApi opt-in
  -> fresh thread: register ask_orchestrator
  -> resumed/forked thread: restore tool only if started with it
```

Earlier passes remain historical evidence of the stable connection. G3 re-measured fresh/resume/fork questions and waiting cancellation, **not** every G1/G2 behavior: steering and moved-tip refusal were not re-measured in the shipping opt-in shape.

Unmeasured natively:

- `plan` calls/handoffs; `implement` continuations, steers and questions; callback admission and shared-contract-only continuations; host answer/writer/lifecycle races (fake/double-tested).
- Fork through an older checkpoint, hosted search, named-effort override (Q3b not run), cache-write/input relationship, exact context occupancy, USD cost, or CLI recovery via `codex resume`.
- Host answer UI, a question abandoned or held until timeout, other versions/platforms, or provider/model/default switches.
- Sandbox/kernel policy was not audited. Whole-connection experimental opt-in may enable other features; nothing claims isolation or absence of other network/inference activity.

### Qualification harness

[`test/spikes/codex-app-server.mjs`](../test/spikes/codex-app-server.mjs) owns execution; [`codex-app-server-cases.mjs`](../test/spikes/codex-app-server-cases.mjs) owns CLI/catalogue/verdict helpers. [Development](development.md#codex-app-server) owns commands, consent and evidence-recording instructions.

Current backend legs all supply the required question callback; non-question cases fail on an unexpected question rather than inventing an answer. Model-free cases and Q14 still drive the lower-level transport without one. This does not re-qualify the historical G1/G2 measurements or turn their stable connections into evidence of the shipping opt-in shape.

```text
missing --run / --case, help/list, malformed/unmatched args
  -> exit 2 before production imports, lookup, home read or spawn

explicit selected cases
  -> primary measurements + configuration/shutdown/approval guards
     guards can fail or leave UNPROVEN; never create PASS
  -> exit 0: every selected case passed (annotated skips allowed)
     exit 1: any FAIL or UNPROVEN
     exit 2: no measured pass
```

- `all` is explicit, never a default. Missing required case options or measurements skipped under `--fake` stay annotated skips.
- Native runs need individual agreement: they inherit the user's install/home/login/MCP/remote-control/multi-agent settings and may leave state there. Model turns use that login/quota; USD is unknown.
- `config.toml` is hashed before/after every case; changes fail. No configuration, credential, environment, prompt, reply or instruction text is printed. Q9 additionally checks whether config names its fixture, as a yes/no.
- Shutdown guards check actual clean exit, leftovers, discovery and pipes; a failed guard or missing exit report retains/names fixtures, including early-return paths. **Known gap:** `cleanlyOver()` does not check `cleanup.skipped` or `cleanup.deadlineHit` (source inspection), so those concerns alone do not fail its guard.
- `--keep` retains fixtures on success too. A second interrupt exits immediately, names retained uncertainty, and claims no cleanup.
- `--fake` launches the builtins-only fake by path through production seams and labels results **NOT NATIVE**. Continued fake processes receive scripted history/totals; they do not demonstrate native persistence.

### G1 cases

| Case | Model turn? | Recorded result and boundary |
| --- | --- | --- |
| Q1 | No | PASS: initialize home prediction, reported user agent/platform/Node; version is reported, not independently verified |
| Q2 | No | PASS: default implement/both ask modes and explicit-model readback; symlink cwd bound by realpath without request cwd. Explicit model was the host default's own, not a model switch |
| Q3 | Yes | PASS: fixture edit and nonce supplied only in developer instructions; no commit. Checked by fixture/HEAD/status, not reply. Nonce block makes instructions differ from production |
| Q3b | Yes | NOT RUN: optional named effort different from default; skips without `--effort` |
| Q4 | Yes | PASS: answer from fixture, readOnly reported, files/HEAD/status unchanged. No write attempted, so not write-denial evidence. No hosted search item observed |
| Q6 | Yes | PASS: cancelled at first command item start; backend aborted, turn interrupted, one interrupt, clean owned shutdown. Ended before readback: no verified selection. No command item would be UNPROVEN |
| Q7 | No | PASS: root exited 0 without signal, with/without a thread, under descendant SIGTERM then stdin end. Not proof that stdin end alone stops the tree |
| Q9 | No | PASS: untrusted fixture, no request cwd, unchanged config bytes, sandbox/approval kept |

G1's earlier cases predate diagnostics `5af04e5`, catalogue trimming `89d5e74`, and sandbox-reader narrowing `cf8f0cd`; narrowing dropped only diagnostic fields no decision read. Case definitions match the recorded rows except where noted. Q6 ran at `cf8f0cd`.

Historical Q5 ran once and was UNPROVEN, neither a success nor backend-failure finding. Its log remains; fixtures were removed after recorded clean shutdown. It is no longer a case or part of G1.

### Q14 usage measurement

PASS once at `625061e`: two short replies on one fresh read-only ask thread through production **transport**, not a two-turn backend call. Start/both readbacks named the host-default selection as diagnostics, not a backend-verified outcome.

```text
fresh thread -> turn 1 -> thread/read barrier -> total 1
             -> turn 2 -> thread/read barrier -> total 2 + last 2

observation: total 2 == total 1 + last 2, in every field
source rule: total is cumulative; last updates can repeat, so never sum them
```

| Reading | Input | Cached input | Output | Reasoning | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Turn 1 total = last | 14,811 | 12,288 | 5 | 0 | 14,816 |
| Turn 2 last | 16,070 | 12,288 | 5 | 0 | 16,075 |
| Turn 2 total | 30,881 | 24,576 | 10 | 0 | 30,891 |

- One scoped usage update per turn, before completion; none afterward. Each turn had one completed `agentMessage`, no `reasoning` item. Cache write was 0 in all four breakdowns; window 258,400. Neither figure is a general guarantee.
- PASS required two distinct completed turns on one thread, idle readbacks, usable counters and holding guards. Completed turns without usage are UNPROVEN; counters rejected by the production reader fail before they are observable.
- Harness output preserves absent/null fields, counts items by distinct id (malformed separately), and prints additivity as yes/no/unknown. Items are not model-response identities; additivity is observation, not a gate or summing policy.
- Positive cache write would record only an inequality observation; zero/absent values measure no relationship to input. This run therefore qualified no cache-write relationship, cost or context cap.
- Separately, 0.160.0 source says `total` accumulates per thread and is seeded from history on resume/fork, `last` is replaced per response, and unchanged updates can repeat. Commit `6f2a147` implemented baseline-based accounting; G2 Q10/Q12 measured continued per-call usage.

### G2 cases

Each case ran once in Q10/Q11/Q12/Q13/Q19 order, at `cff6a9e` (14:56-14:58 UTC), without `--model`. Backend continuations used the earlier outcome's mapped reference and verified selection, as host calls do.

All roots exited 0 without signal; no leftovers, discovery ok, pipes closed. Every case left config bytes unchanged and kept fixtures (`--keep`). Backend calls requested no approval; Q11's direct child was outside that approval guard. This is not permissions evidence.

| Case | Turns | Recorded result |
| --- | ---: | --- |
| Q10 | 2 | PASS: exact completed tip before resume; new checkpoint/baseline on same thread; model/provider/effort pinned in request/start/readback/selection; per-call usage and context matched |
| Q11 | 2 | PASS: extra direct-transport turn moved tip; original reference refused with `RESUME_MOVED`, zero turn/start, no checkpoint/baseline. Host retention of the earlier record is offline-tested, not measured here |
| Q12 | 2 | PASS: fork through source's **current** checkpoint; new thread/source confirmed, starting tip completed with source checkpoint's id (observed, not required); own final turn settled with pinned selection |
| Q13 | 1 | PASS: one steer pushed at first command item, sent once to admitted turn, accepted; pushed/accepted counts 1, all others 0; clean completion/non-empty report. Item start is not proof of command execution; acceptance is not consumption |
| Q19 | 2 | PASS: resume naming no model pinned recorded selection and settled a new checkpoint/baseline. **Same-model round trip only**; no changed default/model switch |

Core counts below are cumulative totals or field-by-field deltas, never sums of `last`:

| Reading | Input | Cached input | Output | Reasoning | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Q10 fresh baseline | 14,865 | 12,288 | 5 | 0 | 14,870 |
| Q10 resumed total | 29,749 | 27,008 | 10 | 0 | 29,759 |
| Q10 resume delta | 14,884 | 14,720 | 5 | 0 | 14,889 |
| Q12 source baseline | 14,869 | 12,288 | 5 | 0 | 14,874 |
| Q12 fork total | 29,757 | 24,576 | 10 | 0 | 29,767 |
| Q12 fork delta | 14,888 | 12,288 | 5 | 0 | 14,893 |

Each continued turn had one scoped usage update: its delta equalled `last` and published input/output/cache read. Reasoning/total deltas have no published field; cache write was diagnostic 0. Context was 14,884 (Q10) or 14,888 (Q12) of 258,400. Q10 also emitted an unscoped usage update and `thread/goal/cleared`; neither counted for the call.

Q13's reply reflecting the steer was an unprinted yes/no, never proof. No trigger, refusal or unanswered steer would be UNPROVEN; no retry. All cases printed ids, selection, byte counts, counters and answer tags, not reply/prompt/steer/instruction text.

### G3 cases

Each case ran once in Q15/Q16 order at `84aa4ff` (16:31-16:32 UTC), without model/effort overrides. All roots exited 0 without signal, no leftovers, discovery ok, pipes closed; config bytes unchanged, fixtures kept.

```text
Q15: fresh ask -> resume -> fork of resume's current checkpoint
       each leg: one own-turn question -> callback's new random answer
                 -> report carries that answer -> verified success

Q16: fresh ask -> first question waits -> production signal cancelled once
                 -> question signal aborted -> failed tool reply + interrupt
                 -> aborted, no checkpoint/baseline, clean shutdown
```

Q15 recorded on the wire:

- Every initialize: `experimentalApi: true`. Only fresh thread/start: one flat `function` tool `ask_orchestrator`, object schema requiring `question`. Resume/fork registered nothing.
- Each leg: one unnamespaced own-admitted-turn `item/tool/call` before completion, one callback/question, no refusal/repetition; `success: true` with one `inputText` item. Reports carried each callback's own answer, which existed only in the tool result.
- Resume read the exact checkpoint; fork created a new thread whose starting tip had that source-current-checkpoint id. Request/start/readback/verified selection pinned model/provider/effort.
- Each leg had two scoped usage updates. Published counts equalled per-call deltas, not a sum of `last`; cache write was 0.

| Q15 leg | Input | Cached input | Output | Reasoning | Total | Latest input / window |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Fresh | 29,319 | 14,464 | 48 | 0 | 29,367 | 14,693 / 258,400 |
| Resume delta | 29,569 | 29,056 | 48 | 0 | 29,617 | 14,818 / 258,400 |
| Fork delta | 29,822 | 14,720 | 51 | 0 | 29,873 | 14,946 / 258,400 |

Q16 recorded one callback/question, aborted question signal, no answer, backend aborted, turn interrupted, stop requested and clean exit. Observer saw one `success: false` reply with a 112-byte `inputText` item and one turn interrupt. Their relative order and Codex's acknowledgement were **not** measured.

The scratch observer recorded shapes/ids/counts/byte lengths only, no question/answer/report/instruction text. Each callback generated its answer internally, not in a prompt, fixture or fake setting. Missing question/answer echo or multiple distinct questions was UNPROVEN; duplicate ids or callback/counter disagreement was FAIL.

Q15 used three completed turns/three owned children; Q16 one cancelled turn/one child, on the user's quota with USD unknown. These passes cover restored tools on one resume/fork and waiting cancellation, not older tool-less threads, host UI/races, steering or moved-tip refusal in the opt-in shape.
