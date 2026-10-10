# Routing

This guidance applies only while Fusion is **on**. Asking for a role, model, or backend without asking for Fusion does not activate it. See [Turning Fusion on and off](fusion-command.md#turning-fusion-on-and-off).

## Choosing a role

The host can be any Pi model/provider. Its tool guidance asks whether the design is unresolved: competing approaches, unclear requirements, shared-interface changes, or risk that reading the code cannot bound.

```text
Design unresolved?
  yes -> plan -> agreed numbered tasks -> implement, task by task
  no  -> implement one clear, bounded task

Explicit ultracode request -> ultracode, optionally after plan
Explicit security request  -> security, once separately enabled/configured
Code question or review    -> ask (mode answer or review)
```

Skip planning when the host can state what to change, where, acceptance criteria, and verification. Send implementation to `implement` in dependency order, however complex or risky; do not select `ultracode` merely because the work looks difficult. Only an explicit user request authorizes that route, even if a plan recommends it.

Security is **disabled in `builtin`**. Enable it through [settings or a profile](profiles.md) and configure a Pi model. Even then, the host uses it only when you ask for a security investigation, audit, or fix, not because other work looks security-sensitive. A task without fix authorization reports findings and changes no application code; an authorized fix should be the smallest verified change that closes the finding. Findings carry severity and confirmed/inferred evidence; secrets and personal data are named by location, never reported by value. Security has coding tools and takes the single file-changing slot; its contract is not an access-control boundary.

Disabled roles are not recommended and calls to them refuse. If a design question requires a disabled planner, the host tells you rather than silently enabling it. Disabling `ask` leaves no independent reviewer. Your request can ask for or skip planning, but cannot bypass a disabled setting.

## Selecting a backend and model

Unless you name overrides, the host leaves `backend`, `model`, and `effort` unset and uses the session's configured settings.

```text
builtin
  +-- plan / implement / ultracode / ask -> Claude
  +-- security                          -> Pi, disabled
  +-- no role                           -> Codex

Codex opt-in -> backend: "codex", or role settings/profile
```

Security needs separate activation and a Pi model; once enabled, its calls need no backend override. Ultracode is Claude-only. Codex supports `plan`, `implement`, and `ask` through your own install and defaults. Questions opt the whole connection into Codex's `experimentalApi`; see [Codex behavior](codex-backend.md) and [qualification limits](codex-backend.md#evidence).

An explicit other-backend override uses that backend's captured legacy defaults, not the configured backend's model/effort. Pi requires an exact `provider/model-id` and guesses none. Unsupported role/backend combinations refuse before admission, once the enabled-role check permits routing.

`claude` is a forced-Claude compatibility tool. Guidance recommends `fusion` for Pi-configured roles unless you explicitly request Claude Code. A continuation stays on its recorded backend/selection; a Pi or Codex run always needs `fusion`. Switching profiles does not move recorded threads.

Implicit `plan` calls continue the latest plan on the routed backend, or hand off for its context cap or an explicitly changed model. An unreadable latest record refuses instead of falling back to another plan. See [Runs](runs.md) and [Profiles](profiles.md) for parameters and precedence.

## Briefs, escalation, and review

Children do not see the host conversation. Each brief must state the goal, settled decisions, constraints, acceptance criteria, and verification in readable prose. Tasks and context must preserve spaces between words, not concatenate them to shorten prompts. Pass earlier reports as context and check each result before admitting the next task.

An `implement` report's **Escalation** means the task needs broader scope or an unresolved design decision. The run ends; it does not wait or widen the task. Keep verified changes, then take the design question to an enabled `plan` role or give a new `implement` run a wider agreed brief.

Ultracode's agents verify/review work under the implementer's own briefing: that is **self-review**. Independent review is a fresh `ask` run with `mode: "review"`, using the session's `ask` settings, not the model/backend of the implementation. See [Independent reviews](reviews.md).

The host reports handles for background runs, checks failures rather than doing the work itself, summarizes changes/verification/findings, and includes the accepted resume command or transcript file from each run's stats. Children are instructed not to commit; the host commits only on request.

Routing lives in tool guidelines and contracts. It is model guidance, not enforced isolation: the host and shell-equipped children can still change files.
