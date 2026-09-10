# ADR 0023: Pi-native agent runtime

## Status

Accepted. Supersedes the former Cursor dual-runtime / `AGENT_PROVIDER` path.
The session implementation is Core (`@earendil-works/pi-agent-core`) plus
pi-ai, not `@earendil-works/pi-coding-agent`.
Read-only local investigation remains in [ADR 0011](0011-agent-runner-local-pr-workspace.md).
Decision 5's in-run fallback-restart clause is superseded by
[ADR 0034](0034-escalated-retries.md): the fallback model is reached through
retry escalation, not an in-run session restart.

## Context

pr-agent supported Pi and Cursor through a shared `AgentRunnerProvider` interface.
The Cursor path was unused in practice and forced every session capability to fit
both runtimes or grow a second implementation. Cursor also imposed a loopback MCP
bridge, worker boot discovery, provider-specific analytics and errors, a native
SQLite build, configuration branches, and a separate test suite.

The first Pi-native cut used the coding-agent SDK (`Agent` / `AgentHarness`,
`ModelRuntime`, `SettingsManager`). That SDK owns a product loop, session store,
and optional MCP that this service does not need. Core already exports
`runAgentLoop` / `runAgentLoopContinue`. pi-ai already owns models, streaming,
and catalog overlay. Owning a second loop on top of Core was rejected.

Reviewed repositories are untrusted. Pi is not a sandbox. Orchestrated reviews can
publish incremental thread batches during long model sessions. Session resume,
compaction, fallback models, and event streaming therefore need server-owned
policy, durable checkpoints, and strict redaction.

## Decision

1. Support one agent runtime: Core `runAgentLoop` / `runAgentLoopContinue` with
   a pi-ai `streamFn`. Do not reimplement the agent loop. Do not construct coding-agent
   `Agent`, `AgentHarness`, or Core session store. Model selection is via
   `PI_PROVIDER` / `PI_MODEL` (and optional orchestrator/fallback overrides), resolved
   against pi-ai built-ins plus an optional `models.json` overlay through
   `createProvider`. Pin `pi-agent-core` to the same version as `pi-ai`.
2. Replace the generic runner abstraction with one Pi-specific session seam owned
   by pr-agent (`src/agent/runtime/`). Feature harnesses must not import or
   construct raw Pi sessions, call `runAgentLoop`, or import `pi-ai/compat`.
   Raw Pi events stay inside the runtime module.
3. Cross the seam with a discriminated, allowlisted Agent lifecycle event union.
   Lifecycle events and Agent audit records contain no prompts, model text,
   reasoning, repository content, tool payloads, arbitrary exception messages,
   credentials, or installation tokens.
4. Load only server-owned agent resources. Keep Pi built-in shell, write, edit,
   and filesystem tools disabled. Do not add MCP, cross-attempt guest state, or a
   retained guest heap. Agent instruction files and repo policy rules remain
   untrusted prompt context.
5. Assign three logical models: orchestrator primary, general primary, and shared
   fallback. A healthy session keeps one model. Fallback starts a fresh session
   from a committed Agent phase checkpoint after availability-class retry
   exhaustion only.
6. Persist durable Agent phase checkpoints and idempotent operation intents before
   GitHub mutations. `publish_records` remain authoritative. Short-lived encrypted
   resume snapshots may resume computation but must not replay, advance, or roll
   back published state. Unread resume-snapshot fields stay in the schema.

## Consequences

- One failure model and one test seam for agent sessions.
- Worker images do not need coding-agent, an MCP bridge, or a native SQLite build
  for the agent runtime.
- Session state is in-memory for the send. Workers must not write default `~/.pi`
  state.
- Future alternate runners require demonstrated demand and a new ADR; do not
  reintroduce a generic capability-negotiation framework preemptively.

## Superseded by ADR 0034

- Decision 5's in-run fallback restart is deleted. The three logical model
  assignments and the shared fallback remain, but the fallback model is reached
  through retry escalation on a later durable attempt, not by restarting a
  session from a phase checkpoint inside a run.

## Alternatives considered

- **Keep dual runners with a richer shared interface** — every Pi capability
  either stalls or forks a second implementation; rejected.
- **Keep coding-agent `Agent` / `AgentHarness`** — pulls a product loop, session
  store, and MCP this service does not own; rejected.
- **Reimplement the agent loop** — duplicates Core and forks retry/compaction
  behavior; rejected (decision B).
- **Silently map removed dual-runtime env to Pi** — unsafe credential/model
  reinterpretation; rejected.
- **Persist full conversations as audit data** — creates a second content store
  and expands retention risk; rejected in favor of metadata-only audit records
  and short-lived encrypted snapshots.
