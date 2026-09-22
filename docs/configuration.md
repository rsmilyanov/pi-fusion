# Configuration


| Variable | Default |
| --- | --- |
| `PI_FUSION_PLAN_MODEL` | `fable` (a Claude Code model alias or id) |
| `PI_FUSION_IMPLEMENT_MODEL` | `opus` |
| `PI_FUSION_IMPLEMENT_EFFORT` | `high` |
| `PI_FUSION_ULTRACODE_MODEL` | `fable` |
| `PI_FUSION_ULTRACODE_PERMISSION_MODE` | `bypassPermissions` |
| `PI_FUSION_ASK_MODEL` | `opus` |
| `PI_FUSION_ASK_EFFORT` | `high` |
| `PI_FUSION_ULTRACODE_WORKFLOW_SIZE` | unset; `small`, `medium`, `large` or `unrestricted` sets Claude Code's `workflowSizeGuideline` for the child |
| `PI_FUSION_CLAUDE_BIN` | unset; the Claude Code binary bundled with the SDK. Set it to run another `claude` executable, for example the one on `PATH` |
| `PI_FUSION_DASHBOARD_OPEN` | unset; `0` stops `/fusion dashboard` from opening the browser and only shows the URL |
| `PI_FUSION_WIDGET` | unset; `0` stops the widget over the editor that names the active runs |
| `PI_FUSION_BUDGET_WARN_USD` | unset; one amount or a comma-separated list, such as `5,20`: the user is warned once at each amount the session's estimated cost reaches |
| `PI_FUSION_BUDGET_LIMIT_USD` | unset; one amount: at or over it no new run starts, no run is continued and no review starts. It cancels nothing |
| `PI_FUSION_PLAN_CONTEXT_PCT` | `35`; the share of its context window, in percent, at which a plan run is handed off to a fresh one instead of continued, and at which a `continue` of any run says so in its result. `0` turns both off |
| `PI_FUSION_AUTO_REVIEW` | unset; `1` starts an independent review of every `implement` or `ultracode` run the `claude` tool started that ends `done` with changed files |
| `PI_FUSION_HISTORY` | unset; `1` keeps the runs of each Pi session that has a session file on disk, prompts and reports included, so a later Pi process on the same session can show them |
| `PI_FUSION_HISTORY_DIR` | unset; the directory those files go in. The default is `pi-fusion/history` under `PI_CODING_AGENT_DIR`, which is `~/.pi/agent` |

Each variable applies to the role in its name. A call's `model` or `effort` parameter wins over the variable for that call.

The two budget variables are not role variables, and neither are `PI_FUSION_WIDGET`, `PI_FUSION_PLAN_CONTEXT_PCT`, `PI_FUSION_AUTO_REVIEW`, `PI_FUSION_HISTORY` and `PI_FUSION_HISTORY_DIR`. The budget variables and `PI_FUSION_PLAN_CONTEXT_PCT` are read when Pi loads the extension; see [Session usage and budget](#session-usage-and-budget) and [the context cap](runs.md#the-context-cap).

Role `plan` runs at effort `xhigh` unless a call passes `effort`; there is no variable for it. Role `ultracode` always runs at effort `ultracode`, which is Claude Code's `xhigh` tier plus the standing Workflow opt-in. Passing `xhigh` itself would keep the reasoning level but drop the workflows. The workflow agents' model and effort (Opus 5, xhigh) live in the implementer contract, not in a variable.

The role contracts are the Markdown files under `contracts/`, passed to each child as an appended system prompt. Edit them to change how a role behaves.

The `implement` and `ultracode` contracts' "do not commit" is an instruction in those contracts, not an enforced restriction.
## Session usage and budget

The extension adds up what the `claude` calls of this Pi session have spent. Each call reports its own running total, and the newest total replaces the one before it, so an update while a child works never counts twice; a continued run is another call and adds its own. `/fusion status` always ends with the totals, whether or not a budget variable is set:

```
session usage: est. $0.2500 · in 12.3k out 4.5k tokens · workflow agents 0 tokens · 3 calls
```

The dashboard header shows the same totals, and `claude_control status` and the `claude` tool carry them in their result details, whether the call returns a report, a background handle or an open question. The cost is the Agent SDK's estimate at list prices, which is not a charge under a subscription, and it updates when a child turn ends, so it lags the work in flight.

`PI_FUSION_BUDGET_WARN_USD` takes one amount or a comma-separated list, such as `5,20`. Each amount warns once: when the estimate reaches it, the user gets a notice with the total and the threshold, and that threshold stays quiet for the rest of the Pi process. A warning changes nothing else.

`PI_FUSION_BUDGET_LIMIT_USD` takes one amount. At or over it the `claude` tool refuses a new run and a `continue`, and a review is refused the same way, whether `/fusion review` or `PI_FUSION_AUTO_REVIEW` asked for it. The message names the estimate and the limit. No run is ever cancelled for cost, and the extension still passes no `maxBudgetUsd` and no `maxTurns` to a child, so a run that is already going spends what it needs; because the estimate lags, a session can end over its limit. Raise or unset the variable and restart Pi to start runs again.

Both variables are read when Pi loads the extension. Changing them in the shell afterwards does nothing until Pi restarts. A variable that is set and names no dollar amount turns its control off, and the first `claude`, `claude_control` or `/fusion` call of the process says so once, for example `fusion: PI_FUSION_BUDGET_LIMIT_USD=1,000 is not a dollar amount; no limit is set`.

All four roles are always available; there is no switch to turn one off.
