# Configuration

Use [profiles and role settings](profiles.md) for session configuration; environment variables supply the captured built-in/one-off backend defaults and other controls below. No variable switches Fusion mode or enables a disabled role.

## Environment variables

| Variable | Default / purpose |
| --- | --- |
| `PI_FUSION_PLAN_MODEL` | Claude `fable` |
| `PI_FUSION_IMPLEMENT_MODEL` | Claude `opus` |
| `PI_FUSION_IMPLEMENT_EFFORT` | Claude `high` |
| `PI_FUSION_ULTRACODE_MODEL` | Claude `fable` |
| `PI_FUSION_ULTRACODE_PERMISSION_MODE` | `bypassPermissions`; see [Ultracode](ultracode.md) |
| `PI_FUSION_ULTRACODE_WORKFLOW_SIZE` | Unset; `small`, `medium`, `large`, or `unrestricted` sets the child's advisory workflow size |
| `PI_FUSION_ASK_MODEL` | Claude `opus` |
| `PI_FUSION_ASK_EFFORT` | Claude `high` |
| `PI_FUSION_PI_<ROLE>_MODEL` | Unset; Pi `provider/model-id` for `PLAN`, `IMPLEMENT`, `ASK`, or `SECURITY` |
| `PI_FUSION_PI_<ROLE>_EFFORT` | Unset; optional thinking level for the same Pi roles |
| `PI_FUSION_CODEX_<ROLE>_MODEL` | Unset; Codex model id for `PLAN`, `IMPLEMENT`, or `ASK`; unset means the host's Codex default |
| `PI_FUSION_CODEX_<ROLE>_EFFORT` | Unset; optional Codex effort for the same roles |
| `PI_FUSION_CLAUDE_BIN` | Unset; use the SDK's bundled binary. Set a path to another executable; `.js`, `.mjs`, and `.cjs` paths run under Node |
| `PI_FUSION_CODEX_BIN` | Unset; use the first executable `codex` on the inherited `PATH` (empty/relative entries resolve against the host cwd). Set an absolute path to a regular file; `.js`, `.mjs`, and `.cjs` paths run under the host's own Node executable (`process.execPath`), others must be executable. Read only when a Codex run starts, never at load: a missing `codex` fails that run and nothing else. Windows is refused |
| `PI_FUSION_DASHBOARD_OPEN` | Unset; `0` shows the dashboard URL without opening a browser |
| `PI_FUSION_DASHBOARD_MAX_RUNS` | `30`; positive decimal safe integer run-retention target for the in-memory store, captured at extension load; override with `/fusion dashboard limit N`. It never deletes disk history or changes the 30-run archive page. See [Dashboard](dashboard.md#rendering-and-retained-data) |
| `PI_FUSION_WIDGET` | Unset; `0` hides the run widget, not the footer status |
| `PI_FUSION_BUDGET_WARN_USD` | Unset; amount or comma-separated amounts, e.g. `5,20`, warning once at each threshold |
| `PI_FUSION_BUDGET_LIMIT_USD` | Unset; amount at/above which no new run, continuation, or review starts; cancels nothing |
| `PI_FUSION_PLAN_CONTEXT_PCT` | Overrides saved `plan.contextPct`, otherwise `35`; plan cap-handoff and continuation-warning percentage; `0` disables those context-based actions |
| `PI_FUSION_AUTO_REVIEW` | Unset; `1` reviews completed coding runs with changed files, using configured `ask` settings |
| `PI_FUSION_HISTORY` | Unset; compatibility fallback captured at instance start: `1` turns [history](runs.md#turning-history-on-and-off) on when no preference is saved in [the settings file](#the-fusion-settings-file). History saves prompts/reports/usage to private version-1 JSON files for durable host sessions, and lets the dashboard list [archived runs](dashboard.md#archived-runs) |
| `PI_FUSION_HISTORY_DIR` | Unset; default `<agent dir>/pi-fusion/history` |

Role model/effort variables are read once when the extension instance starts. Changing the shell afterwards requires a new instance. A profile is a complete snapshot and never falls back to a variable for an omitted configured field. An explicit call naming another backend uses that backend's captured legacy defaults, not the model of the configured backend.

The built-in configuration enables every role except **security**, whose backend is Pi. `PI_FUSION_PI_SECURITY_MODEL` supplies its model, not its enabled state. Saved profiles retain their own enabled settings. Backend capabilities are code: `ultracode` is Claude-only, `security` Pi-only, and Codex supports `plan`, `implement`, and `ask` runs (see [Codex backend](codex-backend.md)); disabling a role does not unregister a backend.

Claude plan effort defaults to `xhigh`; there is no plan-effort environment variable, but a profile or call can set it. Ultracode effort is fixed to `ultracode`, not plain `xhigh`, because the latter drops the workflow opt-in. Its workflow agents' model/effort live in `contracts/ultracode.md`, not a variable.

Role contracts in `contracts/*.md` supply child instructions; see [Child tools and settings](runs.md#child-tools-and-settings) for how each backend applies them. Their no-commit and file-change rules are guidance, not enforced permissions.

## The Fusion settings file

`<agent dir>/pi-fusion/settings.json`, with agent dir resolved by Pi (`PI_CODING_AGENT_DIR`, normally `~/.pi/agent`). It belongs to Fusion and is separate from Pi's own `settings.json` and from [`profiles.json`](profiles.md#the-profiles-file). It holds user-global startup settings, used by every project and Pi process of this user:

```json
{ "version": 1, "history": { "enabled": true }, "plan": { "contextPct": 60 } }
```

Both sections are optional:

- `history.enabled` is `true` or `false`; the saved preference beats `PI_FUSION_HISTORY`. See [Turning history on and off](runs.md#turning-history-on-and-off).
- `plan.contextPct` is a number from **0 to 100**, fractions included; `0` disables context-based handoffs and continuation warnings. A non-blank `PI_FUSION_PLAN_CONTEXT_PCT` overrides it; with neither, the cap is **35%**. An invalid non-blank variable keeps the 35% default and warns, rather than using the saved value. See [The context cap](runs.md#the-context-cap).

A missing file or field means no value is saved. Fusion reads the file once per instance, at startup; edits take effect after restarting Pi, `/reload`, or replacing the session. Only `/fusion history on|off` writes it, preserving the plan setting; edit `plan.contextPct` by hand.

Validation is local. A non-object, a version other than `1`, an unknown field, a non-boolean `enabled` or an invalid `contextPct` makes the whole file unreadable. At startup that leaves the file untouched, captured variables/defaults decide, and one warning names the resulting history and context-cap behavior. A save over such a file, or over a file from a newer pi-fusion, is refused so you can fix it by hand.

Writes follow the [profiles file](profiles.md#how-the-file-is-written) rules. A missing file creates nothing until a save. A save creates the private directory (`0700`) and file (`0600`) where platform modes apply. It rereads the file, changes only the history preference, and replaces the file through a private temporary sibling and a rename. A failed write leaves the old file. Writes are queued within one process. Separate Pi processes and manual edits have **no lock**: the last rename wins, and nothing watches the file.

## The pi backend's variables

For example:

```bash
export PI_FUSION_PI_IMPLEMENT_MODEL=deepseek/deepseek-chat
export PI_FUSION_PI_IMPLEMENT_EFFORT=high
```

Then a fresh `fusion` call can name `backend: "pi"` without supplying a model. Alternatively, put Pi/model/effort in that role's session settings and leave `backend` unset.

A Pi model/effort comes from:

```text
explicit call field
  -> recorded selection for a continuation
  -> configured role setting (or captured defaults for the other-backend override)
```

A model is required; none is guessed. Split it at the first slash: `openrouter/deepseek/deepseek-chat` has provider `openrouter` and opaque model id `deepseek/deepseek-chat`. Missing models refuse before admission; explicitly blank model/effort parameters refuse rather than falling through to another value.

Pi thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A first call naming no level leaves the child its own default, which is read back and recorded. The model must support the exact requested level: constructor clamping fails the call instead of silently becoming another selection.

A continuation otherwise repeats its recorded fields despite later environment/profile changes. Explicit permitted overrides win for that call. Reviews are fresh `ask` runs on their own configured model/effort, inheriting nothing from the reviewed run.

There is no variable that enables/disables the Pi backend or installs a provider, SDK, or resource. See [Runtime requirements](pi-backend.md#runtime-requirements) for the importable host package, provider-resource limits, and `node` on `PATH`.

## The codex backend's variables

`PI_FUSION_CODEX_PLAN_MODEL`/`_EFFORT`, `PI_FUSION_CODEX_IMPLEMENT_MODEL`/`_EFFORT` and `PI_FUSION_CODEX_ASK_MODEL`/`_EFFORT` are the captured defaults for a fresh Codex call when no profile configures that role on Codex, or when a call names `backend: "codex"` for a role configured elsewhere. A Codex model/effort comes from:

```text
explicit call field
  -> recorded selection for a continuation (model, provider, effort)
  -> configured role setting (or captured defaults for the other-backend override)
  -> otherwise unset: the host's own Codex configuration chooses
```

Nothing is required. A role that names no model is shown as `host default`, and once the child reports its model, stats read `host default -> <model>`; the label is presentation only and never reaches the child as a model id. Models and efforts are single tokens without whitespace. The binding checks only that lexical form, so a level such as `ultra` that Claude and Pi refuse is accepted for Codex; whether the model supports it is checked by the Codex model or server when the run starts, not before admission. Blank or whitespace-containing call fields refuse rather than fall through, and a malformed configured value refuses naming its variable or profile. With no model, thread/start names none; a requested effort is named only on turn/start. A fresh call names no model provider, so the host's own Codex configuration always chooses it; a continuation repeats the provider its thread recorded, even when the call overrides the model. A plan handoff is a fresh thread: it carries the recorded model and effort, not the provider.

`plan` and `implement` bind a `workspace-write` sandbox and `ask` a `read-only` one, all with approval policy `never`. Only `plan` takes `fresh`, and only `ask` takes `mode`. Each receives only its shared role contract. A callable question callback is required; fresh threads register the tool and continuations trust its restoration, with no backend-specific fallback instructions. See [Questions on Codex](questions.md#on-codex).

## Where the pi backend writes

Fusion owns `<agent dir>/pi-fusion`, normally under `~/.pi/agent`; `PI_CODING_AGENT_DIR` relocates the host root. Stable child transcripts/catalog/helpers live in `children`; input/compiler caches live in one `calls/<role>-<random>` directory per invocation. Call storage is removed after verified cleanup, or retained with a warning when cleanup is uncertain. No garbage collector or cleanup command removes retained calls.

Existing user `models.json`, `auth.json`, and helper `bin` are inputs. Fusion copies no credential and creates no user model/auth file. **An existing auth file is not read-only:** Pi may rotate and rewrite it, with an adjacent transient lock. The child inherits provider keys and `PI_OFFLINE` exactly and may use the network. None of this is a sandbox.

The authoritative [storage diagram and credential limitations](pi-backend.md#storage-and-credentials), [helper/network behavior](pi-backend.md#environment-network-and-search-helpers), and [cleanup instructions](runs.md#aborting-a-run) are documented separately. Beyond the host root, no Fusion variable relocates Pi child storage.

## Session usage and budget

The ledger totals this host session's delegation calls, not the host model's own usage. Each call's latest running total **replaces** its earlier total; continuation is another call with its own usage. Finished calls use their outcome totals, even if no final progress event repeated them. Failed/cancelled runs count too; a backend that throws leaves its last reported totals.

`/fusion status` ends with totals even when no budget is configured:

```text
session usage: est. $0.2500 · in 12.3k out 4.5k tokens · workflow agents 0 tokens · 3 calls
```

Dashboard headers and tool-result details carry the same ledger. Enabled history restores earlier usage. Cost is the backend's estimate from runtime/model pricing, not a subscription invoice, and updates lag work in flight. Successful Pi calls publish the turn's statistics delta, not the entire resumed session.

A Codex child reports **no cost**, and Fusion estimates none: a Codex run shows no dollar figure, its tokens still count, and the estimate leaves it out. Every usage line then says so, for example `· cost unknown for 2 codex runs, not in the estimate`. Codex tokens are the parent thread's only; subagent threads are not counted.

`PI_FUSION_BUDGET_WARN_USD=5,20` warns once at each amount this process reaches. Warnings change no run. `PI_FUSION_BUDGET_LIMIT_USD=20` refuses new runs, continuations, and manual/automatic reviews at or above the threshold. With either set, the first Codex run admitted in an extension instance (the same scope as the invalid-budget warning) says once that Codex spend is not in the estimate those act on; Codex runs add nothing to the estimate, and no Codex-specific refusal or estimate exists, so neither variable bounds Codex spend. It cancels nothing and sets no child `maxBudgetUsd` or `maxTurns`; a running child can spend beyond it. Raise/unset the limit and restart Pi to admit work again.

Budget variables and the context-cap variable are read at extension load; the saved plan cap is read once at startup. Invalid budget amounts disable that control and warn once at the first delegation/control/command, for example:

```text
fusion: PI_FUSION_BUDGET_LIMIT_USD=1,000 is not a dollar amount; no limit is set
```

Context-cap values instead retain the default when invalid. See [The context cap](runs.md#the-context-cap) for handoff and explicit-continuation behavior.
