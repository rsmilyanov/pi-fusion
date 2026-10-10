# pi-fusion vocabulary

Use these terms consistently in code, tool messages, and documentation. Behavioral detail belongs in the linked topic pages, not in competing definitions here.

## Language

**Host**:
The Pi model that talks with the user and decides which work to hand off. No particular model/provider is required.
_Avoid_: orchestrator, main model, parent

**Child**:
A headless coding session doing work the host handed off: Claude Code, Pi, or Codex, according to its backend.
_Avoid_: subagent, worker, delegate

**Backend**:
The implementation that runs a child: `claude`, `pi`, or `codex`. A backend owns its session shape, binding, and protocol; the host owns handles, records, and scheduling. See [Profiles](docs/profiles.md#what-a-call-runs-on) for selection and [Codex evidence](docs/codex-backend.md#evidence) for its qualification limits.
_Avoid_: adapter, provider, harness, runtime (as synonyms for backend)

**Role**:
The job a child does: `plan`, `implement`, `ultracode`, `ask`, or `security`. Role metadata defines capabilities; session settings choose enabled state, backend, model, and effort. See [Routing](docs/routing.md#choosing-a-role) for role selection and [Profiles](docs/profiles.md) for settings.
_Avoid_: agent type, tool, persona

**Run**:
One piece of work from delegation to report or failure. Continuing a handle adds a turn to the recorded child session, through a new backend invocation.
_Avoid_: job, task, call (as synonyms for run)

**Handle**:
The short name used to refer to a run, such as `run-3`. It is not the child's session identity.
_Avoid_: session id, run id, ticket

**Background run**:
A run that goes on after the host's delegation call returns, so the host can keep talking with the user.
_Avoid_: async run, detached run

**Question**:
A request for a small decision a child sends while it works. It is not an escalation that ends the run. See [Questions](docs/questions.md) for waiting, answering, and backend-specific limits.
_Avoid_: escalation, prompt, elicitation

**Waiting**:
The state of a run with an open question; its child waits for an answer and retains the active file-changing slot when applicable.
_Avoid_: blocked, paused, suspended

**Answer**:
The text supplied to a question through a control tool's `message` action or `/fusion answer`. Exactly one answer wins; a later attempt is told who answered first.
_Avoid_: reply, response, decision (as synonyms for answer)

**Handoff**:
An implicit `plan` continuation replaced by a fresh run on the same backend because of the context cap or an explicitly changed model. It carries the last agreed report, not the old transcript. Explicit `continue` is never handed off. See [The context cap](docs/runs.md#the-context-cap) for selection and warnings.
_Avoid_: rollover, compaction, reset

**Escalation**:
The part of an `implement` report saying the task needs wider scope or an unresolved design decision. The run ends rather than waiting or widening its brief.
_Avoid_: question, blocker

**Steer**:
Text sent to a running child with no open question. Acceptance for delivery does not prove model consumption or action; a late steer can remain unread. Ordinary editor text targets the host. See [Background controls](docs/runs.md#background-runs) for delivery, refusal, and queue rules.
_Avoid_: interrupt, nudge, follow-up

**Review run**:
A fresh background `ask` run in review mode, linked to the ended `implement`, `ultracode`, or `security` run it reviews. It uses this session's configured **ask** backend, model, and effort, inheriting nothing from the reviewed run. `/fusion review` starts one manually; `PI_FUSION_AUTO_REVIEW` can start one automatically. See [Independent reviews](docs/reviews.md).
_Avoid_: self-review, verification, QA run

**History**:
The opt-in disk record of a durable host Pi session's runs, used by later processes for reports, usage, and dashboard restoration. Each Fusion instance decides once at startup whether to keep it: a saved preference (`/fusion history on|off`), else `PI_FUSION_HISTORY`. Continuation authority remains the custom entries on the host's current branch.
_Avoid_: log, cache, transcript
