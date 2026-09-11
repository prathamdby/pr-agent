# ADR 0033 — Code Mode execution layer

## Status

Accepted.

## Context

Review specialists, ask, and verification investigated the local PR workspace through one native tool call per read, grep, diff, blame, or symbol lookup. Multi-step correlation took many model turns and dumped raw tool output into context.

The workspace capabilities themselves are sound ([ADR 0011](0011-agent-runner-local-pr-workspace.md), [ADR 0012](0012-full-context-local-pr-workspace.md)). Durable leases and epoch fencing stay on PostgreSQL ([ADR 0006](0006-durable-agent-work.md), [ADR 0030](0030-pr-actor-lease.md)). Sessions stay Pi-native with server-owned tools ([ADR 0023](0023-pi-native-agent-runtime.md)).

An in-process Acorn walker metered AST fuel. That interpreter could not preempt a tight bytecode loop or a catastrophic regex without heuristics, and it froze the Node event loop for the whole cell. Phase 0 measured QuickJS interrupt vs hard process kill before choosing an executor.

## Decision

1. **One model-visible investigation tool.** Review, ask, and verification expose `execute({ code })`. Workspace capabilities remain the typed implementation and run as `tools.*` inside the script. Review and ask install all six. Verification installs `readWorkspaceFile`, `searchWorkspace`, and `getWorkspaceDiff` only. Context7 and code-index tools stay native siblings on review and ask. Terminal handoffs (`submit_specialist_brief`, `submit_findings_report`, publish, `submitVerification`) stay native. The execute description and role prompts generate the guest catalogue from the installed capability set. Do not advertise a `tools.*` name the guest cannot call.

2. **QuickJS WASM cell.** Each `execute` gets a fresh runtime and context. No `eval`, `new Function`, V8 isolate, OpenCode daemon, SQLite, PTY, or native add-ons. The guest sees math/data primitives and host-bridged `tools.*` only. There is no retained guest heap across cells and no MCP.

3. **Interrupt and CPU bounds, not AST fuel.** The interrupt handler stops the cell after `CODE_MODE_CPU_BUDGET_MS` (80ms) of guest CPU. Host capability waits pause the meter. A pending async IIFE after interrupt is treated as budget-exceeded without waiting on `resolvePromise`. Other bounds: 25 workspace calls, 4 in-flight host calls, 15s wall clock, heap/stack ceilings, source/state/output byte caps, clamped `String.repeat` / `Array.from`, and a marshalling serializer (depth 8, array 100, string 32 KiB). Host halt (CPU budget, timeout, session abort) is not catchable in user JavaScript.

4. **Executor kind follows Phase 0.** `resolveCodeModeExecutorKind()` selects `worker_threads` for compiled production so a stuck WASM module cannot pin the consumer event loop. Vitest and TypeScript source execution stay `in_process` so the interrupt stays observable and the worker entry does not have to sit beside `.ts` sources. `worker.terminate()` was 2ms in Phase 0; child `SIGKILL` was 3ms. The regex input heuristic is removable because the interrupt stopped a catastrophic regex in 51ms. Worker-thread `hostCall` failures that are `CodeModeHostHalt` travel as a structured `halt` field on `hostResult`. The worker restores the class before the guest promise settles, so `try/catch` still cannot swallow `LIMIT_EXCEEDED`, `TIMEOUT`, `CANCELLED`, or budget stops. Ordinary capability errors remain a string `error` and stay catchable.

5. **Structured `CodeModeResult`.** Success returns compact output plus inner `toolCalls`. Failure uses `SYNTAX_ERROR`, `EXECUTION_BUDGET_EXCEEDED`, `TIMEOUT`, `CANCELLED`, `LIMIT_EXCEEDED`, `TOOL_FAILURE`, or `EXECUTION_ERROR`. Host-signal abort is `CANCELLED`. `TIMEOUT` stays the 15s cell cap and the executor-pool wait. Inner path fencing surfaces as `ACCESS_DENIED`. Marshal records only delivered file/diff ranges on the evidence ledger.

6. **Telemetry.** Each inner `tools.*` call emits an `AgentLifecycleEvent` `tool` span named `codemode.<capability>`. Cell completion emits an `execution` lifecycle event.

## Phase 0 measurements

Recorded against `@jitl/quickjs-wasmfile-release-sync` 0.32.0 (`engineRevision` 2025-09-13+f1139494):

| Probe                        | Latency | Outcome                       |
| ---------------------------- | ------- | ----------------------------- |
| Interrupt bytecode loop      | 51ms    | `InternalError` `interrupted` |
| Interrupt catastrophic regex | 51ms    | `InternalError` `interrupted` |
| `worker.terminate()`         | 2ms     | process continues             |
| Child `SIGKILL`              | 3ms     | process exits                 |
| Child `SIGTERM`              | 2ms     | process exits                 |

`executorKind`: `worker_threads` in production. `regexHeuristicRemovable`: true.

## Consequences

- Model investigation prompts teach the current harness: one QuickJS cell per `execute`, explicit `state`, `{ coverage, truncation }` host results, `Promise.all` fan-out, and native submit/publish outside the guest. The execute description is generated from installed capabilities.
- Description and triage keep native workspace tools. They can adopt Code Mode later without changing capabilities.
- Worker `/health` and `/ready` stay on the Node event loop because production cells run off-thread and in-process cells are interrupt-bounded.
- Mixing a QuickJS worker against a shared production queue that still runs the Acorn interpreter is forbidden while rolling this out.

## Alternatives considered

- **Keep sequential native tools.** Rejected: latency and context bloat are the problem.
- **Keep the Acorn walker.** Rejected: AST fuel does not preempt native regex or a tight loop as reliably as the QuickJS interrupt, and the cell blocks the consumer.
- **Always `child_process` + SIGKILL.** Rejected: Phase 0 kill was fast, but worker threads reuse the WASM module and keep capabilities on the host. Hard kill remains available if a future engine ignores the interrupt.
- **Embed OpenCode core / `opencode serve`.** Rejected: Bun FFI, node-pty, SQLite, and a second control plane.
- **Import `@opencode/codemode` as the interpreter.** Rejected: the package is not on npm, its walker targets Effect 4 RC (pr-agent is Effect 3.22), and it meters wall-clock / tool-call / output bytes only. MIT license notes live in `src/agent/codemode/vendor/`.
- **V8 isolate or `eval`.** Rejected: harder to meter synchronous loops and native allocations on Node 22 without native add-ons.
