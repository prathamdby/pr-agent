# ADR 0033 — Code Mode execution layer

## Status

Accepted.

## Context

Review specialists, ask, and verification investigated the local PR workspace through one native tool call per read, grep, diff, blame, or symbol lookup. Multi-step correlation took many model turns and dumped raw tool output into context.

The workspace capabilities themselves are sound ([ADR 0011](0011-agent-runner-local-pr-workspace.md), [ADR 0012](0012-full-context-local-pr-workspace.md)). Durable leases and epoch fencing stay on PostgreSQL ([ADR 0006](0006-durable-agent-work.md), [ADR 0030](0030-pr-actor-lease.md)). Sessions stay Pi-native with server-owned tools ([ADR 0023](0023-pi-native-agent-runtime.md)).

## Decision

1. **One model-visible investigation tool.** Review, ask, and verification expose `execute({ code })`. The six workspace capabilities remain the typed implementation and run as `tools.*` inside the script. Context7 and code-index tools stay native siblings. Terminal handoffs (`submit_specialist_brief`, `submit_findings_report`, publish, `submitVerification`) stay native.

2. **In-process Acorn interpreter.** No `eval`, `new Function`, V8 isolate, OpenCode daemon, SQLite, PTY, or native add-ons. The environment has math/data primitives and `tools.*` only.

3. **Layered bounds.** AST fuel (50,000), 25 workspace calls, 15s abort, clamped `String.repeat` / `Array(n)` / ReDoS-prone regex, blocked `__proto__` / `constructor`, and a defensive serializer (depth 8, array 100, string 32 KiB).

4. **Structured `CodeModeResult`.** Success returns compact output plus inner `toolCalls`. Failure uses `SYNTAX_ERROR`, `EXECUTION_BUDGET_EXCEEDED`, `TIMEOUT`, `LIMIT_EXCEEDED`, `TOOL_FAILURE`, or `EXECUTION_ERROR`. Inner path fencing surfaces as `ACCESS_DENIED`. Host halt (fuel, timeout, session abort) is not catchable in user JavaScript.

5. **Telemetry.** Each inner `tools.*` call emits an `AgentLifecycleEvent` `tool` span named `codemode.<capability>`.

## Consequences

- Model investigation prompts instruct `execute` + `tools.*` + `Promise.all`.
- Description and triage keep native workspace tools. They can adopt Code Mode later without changing capabilities.
- Worker `/health` and `/ready` stay on the Node event loop because fuel preempts synchronous loops.

## Alternatives considered

- **Keep sequential native tools.** Rejected: latency and context bloat are the problem.
- **Embed OpenCode core / `opencode serve`.** Rejected: Bun FFI, node-pty, SQLite, and a second control plane.
- **Import `@opencode/codemode` as the interpreter.** Rejected: the package is not on npm, its walker targets Effect 4 RC (pr-agent is Effect 3.22), and it meters wall-clock / tool-call / output bytes only. Issue #580 requires AST-step fuel and an uncatchable host halt. MIT license and interpreter-support notes live in `src/agent/codemode/vendor/`.
- **V8 isolate or `eval`.** Rejected: harder to meter synchronous loops and native allocations on Node 22 without native add-ons.
