# ADR 0012 — Cached diff validation and summary-first publish

> **Changelog:** §6 revised 2026-05-25 — narrowed **Public-output sanitizer** after false-positive whole-field redaction on normal review prose (see PR #38).

## Status

Accepted. The `submitReview` publish budget described below is historical; that tool is deleted ([ADR 0039](0039-measured-tool-surface.md)). The word `submitReview` remains unredacted vocabulary in the public-output sanitizer.

## Context

Structured review publish could fail when GitHub rejected inline review anchors (`Line could not be resolved`), blocking the PR conversation summary. When publish recovery exhausted, the agent fallback asked the model for prose that leaked internal tooling failures, attempt counts, and approximate findings into public comments.

## Decision

1. **Cached diff index** — Capture `listPullRequestFiles` output during the review run and derive `commentableRightLineRanges` per file. Do not fetch a fresh diff at publish time.

2. **Server-side placement** — Validate each finding against cached ranges before calling GitHub. Unresolvable findings become **summary-only findings**; the model does not choose placement.

3. **Summary-first publish** — Always upsert the structured PR conversation summary when publish succeeds. Inline review creation is best-effort; GitHub rejections are logged privately and do not fail the review.

4. **Deterministic failure notice** — When publish is exhausted, upsert a neutral review failure notice without model-authored fallback prose, attempt counts, or internal API details.

5. **Publish execution budget** — Cap valid `submitReview` publish executions with `MAX_REVIEW_PUBLISH_CALLS` (default 2), separate from model recovery phases.

6. **Public-output sanitizer** — At the pre-publish boundary (`prepareReviewPayloadForPublish`), replace credential- and assignment-shaped substrings in PR-visible review text with `[redacted]` (shared `BOT_SECRET_PATTERNS` via `redactOutboundSecrets`). Do not whole-field redact code-review vocabulary (`submitReview`, `GitHub API`, etc.). Internal failure phrasing on overview fields (`prCharacter`, `securityConcerns`, `followUps`) is rejected by **Review payload** validation (repair loop), not silently redacted. Finding fields are not checked for internal phrasing.

## Consequences

- Reviews with invalid inline anchors still deliver actionable findings in the summary.
- Inline thread count may be lower on large or patch-omitted diffs; summary markers show `Inline thread posted` vs `Summary only`.
- Cached diff may be stale if the PR head moves during a long run; `commit_id: headSha` reduces but does not eliminate that risk.
- ADR 0005’s “summary does not duplicate inline bodies” assumption is relaxed: the summary now includes compact details for all findings.
- Findings and overviews may mention repository symbols and tooling names; only secret-shaped substrings are scrubbed at publish.

## Reversal

Revert to inline-first publish and model-authored fallback by removing cached diff validation and restoring prose fallback generation in `reviewRun.ts`.
