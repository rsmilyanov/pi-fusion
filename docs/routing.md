# Routing


The host model (GPT-6 Astra via the `openai-codex` provider) is the orchestrator. The tool guidelines injected into its system prompt ask it for two decisions. First, is the design unresolved: more than one viable approach, unclear requirements, a change to a shared contract or interface, or risk the host cannot bound by reading the code. If it is, the host calls `claude` with role `plan` first; if the host can already say what to change, where, the acceptance criteria and how to verify it, it skips planning. Second, which implementer role gets the work, judged by complexity and risk rather than by how many files the task touches.

That leaves three routes: straight to `implement` for a clear, bounded task; `plan` first and then `implement` task by task from the agreed plan; or `ultracode`, with or without `plan`, for complex, uncertain or high-risk work. The agreed plan's Route section recommends one of them, and the host decides.

Your explicit choice wins over the guidelines. Ask for Opus and the host uses role `implement`, ask for Fable or ultracode and it uses role `ultracode`, and ask for or skip planning as you like. A model or effort you name goes in the `model` or `effort` parameter; otherwise the host leaves both unset.

When a task turns out to need a broader scope, or a design decision nobody has made, the `implement` child stops and reports that under Escalation instead of widening the task itself. The host then keeps what it changed and verified, and takes the design question to `plan` or the broader work to `ultracode`.

The `ultracode` child has its own agents verify and review the work before it reports, and that report's Review section is the review step. Those agents are spawned and briefed by the implementer, so this is a self-review, not an independent one. The `implement` child reports its own verification only. For an independent review, the host calls role `ask` with `mode: "review"`, naming the change and what it must do; the implementer did not brief that child. The host also uses role `ask` for a question about the code or its dependencies that would otherwise take it many file reads.

The routes live in the tool guidelines and in the role contracts under `contracts/`. They are instructions to the models, not enforcement.
