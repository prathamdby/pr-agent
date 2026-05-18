# ADR 0006 — Separate security review summary sentinel

## Status

Accepted.

## Context

Issue #8 adds `/review-security`, a trigger-only deep security pass using an adapted DeepSec investigator prompt. General reviews (`/review` and automated `pull_request` events) already upsert a PR conversation summary identified by `## PR Agent Review`.

Operators may run both passes on the same PR. Overwriting the general summary with a security summary (or vice versa) would lose context.

## Decision

1. **Dual sentinels.** Security runs upsert comments starting with `## PR Agent Security Review`. General runs keep `## PR Agent Review`. Both can coexist on one PR.

2. **Inline review pointer.** Security inline reviews use a distinct pointer body directing readers to the security summary comment; event rules (`REQUEST_CHANGES` vs `COMMENT`) are unchanged.

3. **Publish failure fallback.** Security mode uses a matching fallback heading (`## PR Agent Security Review — could not publish structured output`).

4. **Shared pipeline.** Same `ReviewPayload` schema, `submitReview` tool, `ReviewQueue`, and `MAX_TOOL_ROUNDS` — only the system prompt and publish surfaces differ (`mode: "review" | "review-security"`).

5. **No auto-trigger.** Security runs never fire on `pull_request` webhooks.

## Consequences

- Two summary comments may exist on one PR; help text documents this.
- Renderers and upsert logic must pass the correct sentinel per mode.
- Phase 3 (`category` slug badges) remains a follow-up; this ADR does not block it.

## Reversal

Revert to a single sentinel and pointer if product prefers one summary per PR (security overwrites general or merges into one table).
