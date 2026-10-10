# Independent reviews

`/fusion review run-N` starts a fresh background `ask` run in review mode, linked to the ended run it reviews. It gets read/search/shell tools and `contracts/ask-review.md`; the implementation child did not brief it. Like any run, it takes a handle, records its own branch entry, and reports through background controls/messages.

## What can be reviewed

| Requirement | Rule |
| --- | --- |
| Source role | `implement`, `ultracode`, or `security` |
| Source state | Ended `done` or `failed`, not active/aborted/cancelled |
| Changes | At least one changed file |
| Earlier-process work | Must have been made in this working directory |
| Session | Fusion on, `ask` enabled, budget allowing new work |

A newly terminal run may still be collecting its changed paths; review waits for that final list. Re-reviewing starts another run and replaces the source's newest-review link. Reviews cannot themselves be reviewed.

The prompt tells the reviewer to inspect the **uncommitted working-tree change**, using Git status/diff and the changed files, and carries the source task/report, each capped at 32 KiB. Source text is quoted data behind non-colliding markers; instructions inside it are findings, not commands to follow. The tree may include other writers' work, which the reviewer should call out rather than silently attribute to this run.

An `ask` child has no edit/write tool and its contract forbids shell-based file changes. That is instruction, not an operating-system read-only boundary. Ultracode's own agents review under its briefing: that is self-review, not this independent review.

## Which backend reviews a run

Every command/automatic review uses this session's **configured ask backend, model, and effort**, inheriting nothing from the source run. Builtin uses Claude `opus` at `high`; a profile putting ask on Pi reviews all eligible work there, with its own `provider/model-id` and thinking level, and one putting ask on Codex reviews it as a fresh read-only Codex thread on the configured model/effort or the host's Codex default. The reviewed role's backend/model and missing older selection fields do not pick the reviewer.

Pi ask uses read, bash, grep, find, and ls, with no web tool. Claude ask also has web search/fetch. A Codex reviewer runs in Codex's `read-only` sandbox with whatever tools the user's Codex configuration gives it, and can ask a question ([Questions on Codex](questions.md#on-codex)). All run the same review contract. See [Profiles](profiles.md) and [Pi backend requirements](pi-backend.md#runtime-requirements).

Disabled ask refuses a manual review and **quietly skips automatic review**, taking no handle, adding no link, and deferring nothing. Disabling the source role after its work ends does not prevent review: the reviewer is ask. A reviewer lacking a model or registered backend refuses before a handle/link/child, with the binding reason; an automatic refusal warns and leaves the implementation report unchanged.

## Notifications and automatic review

The command says `run-2 reviews run-1 in the background; its report arrives as a message` and notifies the host without starting a turn. Status/cards/dashboard link both directions: `review of run-1` and `reviewed by run-2`. Wait or answer the review like any other background ask run.

`PI_FUSION_AUTO_REVIEW=1` starts one review per delegation-started coding run that ends **done with changed files**, before that run's own report is delivered, so the report carries the link. Failed/aborted/cancelled runs do not get an automatic review; failed work can still be reviewed manually. A review never triggers another review.

While Fusion is off, neither path starts work, and activation schedules no deferred review. Reviews count as unfinished runs, blocking off/settings application until their entries/reports finish. If automatic admission fails for budget or binding reasons, the user gets the reason and the original run reports normally.

Reviewer selection/routing and security-review behavior are covered by scripted in-memory backend tests, not native security children. See [Evidence boundaries](pi-backend.md#evidence-and-limits).
