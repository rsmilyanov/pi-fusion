# Runs, handles and background work

A run has a handle such as `run-3`, a role, a backend, and a recorded child session. This page owns delegation parameters, continuation/recovery, background controls, and history. Implementation details and qualification limits live in [Pi backend](pi-backend.md) and [Codex backend](codex-backend.md).

## Delegation parameters

The host calls `fusion` with a task; optional parameters select how it runs. `claude` is the compatibility form, forced to Claude Code and without a `backend` parameter.

| Parameter | Meaning |
| --- | --- |
| `role` | `plan`, `implement`, `ultracode`, `ask`, or `security`; required unless `continue` supplies the role. `claude` does not advertise `security`. |
| `task` | The brief, or the next user message for a continuation. |
| `context` | Additional prose appended under `## Context`. |
| `continue` | An ended run's handle; resume its recorded session/checkpoint. |
| `background` | `true` returns a handle immediately; the report arrives later. Available for every role. |
| `fresh` | `plan` only: start a new plan instead of implicitly continuing. Cannot accompany `continue`. |
| `mode` | `ask` only: `answer` (default) or `review`, choosing the corresponding contract. A continuation keeps its mode unless overridden. |
| `model` | Override a model: Claude alias/id for `plan`, `implement`, or `ask`; `provider/model-id` for every Pi role; a Codex model id without whitespace for `plan`, `implement`, or `ask`. `ultracode` rejects it. |
| `effort` | Claude `low`, `medium`, `high`, `xhigh`, or `max` for `plan`, `implement`, or `ask`; Pi also accepts `off` and `minimal`; Codex any single level without whitespace for `plan`, `implement`, or `ask`. `fusion` advertises it as a plain string and the routed backend's binding checks it before admission; `claude` keeps the Claude enum. A Codex level passes the binding lexically, and the model or server may still refuse it when the run starts. Optional on Pi and Codex; fixed for `ultracode`, which rejects the parameter. |
| `backend` | `fusion` only: `claude`, `pi`, or `codex`. Fresh calls use role settings unless overridden; continuations cannot change backend. Codex runs `plan`/`implement`/`ask` through the host's own install; see [behavior and qualification limits](codex-backend.md). |

A role that does not accept a supplied parameter refuses it before starting a child. Disabled roles refuse new runs and continuations, including calls supplying their own model/backend. Security must be enabled separately through [settings](profiles.md); a model does not enable it.

All four workflow tools use sequential execution. Pi serializes tool calls in a turn containing one of them; background children can still overlap subject to the single-writer rule below.

## Child tools and settings

Every child runs in the host's working directory. Claude and Pi append the role contract to their own system prompt; Codex receives only that shared contract as the thread's developer instructions and requires a [question callback](questions.md#on-codex). Tool lists differ:

| Role | Claude Code tools | Pi tools |
| --- | --- | --- |
| `plan`, `implement` | Read, Bash, Edit, Write, Grep, Glob | read, bash, edit, write, grep, find, ls |
| `ask` | Read, Bash, Grep, Glob, WebSearch, WebFetch | read, bash, grep, find, ls |
| `ultracode` | Claude's own tools, Workflow, Agent, and the user's MCP servers | Unsupported |
| Enabled `security` | Unsupported | Same as Pi implement |

A Codex role is bound with a sandbox instead of a tool list: `plan` and `implement` in `workspace-write`, `ask` (both modes) in `read-only`, with approval policy `never`. The child's tools, MCP servers, writable roots, network setting and multi-agent features are whatever the user's Codex configuration gives that sandbox mode; Fusion isolates none of them. See [Codex backend](codex-backend.md#inheritance-not-isolation).

Every Claude and Pi child also gets [ask_orchestrator](questions.md); Codex registers it as a dynamic tool on fresh threads and trusts its restoration on continuations ([Questions on Codex](questions.md#on-codex)). Fixed-tool Claude roles use `bypassPermissions` and strict MCP configuration with only that question server. Fusion leaves Claude's normal settings/plugin/CLAUDE.md loading in place; ultracode's permission mode is [configurable](ultracode.md). Pi instead uses in-memory settings and explicit resources; see [its lifecycle](pi-backend.md#one-calls-lifecycle).

Contracts restrict scope and ask's file changes, but a shell tool can still write files. These lists are not an operating-system permission boundary.

## Runs and handles

Handles advance beyond the highest handle on the current branch and every handle this process has already used. An admitted run that fails still keeps its handle; a validation/binding refusal before admission takes none.

Accepted outcomes append `pi-fusion` custom entries to the host transcript. The last entry per handle on the current branch supplies continuation authority. In-memory status/report data is separate; optional disk history preserves more of it across processes.

Without `continue`, `implement`, `ultracode`, `ask`, and enabled `security` start new runs. `plan` implicitly continues the latest plan of the backend the call routes to. Plan threads on different backends remain separate. `fresh: true` starts another plan; an explicit handle can revisit an older one.

For example, the host can continue a completed run with:

```json
{ "continue": "run-3", "task": "The migration test still fails; diagnose and fix it" }
```

The run retains its role/backend. Supplying a different role or backend refuses the call. A profile switch alone does not change its recorded model/effort; permitted call overrides can. Disabling that role prevents continuation until it is enabled again. Pi and Codex continuations require `fusion`, never the forced-Claude compatibility tool.

### Resumes, tree navigation, and host forks

```text
host resume       -> current branch's latest run checkpoint
host /tree        -> checkpoint from the selected older branch
host fork         -> first use forks the recorded child session at that checkpoint
                     same handle, new child identity belonging to the forked host
```

A host resume works because the entries are in its transcript. `/tree` is refused while any run is unfinished: running, waiting, or ended but still taking its final snapshot, recording its entry, or delivering its report. Those final runs are shown as `finishing`. No run is cancelled by the refusal.

A host fork copies no child immediately. On first use, Claude resumes with `--fork-session`; Pi runs its internal fork command and verifies the returned identity/leaf. The new child session is recorded under the same handle. Both an in-session fork and `pi --fork <session>` use this policy. Conversation branching undoes no working-tree changes.

## Backends in a record

| Record | Session / selection kept |
| --- | --- |
| Claude | Flat session id, last assistant-message UUID checkpoint, and admitted model/effort, defaults included |
| Pi | Structured session id, absolute transcript file, trusted checkpoint where available, and actual model/thinking selection |
| Codex | Tagged thread id, trusted checkpoint where available with the thread's cumulative usage baseline at that completed turn (five counts, plus a cache write only when reported), and the configured model and provider read back from the child, with its effort when it names one |
| Older untagged entry | Claude, preserving compatibility with entries written before backend tags |

Older Claude records missing model/effort use the legacy defaults captured when this extension instance loaded, **not** the current profile, and the result says so. A Claude entry without a checkpoint resumes the whole session. Very old plan entries under `consolidator` keys with generation `g` read as handle `run-<g+1>`.

Unknown backend tags, mixed/incomplete session formats, and Pi or Codex records without a trusted checkpoint or repeatable selection are kept for reading, not guessed into a continuation.

```text
Codex record: tagged thread reference + selection with provider
  +-- checkpoint + valid baseline -> eligible for backend continuation checks
  +-- no checkpoint/baseline pair -> readable only; never upgraded
  +-- baseline without checkpoint
  |   or malformed baseline      -> reference unreadable
  +-- flat Claude / Pi fields    -> refuse mixed session format
```

A baseline needs the exact non-negative whole counts, with cached input within input. A successful Codex run pairs its own completed turn with the thread's cumulative total there. Readable-only refusals offer `codex resume <thread id>`; [Codex continuation](codex-backend.md#continuation-and-fork) owns the runtime checks and native limits.

Implicit Codex `plan` calls use the same continuation rules. A refused latest plan stops the call: no older-plan fallback or handoff to escape refusal. Use `fresh: true` for a new plan.

### Recovery policy

| Ending | What the next call can do |
| --- | --- |
| Resume failed/cancelled | No new branch record; the previous successful checkpoint stays authoritative. On Codex that record stays the historical authority but is not guaranteed resumable: a failed or cancelled call whose turn was admitted can move the thread's tip past its checkpoint, and a later `continue` is then refused before any turn, naming a new run without `continue` that carries the earlier report (`plan` needs `fresh: true`: omitting `continue` alone repeats the implicit resume). Nothing forks, rewinds or replays to get back to it |
| Fork failed after a verified new identity | Keep that fork at its starting checkpoint, avoiding a second fork; without verified selection it is readable but cannot continue. A Codex fork keeps the starting checkpoint its new thread reported, or none, never the source's, and no baseline, so it is readable only; a failed fork claiming a baseline fails |
| First Pi call established a session but no trusted checkpoint | Read the session, but refuse continuation rather than replay the failed prompt |
| First Codex call (no `continue`, no host fork) failed after reporting its thread, or a record written before Codex checkpoints | Keep the thread for reading and refuse continuation; the refusal names `codex resume <thread id>`, and new work needs a new run |
| Codex resume/fork succeeded without a trusted checkpoint and its usage baseline | Fail the run and record nothing; the previous record stays authoritative |
| First Pi or Codex call established no verified session | Keep handle/failure, refuse explicit **and** implicit continuation; start a new role call without `continue` (`plan` also takes `fresh: true`) |
| Claude call failed before reporting a session | Keep handle; continuation can start a new Claude session |
| Outcome claims an impossible identity or incomplete success | Fail the run and publish no identity to branch/history; any previous record remains unchanged |

A session-less Pi failure remains a failure report through `wait` in the same process. After restart, controls explain its recorded continuation refusal. History can retain the report when enabled; it never invents a session for it.

### Reopening a transcript

Results, background notices, waits, and detailed status offer:

- Claude: `claude --resume <session id>`. Normal transcripts live under `~/.claude/projects/<encoded working directory>/<session id>.jsonl`.
- Pi: the **accepted outcome's transcript file**, not a Claude resume command. A fork names its new file, not the source. A running run, thrown backend, or rejected outcome offers no Pi path; a verified session kept only for reading may offer one.
- Codex: `codex resume <thread id>`, from the accepted outcome's thread only, as an intended manual hint that has not been natively measured ([Codex evidence](codex-backend.md#evidence)); an id that is not one plain shell word is single-quoted, after `--` when it starts with `-`. A fork names its own thread; a thread kept only for reading names it in its continuation refusal.

Pi restores only the exact recorded file/id/checkpoint and repeats its recorded selection. Missing files, absent checkpoints, old/malformed transcript formats, leaf mismatches, or clamped thinking levels refuse the call; no fallback or repair is attempted. The detailed [checkpoint checks](pi-backend.md#continuation-and-checkpoints) include their source-only limitations. For any backend, start a new run if its transcript cannot be continued; use `fresh: true` for a new plan.

A host started with `--no-session` keeps branch entries only in memory, while children still use their own transcript storage.

## Pi task checks

Done requires settled turn evidence and an exact idle-state readback in the same session/selection, with **zero pending messages**. Positive, missing, or malformed counts fail the call; Fusion does not wait for a queue to drain or resend unread messages. See [Completion](pi-backend.md#what-counts-as-completion).

Ordinary tasks beginning with `/pi-fusion-navigate` or `/pi-fusion-fork` are refused with instructions to rephrase them. Mentioning or quoting the commands inside a task is fine; they are reserved for recorded-session restore and do not move Git branches or undo files.

Without signal/cancellation, a null exit code reads `<role> failed: <detail>`, not “did not start.” The detail can concern startup, readiness, task checks, or cleanup. Startup lacking a useful bootstrap diagnostic can show a labelled **Child stderr** section with the last 4 KiB of retained output; truncation is marked and empty stderr adds nothing. It is child output, not redacted text.

## Aborting a run

Esc stops a foreground run, not a background run. Controls or `/fusion cancel` stop a background run; host shutdown (`quit`, `/reload`, `/new`, `/resume`, `/fork`) cancels active runs and waits for final recording.

The Claude path requests SIGTERM then SIGKILL after five seconds for the child and its discovered process groups/descendants on Unix. The extension uses the SDK spawn hook rather than relying on SDK shutdown of the root alone. A child still running two seconds after SDK completion is stopped the same way; that wind-down is not itself a run failure.

Pi first observes descendants of a live task, requests queue-clear/abort over RPC, then performs bounded owned cleanup. A cleanup concern retains call storage and prevents publishing a completed turn's checkpoint. An unsafe otherwise-completed turn is failed; cancellation remains cancellation with a warning, for example:

```text
implement cancelled; cleaning up needs attention: leftovers; this call's storage is left behind
```

The warning is composed once and carried consistently through controls, user notices, waits, background reports, history, and dashboard. It uses fixed concern labels and no path or foreign error text. A retained directory is matched by role/creation time under `pi-fusion/calls`, not handle. A clean cancellation has no extra warning. A storage-removal failure alone can instead be a note on successful work.

**Manual attention:** inspect and stop survivors, review working-tree/external effects before retrying, and remove retained storage only when nothing of the call is running. Cleanup is best effort, not isolation; a process may keep writing after the writer slot is released. File changes are not rolled back, retained storage does not protect the shared tree, and retrying can repeat work already done. See [Cleanup limits](pi-backend.md#cleanup-and-failure-handling).

## The context cap

The plan context cap defaults to **35%**. Set `plan.contextPct` in [Fusion's settings file](configuration.md#the-fusion-settings-file); a non-blank `PI_FUSION_PLAN_CONTEXT_PCT` overrides it. It compares the last model call's prompt tokens with its context window. On Codex that is the latest response's input against the reported model window, an estimate used only when both are positive: never the thread's cumulative total or the call's own usage, and not an exact occupancy. A run that recorded no positive pair has no share and is never capped. An implicit plan continuation at/above the cap starts a fresh plan, carrying the previous report (up to 32 KiB) as quoted agreed-plan data, not instructions. The result names both handles. Explicitly naming a different model also hands off, on any backend.

A cap handoff keeps the old planner's model unless overridden. Its effort differs:

- Claude uses the call's effort, otherwise that backend's fresh-run defaults; it does not carry the old effort. Those defaults are the configured plan settings or captured legacy defaults for an explicit other-backend override.
- Pi carries recorded model and thinking level together unless the call overrides a field.
- Codex carries the recorded model and effort the same way, but not the provider: a fresh thread names no provider, so it runs on the host's own Codex provider, unchecked against the old run's. Only a continued thread keeps its recorded provider.

`fresh: true` and a first plan instead use the configured settings. Explicit `continue` is **never handed off**: the call runs, but its result warns above the cap and suggests a new self-contained brief, a new ask, or a fresh plan restating the agreement. The cap alone never strands an explicit continuation.

A handoff needs the previous report from this process or enabled history. If a restart left neither, the call refuses and asks for a restated `fresh: true` plan or an explicit continuation of the old handle; it never silently loses the agreement.

The variable accepts percentages from 0 to 100; `0` disables both handoff-by-cap and continuation warnings, not handoff for an explicitly changed model. It is read at extension load; invalid values leave the default and warn once. Stats show `context 400.0k/1.00M (40%)`; status shows `context 40%`, or `<1%` when a positive share rounds to zero.

## Background runs

`background: true` returns a handle immediately. At most one file-changing run (`plan`, `implement`, `ultracode`, or enabled `security`) can be active across backends; waiting counts too. `ask` runs can run alongside it. Continuing an active handle refuses and points to a control `message` action instead.

A completed background run normally sends a `pi-fusion-run` follow-up that starts a host turn when idle or queues behind its current turn. A report collected by a host control `wait`, or a run cancelled by a host control, sends no duplicate end message. User `/fusion cancel` and `/fusion wait` do not suppress the host's end notice. A foreground child asking a question returns early and waits in the background; see [Questions](questions.md).

Both `fusion_control` and `claude_control` take `action`, optional `run`, and `message`, and manage every run:

| Action | Effect |
| --- | --- |
| `status` | Without a handle, list runs; with one, show activity, tools, open question, and live changed files for coding runs. It does not return the report. |
| `wait` | Wait for final recording/report or a question. Esc leaves the run going. |
| `message` | Answer a waiting question or steer a running child. An ended run receives nothing; the reply gives its final state/report summary and offers continuation only when permitted. |
| `cancel` | Stop the run and mark it cancelled, carrying any cleanup warning. |

Claude steers use the SDK's queued user-message input; Pi buffers until task input attaches and sends native `steer` requests sequentially, once each, with no retry. Queued items can be dropped at close, and an in-flight accepted steer can still be unread when the agent loop ends. **Logged by host is not consumed by child, and consumed is not acted upon.** Neither a successful control response nor `/fusion steer` proves model consumption. The Pi pending-message completion guard refuses false success, not repairs or resends instructions.

Codex buffers steers from admission until its turn is named, then sends each once in order as `turn/steer`. Closing/cancelling drops queued messages; nothing retries. The reply says **queued**, not read, and the report counts delivery outcomes. [Codex steers](codex-backend.md#steers) owns queue limits, outcome meanings and the narrower native evidence.

A running child's input can refuse a message while it stays open, as a full Codex queue (32 waiting) does: the control reply and `/fusion steer` then say at once that it was not accepted now, and nothing was sent, queued or kept for a retry. A message that meets a closed input is the run ending, reported as above.

Ordinary editor text targets the host. `/fusion steer run-N <text>` targets the child and logs the instruction in the host conversation. A waiting child instead needs `/fusion answer`; the host may forward an ordinary instruction through a control tool at its discretion.

Generated questions/cards/handoffs use the invoking tool pair (`fusion`/`fusion_control` or `claude`/`claude_control`); a control reply uses the name called. Pi and Codex continuation hints always use `fusion`. Reviews with no initiating delegation tool use the primary pair. User commands always remain `/fusion ...`.

## Runs across Pi processes

An earlier process's branch-recorded run is not active. Controls explain that distinction; `fusion` can continue it only when its record is usable. Reports live in memory unless [history is on](#turning-history-on-and-off) for this instance, which saves them for a durable host session. No history is written for `--no-session`.

History writes on start, token updates, and end. On its first delegation, control or command, a later process restores earlier usage and the reports that status and review read. Branch entries remain continuation authority. For those lookups a history record must name the same child as the branch's latest entry for its handle: Claude session id, Pi id **and file**, or Codex thread id. A mismatched identity is not reported or reviewed as that run. A fork reads ancestor history but never writes to that ancestor's file. A run left active by a dead process restores as `aborted`, and the host writes that correction back to its own session's file. The dashboard lists earlier runs through a separate, read-only [archive](dashboard.md#archived-runs).

Detailed earlier-run status shows its state, elapsed time, changed-file count, and first 600 report/failure characters. It offers continuation only with a usable branch record and review only for work made in this working directory. Restored usage seeds the session ledger, and handles are not reused.

### Turning history on and off

History is off unless turned on. Each Fusion instance decides once, when it starts, and keeps that choice for its whole life:

```text
saved preference in <agent dir>/pi-fusion/settings.json   history.enabled true/false
  -> otherwise PI_FUSION_HISTORY, as captured when the instance was created   exactly "1" (trimmed) = on
  -> otherwise off
```

A saved `false` turns history off even with `PI_FUSION_HISTORY=1`. The variable stays as a compatibility fallback for when nothing is saved.

| Command | Effect |
| --- | --- |
| `/fusion history` | Show this instance's history (on/off and where that came from), the saved preference read now (`on`, `off`, `unset`, or `unknown` with the file's problem), and the settings file path |
| `/fusion history on`, `/fusion history off` | Save the preference for **new** Fusion instances only |

Saving never changes the running instance. The notice says what was saved and what this instance keeps, for example `this instance keeps run history off; on takes effect after restarting Pi, /reload or replacing the session` (`/new`, `/resume`, `/fork`). Saving a value that already matches says so and claims no restart. Neither command needs Fusion on or every run finished, and neither changes the mode, the role configuration or profiles. Editing the file, or changing `PI_FUSION_HISTORY` in the shell, does not affect a running instance either.

`/fusion status` shows this instance's line, such as `history: off in this instance (from the saved preference)`. `/fusion config`, when it prints rather than opens the editor, adds the saved preference and file path. See [the Fusion settings file](configuration.md#the-fusion-settings-file) for its schema and write rules.

Startup reads the settings file once, before anything reads or writes history, on every path: session start, delegation, `/fusion` commands, and control tools reached before session start. If the file cannot be read, is malformed or comes from a newer pi-fusion, it is left untouched, `PI_FUSION_HISTORY` decides, and one warning names the problem and the resulting behavior. A save into such a file is refused.

Turning history on writes the [project content listed below](#history-data-and-limits) for durable host sessions only. `--no-session` writes no history whatever the preference. The preference file itself can still be saved from such a session. Turning history off stops writes in later instances. It does not delete existing history files or child transcripts, and nothing fills in runs from an instance that kept no history. Delete those files by hand if you want them gone.

### Archive eligibility

The dashboard archive reads this host session's file and the files of ancestor sessions named by any `pi-fusion` entry on the current branch, superseded entries included. A record is shown at most once, by its history id:

- **This session's record:** shown unless the branch has entries for its handle from this session and its child contradicts all of them. A run killed before its entry, or one the branch never recorded, stays readable.
- **An ancestor's record:** shown only when a branch entry names that host session, handle, backend and child. That file also holds the runs of branches this one left.
- **Request lineage, this session only:** a failed, aborted, cancelled, or left-running/waiting record whose own child contradicts the branch is still shown when its saved resume or fork request names, exactly, a parent the current branch recorded for the same handle and backend. That entry may be superseded or come from an ancestor session. A Pi parent needs the same session id **and** file, checkpoints aside; a Codex parent needs the same verified thread id. A done run, a new-session attempt, and a request naming an unrecorded parent stay excluded. Saved request fields are capped at 400 characters without a truncation flag, so a parent id or file of 399 characters or more is treated as possibly cut, and that record is not admitted this way.

The lineage rule is display only. It creates no reference, selection, continuation, review or control target. A Pi child's identity is only its exact accepted reference. A Claude record's flat session id is what its run reported, and failed runs can have one. When a record is shown only through lineage and no accepted Claude reference confirms that id, the dashboard shows the id but no resume command. Version-1 history cannot tell an abandoned failed continuation against a parent the branch still records from another attempt against that parent, so both can appear.

### History data and limits

**This writes project content to disk:** prompts, reports, failure text, changed paths, and accepted session/selection. The directory defaults to `<agent dir>/pi-fusion/history`, or `PI_FUSION_HISTORY_DIR`. Directories are private (`0700`), files private (`0600`), with one JSON file per host session.

| Limit | Value |
| --- | --- |
| Records per session file | 100 |
| Session files | 200 |
| File size | 1 MiB |
| Prompt / report | 32 KiB each |
| Failure text | 4 KiB |
| Changed paths per run | 500 |

Oldest records/files go first, by count or by bytes: large records can leave far fewer than 100 in a file. A single oversized record can lose its path list to fit while preserving counts. Pruned or never-saved data cannot be recovered, and there is no migration. Dashboard retention (`PI_FUSION_DASHBOARD_MAX_RUNS`, `/fusion dashboard limit`) is memory only and never prunes these files. Accepted reference/selection fields are exact; over-32768-character values are omitted, never shortened into another file/model. Live history writes keep no session identity until an outcome is accepted, so a process killed mid-run offers no transcript path from unverified progress.

Files are replaced through temporary-file/rename, never followed through symbolic links. Corrupt/foreign files warn and can be replaced by a later write; newer-version files are left alone; other storage trouble warns once per process and does not prevent runs. Files persist until manually deleted or pruned by a cap. See [Configuration](configuration.md#session-usage-and-budget) for restored usage and budget behavior.
