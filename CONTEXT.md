# pi-fusion

A Pi extension in which the host model hands work to headless Claude Code sessions and manages them while they work.

## Language

**Host**:
The Pi model that talks with the user and decides which work to hand off.
_Avoid_: orchestrator, main model, parent

**Child**:
A headless Claude Code session that does work the host handed off.
_Avoid_: subagent, worker, delegate

**Role**:
The job a child does: `plan`, `implement`, `ultracode` or `ask`. A role fixes the child's contract, tools and default model and effort.
_Avoid_: agent type, tool, persona

**Run**:
One piece of work a child does for the host, from the host's call to the child's report or failure. Continuing a run adds a turn to the same child session.
_Avoid_: job, task, call

**Handle**:
The short name the host uses to refer to a run, such as `run-3`.
_Avoid_: session id, run id, ticket

**Background run**:
A run that goes on after the host's tool call returns, so the host can keep talking with the user.
_Avoid_: async run, detached run

**Question**:
A request for a decision that a child sends to the host while it works.
_Avoid_: escalation, prompt, elicitation

**Waiting**:
The state of a run whose child has an open question and does no work until it gets an answer.
_Avoid_: blocked, paused, suspended

**Answer**:
The reply a question gets, from the host through `claude_control message` or from the user through `/fusion answer`. A question takes one answer; whoever is second is told who answered first.
_Avoid_: reply, response, decision

**Handoff**:
A `plan` call that starts a fresh run, carrying the replaced run's last report, rather than continue a plan run whose context has passed its cap. A `continue` call names its run and is warned instead, never handed off.
_Avoid_: rollover, compaction, reset

**Escalation**:
The part of an `implement` report that says the task needs a wider scope or a design decision. The run ends; it does not wait.
_Avoid_: question, blocker

**Steer**:
A message from the host to a running child when the child has no open question. The child reads it at its next model turn.
_Avoid_: interrupt, nudge, follow-up

**Review run**:
A background `ask` run that reviews the working-tree change of an ended `implement` or `ultracode` run. The user starts one with `/fusion review`, or the extension starts it with `PI_FUSION_AUTO_REVIEW`. It gets its own handle and links to the run it reviews.
_Avoid_: self-review, verification, QA run

**History**:
The opt-in on-disk record of a Pi session's runs that a later Pi process on the same session reads: the earlier processes' runs, what they spent and their dashboard entries.
_Avoid_: log, cache, transcript
