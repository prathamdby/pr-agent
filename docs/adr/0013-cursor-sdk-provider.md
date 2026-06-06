# ADR 0013: Cursor SDK provider

## Status

Accepted

## Context

pr-agent uses `@earendil-works/pi-ai` (`complete()`, tool loop) for review and ask runs. Users want Cursor models via `CURSOR_API_KEY` without forking pi-ai upstream.

[pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) implements a Cursor provider for **pi-coding-agent** (extension host + pi tool registry). pr-agent uses raw pi-ai in worker fibers with per-call GitHub/Context7/submitReview tools — not the coding-agent extension model.

## Decision

1. **Inline adapter** under `src/agent/cursor/`, registered at worker boot via pi-ai `registerApiProvider({ api: "cursor-sdk", ... })`.
2. **`AGENT_PROVIDER=cursor`** + required **`CURSOR_API_KEY`** in `loadConfig()`.
3. **Cursor owns the tool loop** for each provider send.
4. **HTTP loopback MCP bridge** per agent session (`StreamableHTTPServerTransport` on `127.0.0.1`, bearer token) exposes pr-agent tools to Cursor's local agent. stdio MCP rejected (stdout conflict with evlog; in-process).
5. **`local.settingSources: []`** — worker `cwd` is pr-agent source, not target repo; GitHub investigation tools are the repo signal.
6. **Installation token refresh** in bridge `refreshBeforeTool` for long Cursor runs.
7. **Session-scoped reuse.** A Cursor Agent and MCP bridge may be reused across multiple sends inside one agent session (for example investigation, validation repair, and publish recovery within a single review run). They are disposed at session end and are never reused across separate pg-boss jobs, pull requests, or agent work items.

## Consequences

- Cursor runs can use the same review/ask harness phases as the Pi provider while avoiding bridge startup per send.
- Usage metrics are approximate (char/4), not Cursor SDK cumulative counters.
- Cursor cloud mode out of scope (would clone repo; conflicts with GitHub-API-only design).
- No agent reuse across worker jobs (single-shot job isolation remains).

## Alternatives considered

- **Fork pi-ai** — heavier maintenance.
- **Fork pi-cursor-sdk** — targets coding-agent; wrong integration surface.
- **stdio MCP** — unusable in worker process (peer review).
