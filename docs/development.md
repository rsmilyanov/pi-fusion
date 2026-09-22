# Development


```bash
npm install
npm run typecheck
npm test
```

The tests run the extension against `test/fake-claude.mjs` instead of the real binary. It speaks the SDK's side of Claude Code's stream-json protocol: it answers the `initialize` control request, takes the prompt from the `user` line that follows, then plays the scenario named by `FAKE_CLAUDE_SCENARIO`. The question scenarios send `mcp_message` and `hook_callback` control requests to the SDK, as Claude Code does, and wait for the reply. `PI_FUSION_CLAUDE_BIN` points the SDK at it; a `.js`, `.mjs` or `.cjs` path runs under node. Set `FAKE_CLAUDE_LOG` to a file to see what the SDK writes to the fake's stdin.

`test/control.test.ts` drives background runs, questions and `claude_control` through a host whose branch grows with every entry the extension appends. `test/changes.test.ts` runs the git snapshots against a scratch repository. `test/budget.test.ts` covers the ledger: what the two budget variables parse to, that a call's latest total replaces its earlier one instead of adding to it, and when a threshold warns and the limit blocks. `test/review.test.ts` covers the review prompt and the rule that decides which runs can be reviewed. `test/history.test.ts` writes and reads session files under `os.tmpdir()`, including the caps, the file modes, a symbolic link where a file or the directory should be, a corrupt file and a file from a newer pi-fusion. `test/cards.test.ts` renders the cards and the widget with a theme that names its colors, and checks that no line is wider than the width it was given and that no escape sequence a child wrote reaches the terminal. `test/dashboard.test.ts` covers the run store, the dashboard server over real HTTP requests on a random port, and static safety checks on the page assets: that `index.html` carries no inline script, no inline style and no event handler attributes, that `app.js` parses with node's `vm.Script` and uses none of `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function`, and that `app.css` has no `url()` or `@import`. `test/browser.test.ts` drives the page in headless Chrome over the DevTools protocol; it is skipped when Chrome is not at `/Applications/Google Chrome.app` or at `PI_FUSION_CHROME`.
