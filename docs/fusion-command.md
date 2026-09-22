# The /fusion command and the terminal UI

## The /fusion command

`/fusion` is the user's side of the same runs `claude_control` acts on for the host.

- `/fusion dashboard` starts or reopens the monitoring page, and `/fusion dashboard stop` closes it (see [Monitoring dashboard](dashboard.md)).
- `/fusion status` lists every run of this Pi session, then the runs an earlier Pi process left behind, then what the session has cost. `/fusion status run-N` adds that run's activity, tool call count, the files it has changed so far and its `claude --resume` line.
- `/fusion cancel run-N` stops the run and marks it `cancelled`. The failure text reads `implement cancelled by the user`, and the host still gets the background end notice carrying it, so the cancel never hides the end of a run from the host.
- `/fusion steer run-N <text>` pushes the text to a running child, which reads it when it next takes input. A run that waits for an answer is not steered; the notice points at `/fusion answer` instead.
- `/fusion wait run-N` shows the run's activity line and a clock that ticks once a second until the run ends or asks a question. Esc leaves the run running and says so. The wait never takes the report away from the host: a user wait and the host's own `claude_control wait` are counted apart, so the run's notice still goes out.
- `/fusion answer [run-N] [text]` answers a waiting run's question, and opens an editor for the answer when no text follows the handle (see [Questions](questions.md)).
- `/fusion review run-N` starts an independent review of a run that has ended (see [Independent reviews](reviews.md)).

Argument completion offers the forms, and after a form that takes a handle it offers the handles that form can still act on: every run for `status`, this process's and an earlier one's, the active ones for `cancel` and `wait`, the running ones for `steer`, the waiting ones for `answer`, and the reviewable ones, this process's and an earlier one's that was made in this working directory, for `review`.

Everything the user does through `steer`, `answer` and `review` reaches the host as a message with `triggerTurn: false` and `deliverAs: "followUp"`: it starts no turn, so the user keeps the floor, and the host reads it with its next turn. The message names the run and what the user did, so the host does not repeat work the user has already settled.
## The status line

While a child runs, the status line shows `<handle> <role> · <seconds> · <n> tool calls · <activity>` for every active run, separated by `|`, and a foreground call's partial result shows its own line. The clock ticks every second. The activity is the tool the child is running, the latest line of the model's thinking, the tail of the text it is writing, or workflow progress, so a two-minute Fable turn at xhigh shows as `thinking · <latest summary>` rather than a frozen line. Streamed deltas update the line at most four times a second.

## Terminal cards and the run widget

In the Pi TUI a `claude` call, a `claude_control` result and the extension's background-run messages render as a card: one header line and a short body. The header reads `claude implement run-3 · done · 12s · 2 files · $0.2534`, with the state colored by what it means for the host (green done, yellow running or waiting, red failed, aborted or cancelled), and a review names the run it reviews: `ask, review of run-1`. A message header says whose action it was: `run`, `user steer`, `user answer` or `user review`.

Collapsed, the body is the first three report lines that carry text, without the stats line and the review line, each cut to the width, with `… 4 more lines, ctrl+o to expand` under them when the report has more; a run that waits shows its question and `answer: /fusion answer run-3 <text> or claude_control message` instead. Ctrl+O expands the same card to the whole report, wrapped instead of cut, with the `Escalation`, `Review` and `Open questions` headings highlighted, up to 50 changed paths under a `files (n)` line, and the open question up to 400 characters. No card line is ever wider than the width the TUI gives it. Every piece of text a child wrote is stripped of escape sequences and of control characters, tab and newline apart, before it becomes a card line, a widget line, the footer status line or a `/fusion` notice, which is what Pi's own renderer does for a tool result it prints itself: a report, an activity line or a question cannot clear the screen, write the clipboard or hide a link in the transcript. What `claude_control` returns is left as the child wrote it: the host model reads it as data, not as terminal output.

The cards were tested with the pi-tui renderer at fixed widths, from 1 column up, and not yet looked at in a live Pi terminal.

While runs are active, a widget over the editor names each one: `run-3 implement · 12s · 4 tool calls · Bash npm test · 2 files`, or `run-3 implement · waiting: Which name? · answer: /fusion answer run-3 <text>`. With `PI_FUSION_BUDGET_WARN_USD` or `PI_FUSION_BUDGET_LIMIT_USD` set it ends with `session usage: est. $0.2500 · warn at $0.1000 · limit $5.00`; without either, the widget shows the runs alone. The widget goes when the last run ends and when the session closes; the footer status line stays as it was. The file count comes from a `git status` sample taken at most once every ten seconds per run, and an `ask` run, which changes no files, is never sampled. `PI_FUSION_WIDGET=0` turns the widget off and leaves everything else as it is.
