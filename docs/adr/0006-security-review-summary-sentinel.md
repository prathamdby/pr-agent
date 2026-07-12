# ADR 0006 — Separate security review summary sentinel

## Status

Superseded by [ADR 0022](0022-unified-multi-agent-review.md). Retained as history of the removed security review lens. Production concurrency and execution use pg-boss workers ([ADR 0009](0009-durable-agent-work.md)); references to `ReviewQueue` in this ADR describe the pre-0009 in-memory path only.

## Context

Issue #8 adds `/review-security`, a trigger-only deep security pass using an adapted DeepSec investigator prompt. General reviews (`/review` and automated `pull_request` events) already upsert a PR conversation summary identified by `## PR Agent Review`.

Operators may run both passes on the same PR. Overwriting the general summary with a security summary (or vice versa) would lose context.

## Decision

1. **Dual sentinels.** Security runs upsert comments starting with `## PR Agent Security Review`. General runs keep `## PR Agent Review`. Both can coexist on one PR.

2. **Inline review pointer.** Security inline reviews use a distinct pointer body directing readers to the security summary comment; event rules (`REQUEST_CHANGES` vs `COMMENT`) are unchanged.

3. **Publish failure fallback.** Security mode uses a matching fallback heading (`## PR Agent Security Review — could not publish structured output`).

4. **Shared pipeline.** Same `ReviewPayload` schema, `submitReview` tool, durable **review worker lane** (`agent-work-review` queue), and `MAX_TOOL_ROUNDS` — only the system prompt and publish surfaces differ (`mode: "review" | "review-security"`).

5. **No auto-trigger.** Security runs never fire on `pull_request` webhooks.

## Current implementation (2025-05)

- Slash `/review-security` and general reviews share [`runFullPrReview`](../../src/review/run/reviewRun.ts) but enqueue as separate work items per lens ([`scheduler.ts`](../../src/agentWork/scheduler.ts), intake in [`intake/applier.ts`](../../src/agentWork/intake/applier.ts)); see [ADR 0009](0009-durable-agent-work.md).

## Consequences

- Two summary comments may exist on one PR; help text documents this.
- Renderers and upsert logic must pass the correct sentinel per mode.
- Phase 3 (`category` slug badges) remains a follow-up; this ADR does not block it.

## Reversal

Revert to a single sentinel and pointer if product prefers one summary per PR (security overwrites general or merges into one table).
