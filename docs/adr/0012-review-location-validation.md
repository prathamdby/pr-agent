# ADR 0012 — Cached diff validation and summary-first publish

## Status

Accepted.

## Context

Structured review publish could fail when GitHub rejected inline review anchors (`Line could not be resolved`), blocking the PR conversation summary. When publish recovery exhausted, the agent fallback asked the model for prose that leaked internal tooling failures, attempt counts, and approximate findings into public comments.

## Decision

1. **Cached diff index** — Capture `listPullRequestFiles` output during the review run and derive `commentableRightLineRanges` per file. Do not fetch a fresh diff at publish time.

2. **Server-side placement** — Validate each finding against cached ranges before calling GitHub. Unresolvable findings become **summary-only findings**; the model does not choose placement.

3. **Summary-first publish** — Always upsert the structured PR conversation summary when publish succeeds. Inline review creation is best-effort; GitHub rejections are logged privately and do not fail the review.

4. **Deterministic failure notice** — When publish is exhausted, upsert a neutral review failure notice without model-authored fallback prose, attempt counts, or internal API details.

5. **Publish execution budget** — Cap valid `submitReview` publish executions with `MAX_REVIEW_PUBLISH_CALLS` (default 2), separate from model recovery phases.

6. **Public-output sanitizer** — Redact internal/tooling phrases from PR-visible review text at the renderer boundary.

## Consequences

- Reviews with invalid inline anchors still deliver actionable findings in the summary.
- Inline thread count may be lower on large or patch-omitted diffs; summary markers show `Inline thread posted` vs `Summary only`.
- Cached diff may be stale if the PR head moves during a long run; `commit_id: headSha` reduces but does not eliminate that risk.
- ADR 0005’s “summary does not duplicate inline bodies” assumption is relaxed: the summary now includes compact details for all findings.

## Reversal

Revert to inline-first publish and model-authored fallback by removing cached diff validation and restoring prose fallback generation in `reviewRun.ts`.
