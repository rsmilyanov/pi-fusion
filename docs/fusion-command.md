# The /fusion command and the terminal UI

## The /fusion command

User commands act on the same runs as either control tool. Run-changing `steer`, `answer`, and `review` actions notify the host as follow-ups without starting a turn, so you keep the floor.

| Command | Effect |
| --- | --- |
| `/fusion` | Show the usage warning, then the same status as `/fusion status`; does not change mode or start a child |
| `/fusion on`, `/fusion off` | Switch delegation mode; neither starts or cancels a child |
| `/fusion status [run-N]` | Show mode, current profile, this instance's history, role defaults, runs, earlier-process runs, and session usage; with a handle, show only that run's activity, tool count, changed files, and accepted transcript/resume hint |
| `/fusion cancel run-N` | Stop the run and mark it cancelled by the user; the host still gets its end notice |
| `/fusion steer run-N <text>` | Queue text for a running child; a waiting child needs an answer instead |
| `/fusion wait run-N` | Show activity/elapsed time until the run ends or asks a question; Esc leaves it going and never takes the report away from the host |
| `/fusion answer [run-N] [text]` | Answer a waiting question; no text opens an editor; no handle selects the sole waiting run |
| `/fusion review run-N` | Start an independent background review of eligible ended work |
| `/fusion config` | Show/edit the session's role settings; printed output also shows the profiles file, this instance's history, the saved history preference and the settings file |
| `/fusion profile [list \| use <name> \| save <name> \| default <name>]` | Choose/manage global named profiles |
| `/fusion history [on \| off]` | Show this instance's history, the saved preference and the settings file; `on`/`off` save the preference for new instances only. Works with Fusion off and runs unfinished. See [Turning history on and off](runs.md#turning-history-on-and-off) |
| `/fusion dashboard`, `/fusion dashboard stop` | Open/reuse or close the read-only monitoring page |
| `/fusion dashboard limit [N]` | Inspect or set this instance's in-memory run-retention target; defaults to 30, never evicts active work. See [Dashboard](dashboard.md#rendering-and-retained-data) |

Status offers continuation only for a usable record. A Pi transcript path appears only after the host accepts the outcome: not for a live run or a rejected result, and a fork names its new child file. Claude hints use `claude --resume <session id>`. See [Records](runs.md#backends-in-a-record).

“Steer sent” means accepted for delivery, not consumed or acted on by the model; on Codex the notice says `steer queued for run-N` and that it goes once to the current turn, with no retry. A child whose input is still open but takes no more, as a full Codex queue does, gets `run-N did not accept the steer now`; one whose input has closed gets `run-N no longer takes input`. Neither sends, queues or retries anything, and neither is logged to the host. Ordinary editor text goes to the host, not automatically to the child. `/fusion steer` logs an accepted instruction to the host as well; nothing automatically resends an unread child steer.

A clean cancel notifies `run-N cancelled`. If stopping the Pi child left a cleanup concern or retained storage, the notice is a warning, for example:

```text
run-N cancelled; cleaning up needs attention: leftovers; this call's storage is left behind
```

The same warning appears once in the failure/report/history/dashboard. It carries no path or foreign error text. Cancellation does not undo files, and cleanup can need [manual attention](runs.md#aborting-a-run).

Completion offers forms and relevant handles: all runs for status, active ones for cancel/wait, running ones that take a steer for steer, waiting ones for answer, and reviewable ones for review. Profile completion uses the last-read saved names, with `builtin` for use/default. `history` completes to `history on` and `history off`.

### Turning Fusion on and off

```text
extension loads -> OFF: fusion_activate available; workflow tools hidden
                     |
             /fusion on or explicit Fusion request
                     v
                  ON: workflow tools + fusion_deactivate
                     |
             /fusion off or explicit stop request
             only when no run is unfinished
                     v
                  OFF
```

Fusion starts off every time the extension loads: starting Pi, `/new`, reload, resume, or fork. Its delegation/control descriptions and routing guidance are absent while off. Calls still attempted from older guidance refuse with `fusion is off; turn it on with /fusion on, or ask for Fusion by name`. Manual and automatic reviews start nothing while off; turning on starts no deferred review.

To turn it on, type `/fusion on` or explicitly ask for Fusion, such as “use Fusion to implement this.” The host calls `fusion_activate`, which starts no child; workflow tools/guidance become available from its next step, in the same turn.

A role/model/backend request alone (“plan this first,” “do a security audit,” “use ultracode,” “have Claude do it”) does not qualify. Nor do quoted instructions, discussion of Fusion, or earlier use in the conversation. These restrictions guide the host; they cannot prove a model followed them.

Turn it off with `/fusion off` or a plain request such as “turn Fusion off and work directly,” carried out through `fusion_deactivate`. **Finishing a task never turns it off.** Repeating a switch changes nothing and reports the current state.

After tool/natural-language activation, the host's next `agent_settled` shows one reminder:

```text
Fusion remains on. Use /fusion off or ask to turn it off when you're done.
```

The flag is cleared before notification. Background children may still be active; this is a host notification, not their completion or automatic deactivation. `/fusion on` suppresses the reminder, including when already on; successful off clears it.

Off refuses **unfinished** runs: running, waiting, or ended but still recording/delivering, reviews included. It names them, marking final ones as finishing. Wait or cancel, then retry. The refusal cancels nothing and hides no control tools; a refused deactivation tells the host to wait for your next instruction rather than do the child's work itself.

The mode exists only in this instance's memory. Status/dashboard/settings/history commands work while off and do not activate it. Profiles, the history preference and mode are independent; neither mode tool enables a role. In particular, turning Fusion on does not enable security in `builtin`. Existing records remain and can be continued after activation when their role/record permits it.

#### Active tools and allow lists

A switch changes only Fusion's active tools. On restores the saved workflow subset, including an empty subset, while preserving unrelated tools' state. One that was inactive stays inactive. Off leaves only activation; on leaves only deactivation among the mode tools.

Pi's allow list/exclusions decide what can be activated; Fusion never bypasses them. Include both mode tools for natural-language switching, and a delegation/control pair for usable workflows. Without mode tools, the commands still work. Reload does not preserve a pre-reload saved subset, and a model request already in flight keeps the tools/guidance it was sent. A host prompt override or another extension's tool changes are not overwritten into a guaranteed Fusion setup.

Settings can be applied while off: guidance refreshes but stays hidden until on. See [Profiles](profiles.md) for unfinished-run guards and rollback attempts.

## Status line, cards, and widget

The footer shows each active run as:

```text
run-3 implement · 12s · 4 tool calls · Bash npm test
```

The clock ticks each second. Activity can be a tool, thinking/text preview, or workflow progress; streamed deltas update at most four times a second. Foreground partial results show their own activity too.

Delegations, controls, and background/user messages render as terminal cards. A header names the invoked tool, handle, role, state, elapsed time, changed-file count, and estimated cost. Reviews name the run they review. Done is green, running/waiting yellow, and failed/aborted/cancelled red.

Collapsed cards show the first three nonempty report lines, excluding stats/review-link lines. **Ctrl+O** expands the wrapped report, highlighted Escalation/Review/Open questions sections, up to 50 changed paths, and the open question (up to 400 characters). Waiting cards show `/fusion answer` plus the appropriate `fusion_control message` or `claude_control message` hint. Background cards retain their run's pair; control results follow the control called. Both aliases manage every run, but Pi continuation hints always name `fusion`.

Terminal text strips escape sequences and control characters (except tab/newline), and cards respect the supplied width. This is terminal-output safety, not redaction or a transformation of the child text the host reads. Renderer tests cover fixed widths down to one column; no live-terminal qualification is claimed by those tests.

The optional widget above the editor lists active handles, activity, tools, live changed-file count, and answer hints. With a budget configured it adds usage/thresholds, and names how many Codex runs the estimate leaves out because Codex reports no cost. It disappears when the last run/session ends; `PI_FUSION_WIDGET=0` disables it without changing the footer. File counts sample Git at most once per ten seconds per coding run; ask runs are not sampled.

See [Questions](questions.md), [Independent reviews](reviews.md), and [Dashboard](dashboard.md) for their own operational details.
