# ADR 0023 — Verification stub ledger (edit-in-place + resolve-on-dismiss)

## Status

Accepted.

## Context

ADR 0021 kept dismissed findings unresolved so maintainers could see the acknowledgment and policy suggestion. Combined with a work-item-scoped `actedThreadIds` checkpoint, every later `synchronize` verification run re-included those open threads and posted another `**Verification**: dismissed` (or still-open) reply — as seen on pr-agent #280.

Still-open replies had the same cross-run gap: each verification work item started with an empty acted set and stacked new replies instead of updating the prior signal.

Policy suggestions always rendered a from-scratch `.pr-agent.yml` snippet, even when the repo already had a policy file.

## Decision

1. **One verification stub per finding thread.** Publish owns a single bot reply marked `<!-- pr-agent:verification-stub -->`. Still-open updates edit that comment in place; they never create a second reply when a stub exists (ledger or thread scan).

2. **Resource-scoped thread ledger.** Persist `{ threads: { [rootCommentId]: { stubCommentId, lastVerdict, lastHeadSha, terminal? } } }` on `publish_records` for lens `verification` / step `verification_thread_actions`. Load by `resource_key` (not `work_item_id`). Merge per-thread on write. Recover missing stub ids by scanning the thread for the marker (or legacy `**Verification**:` replies).

3. **Dismissed is terminal for verification.** Validation requires an authorized non-bot maintainer decision matching the finding thread; unauthorized reply text remains untrusted evidence. Edit the stub into the dismissed body (evidence + grounded policy suggestion), then `resolveReviewThread`. Resolved threads drop out of the next open inventory. `/triage` dismissed resolve is defined in [ADR 0037](0037-triage-resolve-completed-threads.md).

4. **Grounded policy suggestions.** While the read-only PR repository view is open, load `.pr-agent/*.mdc` rules and pass the result into publish. Exactly one matching rule → append fragment; absent → new starter `.mdc`; invalid/missing → new starter plus the parse failure reason.

5. **Silent resolve for fixed / already-resolved stays as ADR 0021.**

## Consequences

- Stops stacked verification spam across pushes without requiring maintainers to manually resolve dismissed threads.
- Still-open signal stays one editable stub per thread.
- Amends ADR 0021 decision (2) for verification dismissals only: verification may resolve after acknowledging dismiss.
- Requires capturing the GitHub review-comment id on create so later runs can edit.

## Reversal

Restore create-only replies, stop resolving on dismiss, and revert the ledger detail shape to `actedThreadIds` loaded by work item.
