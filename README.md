# pi-fusion

A [Pi](https://pi.dev) extension for handing work to headless Claude Code, Pi, or Codex sessions. The **host** talks with you; a **child** plans, implements, answers, or reviews a bounded task.

Fusion starts **off**. Type `/fusion on`, or ask “use Fusion to implement this.” It stays on until `/fusion off`, an explicit request to turn it off, or the extension reloads. Turning it on starts no child. After natural-language activation, one reminder tells you that Fusion remains on; finishing a task does not turn it off.

## Install and quick start

```bash
cd /path/to/pi-fusion
npm install
pi install /path/to/pi-fusion
cd /path/to/your-project
pi
```

Use whichever host model you normally use in Pi; Fusion does not require a particular host model or provider.

In Pi:

```text
/fusion on
Use Fusion to implement the agreed change and verify it. Do not commit.
/fusion status
/fusion dashboard
/fusion off
```

Off is refused while a run is running, waiting for an answer, or finishing its record/report. Wait or cancel it, then retry.

### Requirements

- Pi with the required extension/public SDK APIs. Tests pin 1.0.2; [manual qualification](docs/pi-backend.md#evidence-and-limits) covers 0.85.1 and 1.0.1 only. Incompatible child APIs refuse startup.
- `npm install` installs the Claude Agent SDK and its bundled Claude Code binary (about 200 MB). A separate `claude` executable on `PATH` is not required.
- For Claude children, Claude Code authentication on this machine and access to the configured models. Children use that account's capacity; the SDK's dollar estimate is not a subscription charge. See Anthropic's [subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- For Pi children, an importable npm installation of Pi, `node` on `PATH`, and a configured/authenticated provider and model. A compiled Pi binary cannot supply the package a child imports. See [Pi backend requirements and limits](docs/pi-backend.md).
- For Codex children (optional), an installed `codex` with its own login/configuration. Located only at run start via `PATH` or absolute `PI_FUSION_CODEX_BIN`; Fusion installs/authenticates nothing and adds no dependency. Missing Codex does not prevent extension load; Windows runs refuse. See [inherited install](docs/codex-backend.md#inheritance-not-isolation) and [qualification limits](docs/codex-backend.md#evidence).

## Roles and backends

Claude, Pi, and Codex backends are registered. Profiles select the backend, model, effort, and enabled setting of each role.

| Role | Purpose | Supported backends | Built-in setting |
| --- | --- | --- | --- |
| `plan` | Challenge a design and agree numbered tasks with acceptance criteria | Claude, Pi, Codex | Claude `fable`, `xhigh` |
| `implement` | Implement and verify one clear, bounded task | Claude, Pi, Codex | Claude `opus`, `high` |
| `ultracode` | Use Claude workflows to implement, verify, and self-review larger work, only when requested | Claude only | Claude `fable`, fixed `ultracode` effort |
| `ask` | Answer a code question, or independently review with `mode: "review"` | Claude, Pi, Codex | Claude `opus`, `high` |
| `security` | Investigate a scoped security concern; fix application code only when the task authorizes it | Pi only | **Disabled**, no model default |

Enable `security` through `/fusion config` or a saved profile. Setting its model does not enable it, and even when enabled the host uses it only for an explicit security investigation, audit, or fix request.

Pi roles have no model default. For example, the host can call `fusion` with:

```json
{ "role": "implement", "task": "Implement and test the agreed change", "backend": "pi", "model": "deepseek/deepseek-chat" }
```

Alternatively, configure that role through `/fusion config` or `PI_FUSION_PI_IMPLEMENT_MODEL`. A profile can route fresh runs to Pi without a `backend` parameter. Continuations stay on their recorded backend and selection unless a permitted model/effort override is supplied. Nothing falls back to Claude when a Pi call fails.

Codex is opt-in: name `backend: "codex"` or configure a role there; builtin routes nothing to it. Model and effort may be omitted to use your own Codex defaults. Children inherit your Codex home, configuration, and login, and delegated connections opt into its experimental question API. Cost is unknown and excluded from the dollar estimate. See [Codex behavior and qualification limits](docs/codex-backend.md).

The host's routing guidance is: plan when the design is unresolved, implement bounded tasks in dependency order, and use `ultracode` only when you ask. [Role settings](docs/profiles.md) can disable any role. The [contracts](contracts/) define each child's behavior; these instructions are not a sandbox or permission boundary.

## Tools and controls

- `fusion` delegates; `fusion_control` manages background runs through `status`, `wait`, `message`, and `cancel`.
- `claude` is the compatibility delegation tool, forced to Claude Code. `claude_control` is the same control executor under its older name. Either control manages every run; Pi continuations and Codex runs require `fusion`.
- `fusion_activate` and `fusion_deactivate` switch mode and start no child. Only the tool that leaves the current mode is active.

Generated hints follow the tool pair called. The user commands always remain `/fusion ...`:

```text
/fusion status run-3
/fusion answer run-3 Use the existing public name
/fusion steer run-3 Also check the migration test
/fusion wait run-3
/fusion cancel run-3
/fusion review run-3
```

Ordinary editor text goes to the host, not automatically to a child. A steer accepted for delivery is not proof that the child's model consumed or acted on it. Only one file-changing run can be active across all backends; `ask` runs can run beside it.

To use a strict Pi tool allow list, include the delegation/control pair and both mode tools, for example:

```bash
pi --tools read,grep,find,ls,bash,fusion,fusion_control,fusion_activate,fusion_deactivate
```

Fusion never bypasses that list. Omitting the mode tools leaves `/fusion on` and `/fusion off` available, but prevents switching by natural-language tool calls. Add `claude,claude_control` if you want the compatibility pair too.

While on, the host is instructed to delegate implementation and not edit files itself. That is guidance: its shell tool can still write files. Removing that tool also removes the host's ability to run Git. Cancellation does not undo changes, and descendant cleanup is bounded best effort, not process isolation.

## Documentation

- [Routing](docs/routing.md): planning, implementation, escalation, and explicit opt-ins.
- [Runs and tool parameters](docs/runs.md): handles, continuation, forks, background controls, cancellation, and history.
- [Questions](docs/questions.md): the child's waiting state and exactly-one-answer flow.
- [User commands and terminal UI](docs/fusion-command.md): activation, reminders, cards, and the widget.
- [Profiles and role settings](docs/profiles.md): configure roles and save named profiles.
- [Configuration](docs/configuration.md): environment variables and the session budget.
- [Independent reviews](docs/reviews.md): manual and automatic `ask` review runs.
- [Ultracode](docs/ultracode.md): Claude workflows, permission modes, and cost.
- [Dashboard](docs/dashboard.md): local, read-only monitoring and sensitive-output limits.
- [Pi backend](docs/pi-backend.md): architecture, storage, runtime checks, and qualification limits.
- [Codex backend](docs/codex-backend.md): inherited install, lifecycle, continuation, steers, and recorded qualification limits.
- [Development](docs/development.md): module map, deterministic tests, and manual harness commands.

Change role behavior in `contracts/*.md`. Children are instructed not to commit; the host commits only when you ask.
