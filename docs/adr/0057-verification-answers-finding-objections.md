# ADR 0057: Verification answers finding objections

## Status

Accepted. Amends [ADR 0014](0014-verification-run-work-type.md),
[ADR 0015](0015-verification-silent-resolve.md), and
[ADR 0016](0016-verification-stub-ledger.md). Follows
[ADR 0054](0054-finding-identity-on-github.md). The marker is the authority,
the thread lock wraps the write, and the worker rereads the thread before it
writes.

## Context

Verification stays quiet when a finding is fixed or already resolved, and it
keeps one editable stub for a still-open or dismissed verdict. A person can
reply on the finding thread after the bot posts it. That reply can dispute the
finding. The next verification run used to resolve or refresh the stub without
answering the dispute.

The reply text is untrusted. A bot author is not a maintainer, even when the
association is `OWNER`. GitHub is the record of whether this install already
answered that revision. The ledger is only a retry journal.

## Decision

1. **One answer for an unanswered objection.** A finding objection is a `User`
   review comment on the bot finding thread, from a user id other than the bot,
   whose `createdAt` or `updatedAt` is strictly after the root finding comment.
   The anchor is that root comment. A later stub, `**Triage**:` reply, or ask
   reply does not move it. Each presented dispute gets one `concede` or one
   `hold`. A `not_objection` classification is not posted. The answer is one
   new reply. It starts with `**Verification reply**:`. It carries
   `<!-- pr-agent:objection-answer v=1 c=<commentId> u=<updatedAt> -->` and the
   operation-intent marker. Fixed and already-resolved keep their silent
   resolve after that reply. The answer names the fixing commit on `fixed`.
   Dismissed still writes the stub, the policy suggestion, and the receipt
   after the answer, then resolves. An unauthorized `concede` does not take
   the dismissed path. Publish appends `A maintainer can dismiss this finding.`
   when the body does not already contain it.
2. **The stub stays the verdict signal.** Objection answers are separate
   replies. Publish never edits an answer as if it were the stub, and never
   edits the stub to carry the answer.
3. **The marker is the answered authority.** A revision drops only when a
   reply that passes `isBotAuthor` carries the marker for that comment id and
   `updatedAt`. A human-authored copy does not count. The operation key is
   `verification:objection:` plus the root comment id, the objection comment
   id, and 16 hex characters of `sha256(updatedAt)`. It does not match
   `^verification:thread:\d+$`. Recovery checks a completed journal receipt for
   that revision, then exact child-intent evidence, then a fresh review-comment
   listing. A truncated listing stays transient. A retained intent whose head
   SHA disagrees fails closed. Deleting the accepted reply inside the same work
   item is absence and is not a second post.
4. **The worker rereads under the thread lock.** The answer helper does not
   take `threadMutationLock`. Fixed and dismissed already hold
   `thread-mutation:<resourceKey>`. A skipped thread takes that lock once when
   an answer or a stub write is owed. Before the write, `getReviewThread` must
   show the objection comment, the same `updatedAt`, no bot marker for that
   revision, a complete comment page, and an unresolved thread. A human resolve
   skips the answer and does not fail the run. An `updatedAt` mismatch posts
   nothing, does not resolve, and does not write or edit a stub. The thread
   stays open.
5. **Caps and degradation.** One run answers at most
   `VERIFICATION_MAX_OBJECTION_ANSWERS_PER_RUN` (8), oldest `createdAt` then
   comment id. Overflow records `objection_answers_capped`. A truncated
   review-comment list clears every candidate, records
   `objection_detection_incomplete`, and still publishes verdicts. There is no
   new environment variable. `FEATURE_VERIFICATION=off` stops new enqueue. It
   is not a barrier for work already queued.

## Consequences

- Silence has one exception. An unanswered objection gets one answer, including
  when the verdict is fixed or already-resolved.
- A database wipe or an old worker forgets `not_objection` rows. The current
  parser drops unknown JSON fields, and there is no compatibility writer.
  Markers remain, so a posted answer is not repeated.
- Rollback is deploying the previous worker. It ignores the new markers and
  can drop `not_objection` classifications on the next ledger save.

## Reversal

Stop posting objection answers, leave the markers in place, and restore the
ADR 0015 silence rule with no exception.
