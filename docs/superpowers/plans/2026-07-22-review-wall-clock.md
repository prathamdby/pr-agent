# Plan: Review wall-clock duration

Spec: `docs/superpowers/specs/2026-07-22-review-wall-clock-design.md`

## Steps

1. Add `resolveReviewWallClockMs` + tests in `reviewRunFooter` (or small sibling module).
2. Add `getProgressStubPostedAtMs`; persist/preserve `stubPostedAtMs` in `upsertSummaryCommentAtRevision`.
3. Wire summary publish + lightweight completion to freeze after CI (summary) / before upsert and resolve from stub time.
4. Optionally seed `initReviewRunMetrics({ startedAtMs })` when stub time is already readable.
5. Update `CONTEXT.md` Review run footer definition.
6. Run targeted tests, then `nub run check:code` / related suite.
