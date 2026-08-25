# ADR 0031: Pi-native agent runtime

## Status

Accepted. Supersedes the former Cursor dual-runtime / `AGENT_PROVIDER` path.
Read-only local investigation remains in [ADR 0015](0015-agent-runner-local-pr-workspace.md).

## Context

pr-agent supported Pi and Cursor through a shared `AgentRunnerProvider` interface.
The Cursor path was unused in practice and forced every session capability to fit
both runtimes or grow a second implementation. Cursor also imposed a loopback MCP
bridge, worker boot discovery, provider-specific analytics and errors, a native
SQLite build, configuration branches, and a separate test suite.

Pi already exposes richer session lifecycle events, compaction, thinking levels,
steering, model assignment, active tool changes, and session trees. A generic
runner contract designed around two SDKs blocks product use of those capabilities.

Reviewed repositories are untrusted. Pi is not a sandbox. Orchestrated reviews can
publish incremental thread batches during long model sessions. Session resume,
compaction, fallback models, and event streaming therefore need server-owned
policy, durable checkpoints, and strict redaction.

## Decision

1. Support one agent runtime: Pi coding-agent. Remove the former dual-runtime
   SDK integration and its exclusive dependencies. Model selection is via
   `PI_PROVIDER` / `PI_MODEL` (and optional orchestrator/fallback overrides).
2. Replace the generic runner abstraction with one Pi-specific session seam owned
   by pr-agent (`src/agent/runtime/`). Feature harnesses must not import or
   construct raw Pi sessions. Raw Pi events stay inside the runtime module.
3. Cross the seam with a discriminated, allowlisted Agent lifecycle event union.
   Lifecycle events and Agent audit records contain no prompts, model text,
   reasoning, repository content, tool payloads, arbitrary exception messages,
   credentials, or installation tokens.
4. Load only server-owned agent resources. Keep Pi built-in shell, write, edit,
   and filesystem tools disabled. Agent instruction files and repo policy rules
   remain untrusted prompt context.
5. Assign three logical models: orchestrator primary, general primary, and shared
   fallback. A healthy session keeps one model. Fallback starts a fresh session
   from a committed Agent phase checkpoint after availability-class retry
   exhaustion only.
6. Persist durable Agent phase checkpoints and idempotent operation intents before
   GitHub mutations. `publish_records` remain authoritative. Short-lived encrypted
   resume snapshots may resume computation but must not replay, advance, or roll
   back published state.

## Consequences

- One failure model and one test seam for agent sessions.
- Breaking change for deployments that still selected the removed dual runtime.
- Worker images no longer need the removed dual-runtime SDK, MCP bridge, or
  SQLite native builds once dependency analysis confirms they had no other
  consumers.
- Future alternate runners require demonstrated demand and a new ADR; do not
  reintroduce a generic capability-negotiation framework preemptively.

## Alternatives considered

- **Keep dual runners with a richer shared interface** — every Pi capability
  either stalls or forks a second implementation; rejected.
- **Silently map removed dual-runtime env to Pi** — unsafe credential/model
  reinterpretation; rejected.
- **Persist full conversations as audit data** — creates a second content store
  and expands retention risk; rejected in favor of metadata-only audit records
  and short-lived encrypted snapshots.
