# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # also fetches the Claude Code binary bundled with the Agent SDK (~200 MB)
npm run typecheck      # tsc -p . (noEmit); the only static check, there is no linter or formatter
npm test               # node --test "test/*.test.ts"
node --test test/control.test.ts                      # one file
node --test --test-name-pattern="continue" test/control.test.ts   # one test
```

`test/browser.test.ts` drives the dashboard in headless Chrome. It looks at `PI_FUSION_CHROME`, then the usual install paths for the platform, then any Chromium name on `PATH`, and skips itself when it finds none.

## Architecture

A single Pi extension. `extensions/fusion.ts` default-exports `fusion(pi: ExtensionAPI)`, which registers the `claude` and `claude_control` tools, the `/fusion` command, a renderer for `pi-fusion-run` messages, and the `session_shutdown` and `session_before_tree` handlers. Everything else is a module it imports.

Each `claude` call starts a **child**: a headless Claude Code session in the host's working directory, run through `@anthropic-ai/claude-agent-sdk`. The role (`plan`, `implement`, `ultracode`, `ask`) fixes the child's model, effort, tool list, permission mode and contract; `ROLES` in `fusion.ts` holds that table, and each role's behavior is prose in `contracts/*.md`, appended to the child's system prompt. Change how a role behaves by editing its contract, not the code. The extension throws at load if a contract file is missing.

Run state lives in two places, and the difference matters:

- **In memory**, for this Pi process: `LiveRun` records in `fusion.ts` and the dashboard's `RunStore`. They die with the process unless `PI_FUSION_HISTORY=1` mirrors them to disk through `history.ts`.
- **In the host session transcript**, as `pi-fusion` custom entries appended with `pi.appendEntry`. Each carries the handle, role, Claude Code session id and a checkpoint (the uuid of the child's last assistant message). `runRecords(branch)` reads the last entry per handle on the host's current branch, which is why resuming, `/tree` and forking a host session carry the runs with them. A forked host resumes the recorded session with `--fork-session` on first use.

Module map:

| File | Holds |
| --- | --- |
| `extensions/fusion.ts` | roles, child spawning and process-tree kill, the SDK stream loop, the two tools, `/fusion`, run lifecycle |
| `extensions/budget.ts` | the session cost ledger; each call reports a running total that replaces the one before it, never a delta |
| `extensions/cards.ts` | TUI cards and the run widget, built on `@earendil-works/pi-tui` |
| `extensions/changes.ts` | git snapshots before and after a run, to list the files it changed |
| `extensions/dashboard.ts` | the run store and the local HTTP server; the page is `extensions/dashboard/{index.html,app.js,app.css}` |
| `extensions/handoff.ts` | the context cap that hands a full `plan` run off to a fresh one |
| `extensions/history.ts` | the opt-in on-disk record of a Pi session's runs |
| `extensions/review.ts` | which runs can be reviewed, and the prompt an independent review gets |

Invariants worth knowing before changing run handling: at most one run that can change files is active at a time (`ask` runs may run alongside); a question blocks its child until exactly one answer arrives, from the host or the user; `/tree` is refused while any run is unfinished, because a late report or entry would land on the wrong branch.

The dashboard page is deliberately plain: no framework, no inline script or style, no `innerHTML`, `eval` or `new Function`, no `url()` or `@import` in the CSS. `test/dashboard.test.ts` asserts all of that statically, so keep DOM building node by node.

## Tests

The suite never runs the real Claude Code binary. `test/fake-claude.mjs` speaks the SDK's side of the stream-json protocol: it answers the `initialize` control request, reads the prompt from the `user` line, then plays the scenario named by `FAKE_CLAUDE_SCENARIO` (`ok`, `read`, `question`, `two-questions`, `steer`, `error`, `denied`, `wind-down`, `big-context` and others in that file). Tests point the SDK at it with `PI_FUSION_CLAUDE_BIN`. Set `FAKE_CLAUDE_LOG` to a path to see what the SDK writes to the fake's stdin. Add a scenario there rather than mocking the SDK.

## Conventions

- TypeScript with `allowImportingTsExtensions`: relative imports carry the `.ts` extension (`./review.ts`).
- Tabs for indentation, semicolons, long lines. Comments are `/** ... */` above a declaration and say why it is the way it is, not what the code does.
- `CONTEXT.md` fixes the vocabulary: host, child, role, run, handle, question, waiting, answer, handoff, escalation, steer, review run, history. Each term lists the words to avoid. Use these words in code, prose and tool messages.
- User-facing behavior is documented in `README.md` (overview) and `docs/*.md` (one page per topic). A change that alters what a tool, a variable or the dashboard does belongs in the matching page in the same commit.

## Commit Messages
- Keep messages short and concise. Prefer a single-line subject up to ~150 characters describing the change in the imperative ("add X", "fix Y"). Add a brief body only when the *why* isn't obvious from the diff.
- Do **not** add `Co-Authored-By` or any AI/Claude contribution trailers to commit messages.