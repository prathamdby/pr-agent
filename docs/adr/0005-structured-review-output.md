# ADR 0005 — Structured review payload and two non-overlapping surfaces

## Status

Accepted.

Amended by [ADR 0028](0028-orchestrated-review.md). `ReviewPayload` remains the
validated summary tool contract. The orchestrated run now publishes inline
findings incrementally before the final summary instead of calling
`submitReview` once for the whole run.

## Context

The review agent previously instructed the model to submit a GitHub pull request review **and** a freehand PR conversation comment. Both surfaces repeated the same severity-tagged findings. PR-Agent solves layout drift with a structured intermediate and server-side render, but collapses findings into one conversation comment with deep-links—we keep **inline review threads** on the Files Changed tab as the primary surface.

## Decision

1. **`ReviewPayload`** (Zod) is the single source of truth per review run, emitted via a **`submitReview`** pseudo-tool exactly once.
2. **Server-side renderers** (`reviewRender.ts`) produce inline thread bodies (P0–P3, with `Prompt to fix` accordion), the **review pointer body** (per-specialist Files-tab pull request review header: NOTE linking to the **review progress comment** plus a specialist tagline; no Fix All accordion), and the **review summary comment** (sentinel `## PR Agent Review`, overview alert plus a unified table: effort, finding rows keyed by severity, tests, security, and follow-ups; aggregate **agent fix prompt** accordion below the table; hidden **stale review metadata** HTML comment). Finding rows for inline-posted severities list title, location, and a footnote only; **detail text appears in the summary table only for summary-only placements**. P3 is inline-eligible so `/triage` can fix it; review check runs still fail only for P0–P2 (see [ADR 0029](0029-p3-inline-triage.md)).
3. **Publish** ([`publish/publishReview.ts`](../../src/review/publish/publishReview.ts) + [`github/reviewPublish.ts`](../../src/github/reviewPublish.ts)) calls Octokit directly; `createPullRequestReview` / `addPullRequestComment` are **filtered out** of the review agent tool list.
4. **Phase 3:** summary comment upsert by sentinel; optional idempotent labels (`Review effort N/5`, `Possible security concern`) behind config flags.
5. **Strict bugs only** — no suggestions/improvements framing; `fixPrompt` is for coding agents, not human refactor advice.

## Consequences

- Three publish surfaces per review run when P0–P3 findings exist: **inline review threads** (per-finding on the diff), **review pointer body** (per-specialist NOTE + tagline pointing at the progress stub), and **review summary comment** (overview table plus one aggregate agent fix prompt for the full run). The no-duplication rule applies to finding bodies in the summary table, not the agent fix prompt accordion.
- Layout changes require code, not prompt edits (intentional).
- Validation failures get one repair turn; double failure logs only (no PR comment).
- We diverge from PR-Agent on surface model (inline threads retained) and scope (no `/improve`-style suggestions).

## Reversal

Revert `submitReview`, renderers, and publish pipeline; restore freehand delivery instructions in `reviewRun.ts` and full GitHub tool exposure to the agent.
