# pi-fusion

A [Pi](https://pi.dev) extension that gives the host model two tools: `claude`, which hands a job to a headless Claude Code session, and `claude_control`, which manages the sessions that run in the background. One model orchestrates, others do the thinking and the work.

## Roles

The `role` parameter of `claude` picks the job.

| Role | Model and effort | Tools given to the child | Purpose |
| --- | --- | --- | --- |
| `plan` | `fable`, xhigh | Read, Bash, Edit, Write, Grep, Glob | Challenge a plan and return an agreed, numbered task list. |
| `implement` | `opus`, high | Read, Bash, Edit, Write, Grep, Glob | Implement one clear, bounded task. |
| `ultracode` | `fable`, ultracode | Claude Code's own, plus Workflow, Agent and the user's MCP servers | Complex, uncertain or high-risk work, or a whole agreed plan. |
| `ask` | `opus`, high | Read, Bash, Grep, Glob, WebSearch, WebFetch | Answer a question about the code, or review a change with `mode: "review"`. Changes no files. |

## Parameters

`role` and `task` carry the job; the rest are optional.

| Parameter | Applies to | Meaning |
| --- | --- | --- |
| `role` | all | Required unless `continue` is set. |
| `task` | all | The brief, or the follow-up message for a continued run. |
| `context` | all | Appended to the task under `## Context`. |
| `continue` | all | A run's handle. Sends the task to that run as a follow-up. |
| `background` | all | `true` returns the handle at once and lets the run go on. |
| `fresh` | `plan` | Start a new plan run. Not allowed with `continue`. |
| `mode` | `ask` | `answer` (default) sends `contracts/ask-answer.md`, `review` sends `contracts/ask-review.md`. |
| `model` | `implement`, `ask` | Replaces the role's model for one call. |
| `effort` | `plan`, `implement`, `ask` | `low`, `medium`, `high`, `xhigh` or `max`. |

`ultracode` takes neither `model` nor `effort`, because any other effort turns its workflows off. A parameter the role does not take fails the call before a child starts, with an error such as `effort is not allowed for role ultracode`. Both tools are registered `executionMode: "sequential"`, so their calls run one at a time: Pi runs every tool call in a turn sequentially as soon as one of them is sequential.

## How a child runs

Every child is a headless Claude Code session in the host's working directory, started through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). The SDK bundles its own Claude Code binary, so nothing has to be on `PATH`. The child uses the Claude Code login on this machine and that subscription, loads the user's settings, plugins and the project's CLAUDE.md, and leaves a normal session behind, so `claude --resume <session id>` opens any child's transcript. Each tool result ends with a stats line naming the handle, the role, the model and that command.

`plan`, `implement` and `ask` children get the tools listed above plus `ask_orchestrator`, and no other MCP servers whatever the configuration says. An `ultracode` child is a full Claude Code session. The role contracts under `contracts/` are appended to the system prompt. The `ask` child has no Edit or Write, and its contract forbids changing files through Bash; that is an instruction to the model, not enforcement.

While a child runs, the status line shows `<handle> <role> · <seconds> · <n> tool calls · <activity>` for each active run. Esc aborts a foreground call: the extension sends SIGTERM to the child's process group and every descendant, then SIGKILL 5 s later, so a Bash command the child started dies with it.

## Routing

The host model is the orchestrator. Its guidelines ask two questions: is the design unresolved, and which implementer role fits the complexity and risk. That leaves three routes: straight to `implement`; `plan` first, then `implement` task by task; or `ultracode`, with or without `plan`.

Your explicit choice wins. Ask for Opus and the host uses `implement`, ask for Fable or ultracode and it uses `ultracode`, and ask for or skip planning as you like. For an independent review, the host calls `ask` with `mode: "review"`. See [Routing](docs/routing.md).

## Requirements

- Pi 0.85.1 or newer.
- `npm install` in this directory. It installs `@anthropic-ai/claude-agent-sdk` and the Claude Code binary for this platform, about 200 MB. The pinned SDK bundles Claude Code 2.1.273.
- Claude Code logged in on this machine to a Max, Team or Enterprise plan, for Fable and 1M-context Opus.
- ChatGPT subscription login in Pi for `openai-codex/gpt-6-astra`.

Anthropic's [help center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the Agent SDK draws from the subscription's usage limits. Every child counts against them.

## Install

```bash
npm install
pi install ~/eng/pi-fusion
pi --model openai-codex/gpt-6-astra --thinking high
```

Pi activates every extension tool at startup, so `claude` and `claude_control` sit next to Pi's built-ins. To pin the list down, pass `--tools read,grep,find,ls,bash,claude,claude_control`. `--tools` is a strict allowlist: leaving `claude` out leaves the host with no delegation, and leaving `claude_control` out leaves background runs unmanaged.

The guidelines tell the host to delegate every implementation task and not to edit files itself. That is an instruction, not enforcement: the host still has bash. To enforce it, drop bash from the tool list. The cost is that the host can no longer run git itself.

## Documentation

- [Runs, handles and background work](docs/runs.md) — handles, `continue`, resumes and forks, the context cap, `claude_control`, and runs an earlier Pi process left behind.
- [Questions](docs/questions.md) — how a child asks the host or the user for a decision and waits for the answer.
- [The /fusion command and the terminal UI](docs/fusion-command.md) — the user's own controls, the run cards and the widget.
- [Independent reviews](docs/reviews.md) — `/fusion review` and `PI_FUSION_AUTO_REVIEW`.
- [Monitoring dashboard](docs/dashboard.md) — the local read-only web page.
- [The ultracode role](docs/ultracode.md) — what the workflow opt-in does and what it costs.
- [Configuration](docs/configuration.md) — every environment variable, and the session cost estimate with its warnings and limit.
- [Development](docs/development.md) — the test suite and the fake Claude Code binary.

The role contracts are the Markdown files under `contracts/`. Edit them to change how a role behaves.
