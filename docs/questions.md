# Questions a child asks

A child uses `ask_orchestrator(question)` for a small decision missing from its brief. The call stays open, retaining context, until an answer arrives. Codex requires a question callback and trusts continuations to restore the tool registered at thread creation ([below](#on-codex)). Wider scope or an unresolved design decision belongs in an implementer's **Escalation** report, which ends the run.

```text
child asks -> run waiting -> host or user supplies one answer
                               |
                     child sees tool result and continues

cancellation / fatal Pi dialog failure -> child stopped, run ends
```

## Waiting and answering

A foreground delegation returns early with the handle/question and becomes background work. A background run announces its question unless a host control `wait` is collecting it; that wait returns the question instead. Waiting still occupies the file-changing slot when the role has one, so another coding run cannot start beside it.

The host uses a control `message` action, asking you first when the decision is yours. Generated hints use `fusion_control` for a `fusion` delegation or `claude_control` for `claude`; either control can answer every run. Further queued questions are answered in order, and an answer reply can carry the next question.

You can answer directly:

```text
/fusion answer run-3 Use the existing public name
/fusion answer run-3
/fusion answer
```

No text opens an editor titled with the question. An empty user-editor answer sends nothing and leaves the run waiting. No handle chooses the sole waiting run; when several wait, supply one.

A user answer notifies the host as a follow-up **without starting a turn**. The host reads it with its next response. A newly exposed queued question is still announced separately so that the answer notification cannot hide it.

## Exactly one answer wins

Each question has an id. Whoever answers first wins; the second attempt sends nothing and names who answered and what they supplied.

If your answer lands while the host is composing a control `message`, that message returns `The user already answered run-3's question with: ...` rather than accidentally steering the child. The host may explicitly resend if still appropriate; it then becomes a steer, or an answer if another question is now open. There is no automatic resend.

Control `status` and `wait` report `answered by the user: <text>` until the child asks its next question. Ordinary editor instructions go to the host, not directly to the waiting child. Use `/fusion answer` for an answer and `/fusion steer` for a running child with no open question.

## On Claude Code

The question tool is an in-process MCP server served by the Agent SDK. Fixed-tool roles keep strict MCP configuration with only this server; ultracode gets it beside the user's servers. Its name is allowed even outside `bypassPermissions`.

Ultracode's native `AskUserQuestion` also follows this flow through a `PreToolUse` hook. With unattended `permissionPrompts: "none"`, the SDK does not call `canUseTool`, so that is not the bridge. The hook joins questions/options into one numbered request, then supplies the original input with an answer map. One answer line per question maps separately; otherwise all questions receive the whole answer.

The MCP tool timeout is `2147483647` ms and hook timeout `2147483` seconds, about 24.8 days; these avoid ordinary short timeouts, not a literally infinite wall-clock limit. The hook otherwise defaults to ten minutes. These limits were read from Claude Code 2.1.273, not measured against its real binary; deterministic tests drive the control requests through the fake binary.

## On the pi backend

Pi's tool opens one blocking `ctx.ui.input` dialog with its call signal and no timeout, routed to the same host question flow. Text, including an empty string returned by an internal callback, is an answer; a dialog returning no answer fails the tool call.

Native UI requests contain no extension-origin identity. While questions are enabled, every eligible blocking input dialog inside the child is routed this way; Fusion cannot distinguish its own tool from other trusted code opening the same dialog shape. Unsupported methods, active timeouts, invalid/duplicate requests, and closed routing are refused rather than guessed at. All shipped delegated Pi runs have questions enabled; internal callers without a callback do not.

A Pi dialog outcome other than an admitted answer is fatal: the run stops its child and reports fixed wording with the dialog end/admission, not the question, answer, or foreign error. A cancelled run remains cancellation—cancellation outranks a simultaneous fatal question—and the recorded dialog outcome remains evidence beside it.

Manual Linux cases have measured an answered native question with a steer admitted while held, and a question held into cancellation, using a scripted loopback model. They do not qualify real providers or every version/platform. See [Pi backend evidence](pi-backend.md#evidence-and-limits); the default suite's routing doubles prove host arbitration, not native dialogs.

## On Codex

Shapes come from Codex 0.160.0 source. Questions on a native app-server were measured for `ask` only ([G3](codex-backend.md#g3-cases)); `plan`/`implement` questions, callback admission, shared-contract-only continuations and host answer races remain fake-tested.

Sources: [`codex.ts`](../extensions/backends/codex.ts) and [`codex-transport.ts`](../extensions/backends/codex-transport.ts).

```text
backend run -> required question callback (no separate setting)
  +-- absent / not callable -> refuse before contract read, lookup or spawn
  -> initialize: capabilities.experimentalApi = true
     WHOLE connection opts in, not just the question tool
  -> fresh thread: register ask_orchestrator
  -> resume/fork: register nothing; trust Codex to restore that registration
```

Normal delegations always supply the callback. Internal callback-less calls are unsupported; an already cancelled call still finishes as cancellation without starting anything. Every admitted run receives only its shared role contract, with no Codex-specific question fallback instructions.

| Run | Developer instructions | Tool availability |
| --- | --- | --- |
| Fresh | Shared role contract | Register `ask_orchestrator` |
| Resume/fork | Shared role contract | Inherit the original registration |

The fresh thread's only dynamic tool has the shared question description and one required string `question`. Stable resume/fork requests cannot add it; G3 observed restoration on one resume and one fork. Fusion relies on its own fresh-thread registration and Codex's restoration rather than probing the tool inventory or persisting a capability marker. Tool-less legacy threads are unsupported, not detected or upgraded: start a new run without `continue`, carrying the report (`plan` needs `fresh: true`). Continuation identity, checkpoint and usage checks are unchanged.

```text
item/tool/call: ask_orchestrator, no namespace, non-empty question
  +-- before turn/start answer -> hold until admitted turn is named
  +-- own live turn            -> host question queue (off read loop)
  |                               -> one answer as one text tool result
  +-- foreign/ended turn       -> success: false; run may continue
  +-- namespace/empty question -> success: false; run may continue

other tool / unsupported server request -> run fails
```

Several questions use the ordinary host queue. Notifications and turn completion continue to be read while answers wait; each call receives one result. A subagent's question is foreign and refused, not forwarded.

Cancellation aborts the question's signal. Owned shutdown sends one failed tool reply ahead of the turn interrupt; a turn ending with a question open also closes it with a failed reply. This is the code order, not a natively measured ordering/acknowledgement guarantee ([Q16](codex-backend.md#g3-cases)). No lost answer is resent, no question retried, and the backend keeps/logs no answer text.

A control `message` while waiting is the answer. With no question open it is a [Codex steer](codex-backend.md#steers): one attempt to the admitted turn, with delivery not proof of consumption.
