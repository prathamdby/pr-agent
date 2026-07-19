# ADR 0024 — Server-derived CI summary on the review gate table

## Status

Accepted.

## Context

Maintainers (and their coding agents) often open a PR Agent review summary, then still spend tokens reading GitHub Actions logs to learn why CI failed. The review summary already hosts overview gates (effort, findings, tests, security, merge verdict). A natural gap is an external-CI gate: either a green “all passing” signal or a concise failure digest with a fix direction.

Alternatives considered:

1. **Investigator-owned CI tools** — Give the review agent GitHub check/log tools. Rejected: ADR 0015 removed GitHub read tools from the investigation surface so the bug-finding budget stays on the local PR workspace; CI timing also often lags the review run.
2. **New durable work type on `check_suite` / `workflow_run`** — Best for late-arriving CI, but requires new webhook subscriptions and a follow-up edit path. Deferred.
3. **Server-derived fetch at publish (and lightweight stub at ack)** — Matches ADR 0005 (layout in code, not prompts) and the existing soft-fail Checks permission pattern.

## Decision

1. **Always on.** Ack and publish always attempt a **CI** table row (after Security, before Merge verdict).
2. **Server-derived `CiSummary`** is computed outside `ReviewPayload` and passed into the summary / progress stub renderers.
3. **Ack path** uses a lightweight snapshot (no annotation digests, no wait). **Publish path** may briefly wait/poll for terminal external checks (`REVIEW_CI_SUMMARY_WAIT_MS`), then digests failing check annotations and check output into reason + fix-hint lines (capped by `REVIEW_CI_SUMMARY_MAX_FAILURES`).
4. **Exclude PR Agent’s own check runs** (and the optional `pr-agent/review` commit status) so the feature never waits on itself.
5. Soft-fail / omit the row when Checks permission is missing, the fetch errors, or no external checks exist.

## Consequences

- Reviews that finish before CI may still show “CI still running” unless wait/poll covers the remaining time; a later webhook-driven refresh remains a follow-up.
- Failure digests depend on check annotations / output quality; Actions job-log download is not required for v1 (no new Actions permission).
- Operators should keep Checks read (already required for review check runs). Tune wait/poll/max-failures via `REVIEW_CI_SUMMARY_*` env vars.

## Reversal

Remove the CI row wiring in `publishReview`, `ackExecutor`, and the renderers.
