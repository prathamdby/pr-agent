# ADR 0022 — One multi-agent Review run replaces review lenses

## Status

Accepted. Supersedes ADR 0006 and ADR 0016 as active product behaviour, plus the lens-specific parts of ADRs 0009, 0011, 0014, and 0018. Those ADRs remain in the repository as decision history.

## Context

The previous review architecture exposed four independent products: automated/general `/review`, `/review-security`, `/review-quality`, and `/review-tests`. Each command created its own durable work item, investigator prompt, singleton key, progress comment, labels, fingerprint namespace, and publish surface.

That split forced maintainers to choose review coverage before the system had inspected the change, allowed overlapping reviews to disagree or duplicate findings, and could produce four summaries for one pull request. It also made one investigator responsible for both repository-wide analysis and final presentation.

We want one command and one public result while retaining independent review perspectives. The durable queue boundary remains valuable: a Review run should still be one retriable pg-boss work item with one idempotent publish record.

## Decision

1. **One active review identity.** `/review` is the only review slash command. Automated reviews and slash reviews enqueue the same `review` work type with one per-PR singleton key, one `## PR Agent Review` progress/summary comment, one label family, and one retry command. The removed lens commands return normal help guidance and never enqueue work.

2. **In-process fan-out inside one durable job.** A full Review run prepares one read-only local PR workspace, then creates eight independent reviewer-agent sessions: correctness, security, tests, maintainability, project standards, reliability, API/contracts, and adversarial analysis. Reviewer sessions share repository state but not provider conversation state. Fan-out is bounded by the code constant `REVIEW_AGENT_CONCURRENCY` (default `4`); `REVIEW_CONCURRENCY` continues to control concurrent durable Review jobs.

3. **Internal reports, not public reviews.** Reviewer agents receive read-only workspace and documentation tools plus `submitReviewerReport`. They cannot call `submitReview`. Each submits structured coverage, candidate findings, residual risks, and testing gaps. Repository and PR content remain untrusted data in every reviewer prompt.

4. **Required coverage and independent validation.** Correctness and security reports are required; failure of either fails the Review run before publication. Other reviewer failures produce degraded coverage supplied to synthesis. Candidate P0 and P1 findings are checked by separate read-only validator sessions and rejected candidates are removed.

5. **One publishing orchestrator.** After validation, one orchestrator session receives all surviving reports and the degraded-coverage state. It can use the same read-only tools to resolve conflicts, merge duplicate claims, and reject unsupported findings. It is the only session with `submitReview`, so the existing ReviewPayload validation, placement, fingerprint suppression, labels, check/status publication, summary upsert, and publish recovery remain the sole public path.

6. **Provider-neutral lifecycle.** Pi and Cursor sessions accept cooperative cancellation signals and expose cancellation/disposal. Every reviewer and validator session is disposed after completion or failure; the orchestrator owns its own isolated session.

7. **Historical compatibility is read-only.** Existing GitHub comments, database rows, pointer markers, sentinels, and findings from `review-security`, `review-quality`, and `review-tests` are not rewritten. Their identifiers may remain in internal compatibility types and inventory queries so triage and verification can recognize historical findings. New intake, execution, fingerprints, labels, comments, and publish records always use `review`.

8. **Unified repository policy.** `.pr-agent.yml` replaces per-lens overrides with one optional `instructions` string for the comprehensive Review run. The deprecated `lensOverrides` key is accepted and ignored with a warning so existing policy files keep their unified settings during migration.

There is no legacy execution switch. Reversal requires a new architecture decision and code change rather than an operator toggle.

## Consequences

- Maintainers receive one synthesized review and no longer choose or coordinate lenses.
- Each full Review run uses more provider sessions. Operators must budget for `worker replicas × REVIEW_CONCURRENCY × REVIEW_AGENT_CONCURRENCY` reviewer fan-out, plus validator and orchestrator sessions.
- Reviewer completion order does not create multiple public outputs; only the orchestrator can publish.
- Required correctness/security coverage favors completeness over partial publication. Optional-angle failures can still yield a review, with degraded coverage available to the orchestrator.
- Reviewer reports remain ephemeral. If a durable Review job retries after process failure, the reviewer fan-out runs again.
- Historical lens constants may remain where needed to interpret stored state, but they are not active commands or execution modes.

## Reversal

There is no runtime rollback path. To reverse, restore a separately approved review architecture, its command and persistence semantics, and matching documentation. Historical lens rows and comments already remain readable, so reversal does not require rewriting old GitHub or Postgres data.
