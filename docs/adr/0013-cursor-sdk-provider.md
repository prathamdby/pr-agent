# ADR 0013: Cursor SDK provider

## Status

Accepted

## Context

pr-agent uses `@earendil-works/pi-ai` (`complete()`, tool loop) for review and ask runs. Users want Cursor models via `CURSOR_API_KEY` without forking pi-ai upstream.

[pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) implements a Cursor provider for **pi-coding-agent** (extension host + pi tool registry). pr-agent uses raw pi-ai in worker fibers with per-call GitHub/Context7/submitReview tools — not the coding-agent extension model.

## Decision

1. **Inline adapter** under `src/agent/cursor/`, registered at worker boot via pi-ai `registerApiProvider({ api: "cursor-sdk", ... })`.
2. **`PI_PROVIDER=cursor`** + required **`CURSOR_API_KEY`** in `loadConfig()`.
3. **Cursor owns the tool loop** for cursor runs: one `complete()` call; review/ask skip multi-round pi-ai scaffolding.
4. **HTTP loopback MCP bridge** per run (`StreamableHTTPServerTransport` on `127.0.0.1`, bearer token) exposes pr-agent tools to Cursor's local agent. stdio MCP rejected (stdout conflict with evlog; in-process).
5. **`local.settingSources: []`** — worker `cwd` is pr-agent source, not target repo; GitHub investigation tools are the repo signal.
6. **Installation token refresh** in bridge `refreshBeforeTool` for long Cursor runs.

## Consequences

- No rate-limit circuit, validation repair, or publish-recovery loops on cursor runs (Cursor internal loop + MCP `submitReview`).
- Usage metrics are approximate (char/4), not Cursor SDK cumulative counters.
- Cursor cloud mode out of scope (would clone repo; conflicts with GitHub-API-only design).
- No session/agent reuse across runs (single-shot worker jobs).

## Alternatives considered

- **Fork pi-ai** — heavier maintenance.
- **Fork pi-cursor-sdk** — targets coding-agent; wrong integration surface.
- **stdio MCP** — unusable in worker process (peer review).
