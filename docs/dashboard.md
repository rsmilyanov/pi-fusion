# Monitoring dashboard

## Opening and closing

```text
/fusion dashboard
/fusion dashboard stop
```

The first command starts a local HTTP server on `127.0.0.1` at a random port, shows the URL, and attempts to open a browser (`open` on macOS, `xdg-open` on Linux; other platforms show the URL only). Later calls reuse the server/URL. `PI_FUSION_DASHBOARD_OPEN=0` suppresses browser opening.

It is **read-only**: no prompting, cancellation, editing, or shell-command endpoint. Use [user commands](fusion-command.md) or a control tool to change runs. The browser polls once per second; there is no SSE or WebSocket.

The server stops on quit, `/reload`, `/new`, `/resume`, or `/fork`. Reopen for a new capability URL and a fresh in-memory store; with history enabled, earlier runs come back as [archived runs](#archived-runs). Runs are captured from extension load, not just from the moment the dashboard opens. See [History](runs.md#runs-across-pi-processes) for disk persistence.

## Runs and detail tabs

Runs are grouped by the host Pi session, newest session first, with numbered steps and a role chain. Clicking a step selects it. Entries show handle, role, backend/model, background state, elapsed time, tool counts, and open questions. States are running, waiting, done, failed, aborted, or cancelled.

The selected header summarizes status, question, activity, event age, tools/errors, tokens, estimated cost, and context usage. Four tabs split the detail:

| Tab | Contents |
| --- | --- |
| **Overview** | Host tool/call/session facts, prompt and contract, requested child session, models/usage, changed files, and accepted transcript/resume hint |
| **Log** | Ordered run/tool/agent/task/turn events, expandable tool input/results, and search/filter controls |
| **Tasks** | Task facts, timeline, phases/agent states where emitted, and latest thinking blocks |
| **Report** | Final report or failure, Markdown/Raw views, Copy, and Escalation/Review/Open questions sections |

Running/waiting runs open on Log. Ended runs open on Report, or Overview if there is no report/failure. Tabs retain scroll positions across refreshes and run selection; left/right arrows on a focused tab move between tabs. The Log tab counts new rows while another tab is visible; Tasks counts tasks/running work; Report shows section badges or `!` for failure.

A waiting banner offers each waiting run without changing selection until clicked, and the page title shows the waiting count. Entries get an amber stripe. Focus on banner buttons is preserved when their set remains unchanged.

A run with no real event for 60 seconds gets an amber edge/timer. Thinking deltas count as events, so this highlights missing progress, not merely slow reasoning. The page shows only events the backend emits: Claude workflow/task/model details are not promised for Pi. It holds no subagent transcript; Claude `forwardSubagentText` and `agentProgressSummaries` remain off.

## Archived runs

With [history on](runs.md#turning-history-on-and-off) in this instance (a saved preference, else `PI_FUSION_HISTORY=1`, read at instance start) and a durable host session (not `--no-session`), the list also shows runs from the [run history](runs.md#runs-across-pi-processes), labelled as archived. It reads this host session's history file and the files of ancestor sessions the current branch names, and only the runs that branch can vouch for (see [archive eligibility](runs.md#archive-eligibility)). It never reads abandoned branches or unrelated session files. Each invocation keeps its own row by its history id, so continuing one handle three times shows three rows.

After a restart or `/resume`, the first list is history only. No child is running again and no question can be answered. A run left running or waiting by a process that is gone reads `aborted`, marked interrupted, and its end time shows as not recorded. A run this process starts shows live first and joins the archive once the store lets it go.

**Load older runs** fetches fixed pages of 30, newest first. The page size does not depend on the live retention target, and loaded pages stay through polls. A cursor is a position, not an offset, so runs archived since then never repeat. Runs the history has since pruned leave the list, and their detail is gone.

An archived detail shows what the history saved:

- prompt, report, failure, the usage counters it kept, changed files, the session request, and the accepted reference/selection;
- labels where the history truncated text or kept a file count without its list.

Logs, tool inputs/results, tasks, timeline, thinking, per-model usage, cache, event times, turns, API time, context and denied tools read **Not saved in history**, never zero. The history holds no child transcript.

Browsing is read-only. It writes no history file, re-seeds no usage, reserves no handle, and grants no continuation, review or control. Those still follow the host branch and the host's own restore of its session (see [Runs across Pi processes](runs.md#runs-across-pi-processes)).

## Log and keyboard navigation

Click a tool row to expand its input/result. Awaiting results are grey, error results red, and tool-error count appears in facts. Agent calls can expose their prompts. Task bars run from start to end on the run's clock, grow while active, and show overlap/state.

The log initially follows newest rows. Scrolling up preserves the visible rows and shows a button counting new arrivals; click it to return to the bottom.

- `/` opens Log and focuses search.
- Search is case-insensitive; chips select event kinds or errored tool calls.
- `Escape` or Clear resets text/kind/error filters together. Filters apply across runs and persist through refreshes.
- In the run list, up/down moves focus without selecting; Enter/Space selects. Focus survives refreshes.
- Below 768 px, a **Runs** button opens the list over the page. Selection or Escape closes it and returns focus to the button. The detail behind it takes no focus/keys; widening closes the list and it stays closed on narrowing again.
- Wide tables scroll horizontally within their sections and preserve position.

## Usage, files, and transcript hints

The header ledger matches `/fusion status`. Per-run facts include token/cache usage, cost, model/effort, turns/API time where emitted, and context. The context meter turns amber at 70%, red at 90%. Before Claude reports a window, its fallback is 1M for ids ending `[1m]`, 200k otherwise. Cost is a runtime/model-price estimate, not a subscription charge. The model first shows the admitted setting, then the child's confirmed id.

Pi transcript hints come from a **verified outcome the host accepted**, never a launch request or live progress claim. A fork names the new child, not the source. Live/thrown/rejected Pi runs offer no path. Claude hints use `claude --resume <session id>` from the flat id the run reported, as before, for live runs and archived runs the branch records. An archived Claude run shown only through its [request lineage](runs.md#archive-eligibility) keeps that id readable but offers no resume command, unless an accepted Claude reference names the same id. Its parent is never offered in its place. Codex hints use `codex resume <thread id>` from the accepted thread reference only: the scalar id a Codex child reports while it runs is never offered, as a Codex command or a Claude one, and a Codex run's launch request is labelled **Codex thread request**. A Codex run shows no cost, and the header says how many Codex runs the estimate leaves out. Identity fields are copied exactly, not shortened into another path/id; values over 32768 characters are omitted. The session-request facts are separate and may legitimately name the source a fork was requested from.

For coding runs in Git trees, snapshots compare status and content before/after work, including untracked and already-dirty files. A file is listed only when it changed between snapshots; a concurrent commit can be marked committed. Line counts are against HEAD (whole new files), so they can include earlier dirty edits. Other writers' changes can also appear: **this is not attribution proof**. Ask runs have no file snapshot. Git commands are bounded to ten seconds; failures omit file data without failing the run. Live counts are sampled at most once per ten seconds.

Reviews show links on both the review and reviewed run. Cleanup/cancellation warnings match the run's terminal text; the dashboard avoids a duplicate activity copy for host-cancelled runs carrying that same warning. It does not prove every descendant stopped.

## Rendering and retained data

Reports render headings, paragraphs, lists, tables, code, quotes, and emphasis by building DOM nodes, **never by parsing child text as HTML**. Links show text and a URL tooltip but do not navigate. Raw shows original text; Copy works for reports, prompts, and session hints. Section badges open Report at Escalation, Review, or Open questions.

The store defaults to **30 runs**, evicting oldest finished work first, never running or waiting runs. Set `PI_FUSION_DASHBOARD_MAX_RUNS=200` before starting Pi to choose a different startup target. It is captured once when the extension instance loads. Unset/blank values keep 30; invalid values keep 30 and warn once on the first delegation, control, or `/fusion` command.

Inspect or change the target at runtime:

```text
/fusion dashboard limit
/fusion dashboard limit 200
```

Both settings accept positive decimal safe integers (1–9007199254740991); zero does not disable retention. The command works with Fusion off, while children run, and without opening the dashboard. Lowering the target immediately evicts eligible finished runs; running and waiting runs can exceed it, and the store trims again as they finish. Raising it retains more subsequent runs, but does not recover already-evicted data. Neither operation changes continuation records, disk history, archived pages, or per-run caps: retention is memory only and deletes nothing on disk.

The command override is memory-only, belongs to this extension instance, and is not saved in profiles. Stopping/reopening the dashboard preserves it; a reload or session replacement reads the environment again. Larger targets retain more potentially sensitive output in host memory and increase the summaries the browser polls/renders.

Other limits:

| Data | Cap |
| --- | --- |
| Log entries / tasks per run | 100 each |
| Prompt | 256 KiB |
| Report / failure | 32 KiB / 4 KiB |
| Changed files | 500 |
| Tool input / result | 16 KiB each while its log row is retained |
| Agent prompt | 32 KiB |
| Thinking | Last five blocks, 16 KiB each |

Truncated text is labelled. Pi's progress mapper can impose smaller previews before events reach the store; a dashboard preview is not the full child transcript.

## Sensitive-output boundary

The page contains prompts, contracts, reports/failures, tool arguments/results, Agent prompts, task summaries, thinking previews, and file paths. A startup failure can include a bounded child-stderr excerpt. Environment, argv, and raw SDK frames are not exposed, but output itself can still contain sensitive project data.

The server binds loopback, and its random URL capability token stands in for authentication. **Do not share the URL.** Loopback/capability checks and safe DOM rendering are not a sandbox or secret-redaction guarantee. Host run history is a separate opt-in disk record; closing the dashboard or turning history off does not erase those files or child transcripts.
