# The ultracode role


Role `ultracode` starts its child with the SDK equivalent of:

```bash
claude --model fable --effort ultracode --output-format stream-json --input-format stream-json --verbose \
  --include-partial-messages --permission-mode bypassPermissions --allow-dangerously-skip-permissions \
  --permission-prompts none
```

with `contracts/ultracode.md` appended to the system prompt through the SDK's handshake, and the prompt sent as the first user message. `--include-partial-messages` streams the API events, which is what feeds the activity in the status line; the `assistant` and `result` records still carry the tool calls and the report.

`--effort ultracode` is what turns the standing opt-in on: Claude Code then tells the model to use the Workflow tool on every substantive task and sets effort to xhigh. Putting the word "ultracode" in a headless prompt does not do this; the keyword trigger works in interactive sessions only. The SDK's typed `effort` option stops at `max`, so the extension passes this one as an extra CLI argument.

The Workflow tool is permission-gated. `dontAsk` denies it outright; `bypassPermissions`, `auto`, and `acceptEdits` plus `--allowedTools Workflow` admit it. The default is `bypassPermissions` because the child runs unattended and `--permission-prompts none` turns any prompt into a denial. Denied tools, if any, are listed in the stats line.

The implementer's contract asks for a workflow: explore, implement, verify, review, fix and verify again as a sequence of stages, one agent at a time, with agents that did not write the change trying to refute that each task is done. It also tells Fable to pass `model: 'claude-opus-5'` and `effort: 'xhigh'` to every workflow `agent()` call, so Fable plans, briefs and judges while Opus 5 does the work. The Workflow tool accepts both that id and the `opus` alias; both resolve to `claude-opus-5[1m]` today. These are instructions to the model, not enforcement. To change the agent model or effort, edit `contracts/ultracode.md`. Expect a run to take minutes and to use noticeably more subscription capacity than `implement`.

The contract tells Fable to await every `agent()` call, never to use `Promise.all`, and not to start a second workflow or a direct Agent call while one is running. Fable does not run build, compile or test commands itself while an agent is running, and it briefs every agent to run those commands in the foreground, one after another, and to leave no background job behind. Concurrent builds in a shared working tree break some projects.

This is contract text, an instruction to the model. It is not a scheduler, a lock or a runtime guarantee, and the pinned Agent SDK has no concurrency setting. `PI_FUSION_ULTRACODE_WORKFLOW_SIZE` sets Claude Code's `workflowSizeGuideline`, an advisory agent count, not a concurrency limit. Running one agent at a time takes longer. There is no time limit on a child: it runs until it finishes, you abort a foreground call, or `claude_control cancel` stops it, and a stop leaves partial changes in the working tree.

A workflow runs in the background of the child's session and outlives the turn that launched it: Fable's turn ends once the workflow is running, and the completion notification starts a new turn. Headless Claude Code gives background tasks 10 minutes after the turn ends, then kills them and exits; `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` controls that. The extension sets it to `0` in the child's environment, so only an abort or a cancel stops a workflow. Should a child still exit with a task running, the tool fails with `<role> exited with workflow <name> still running` and Claude Code's stderr, instead of returning the turn's placeholder text as the result.
