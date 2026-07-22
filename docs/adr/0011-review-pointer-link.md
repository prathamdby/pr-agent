# ADR 0011 — Review pointer link on later runs

## Status

Accepted.

Amended by [ADR 0028](0028-orchestrated-review.md). The rule now applies to the
single general review summary for the pull request. Per-lens wording below is
historical.

## Context

The review pointer body on the Files Changed tab tells readers where to find the structured summary. On later review runs for the same pull request and review lens, maintainers expect a direct link to the existing PR conversation comment (which may temporarily show an in-progress stub). Reordering publish to upsert the full summary before inline review was rejected: it increased end-to-end latency without improving the first-review experience.

## Decision

1. **First completed-summary publish per PR + lens** — plain text pointer line (no hyperlink).
2. **Later runs for that lens** — pointer is only a markdown link (`View the updated review` / security equivalent) when a **verified** issue comment exists with the expected sentinel.
3. **Gating** — `shouldLinkToSummary` is true only when `publish_records` has a prior completed `summary_comment` for the same `resource_key` and `review_lens` from a different `work_item_id`. General and security lenses are independent.
4. **Verification** — stored `github_id` is a hint only; link only after `GET` issue comment confirms `body` still starts with the sentinel, or after `findIssueCommentBySentinel` fallback. If verification fails, fall back to plain text (no broken link).
5. **Publish order unchanged** — inline PR review first, summary upsert last.

## Consequences

- Second+ sync reviews get a one-click path to the conversation summary without an extra GitHub write at publish time.
- Deleted or edited-away summary comments degrade gracefully to plain text.
- One optional list-comments or get-comment read per linked publish when inline findings exist.

## Reversal

Remove `shouldLinkToSummary` plumbing and always use the plain pointer sentence.
