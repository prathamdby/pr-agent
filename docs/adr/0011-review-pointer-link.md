# ADR 0011 — Review pointer link (2nd+ review)

## Status

Accepted. After [ADR 0028](0028-orchestrated-review.md), pointer linking is single-mode (`review` only): first completed-summary publish stays plain text; later **orchestrated review runs** may link to the verified `## PR Agent Review` summary. General vs security lens independence no longer applies for new writes; historical lens rows remain readable.

## Context

The review pointer body on the Files Changed tab tells readers where to find the structured summary. On later review runs for the same pull request, maintainers expect a direct link to the existing PR conversation comment (which may temporarily show an in-progress stub). (**Historical:** linking was once scoped per review lens; new writes are single-mode `review` only.) Reordering publish to upsert the full summary before inline review was rejected: it increased end-to-end latency without improving the first-review experience.

## Decision

1. **First completed-summary publish per PR** — plain text pointer line (no hyperlink). (**Historical:** once keyed per PR + lens.)
2. **Later runs** — pointer is only a markdown link (`View the updated review`) when a **verified** issue comment exists with the expected sentinel. (**Historical:** security lens used a distinct security-equivalent link string.)
3. **Gating** — `shouldLinkToSummary` is true only when `publish_records` has a prior completed `summary_comment` for the same `resource_key` and `review_lens` from a different `work_item_id`. New writes always use `review_lens='review'`; **historical** general/security lens independence remains only for reading old rows.
4. **Verification** — stored `github_id` is a hint only; link only after `GET` issue comment confirms `body` still starts with the sentinel, or after `findIssueCommentBySentinel` fallback. If verification fails, fall back to plain text (no broken link).
5. **Publish order** — incremental **thread batches** (inline) may land before the final summary upsert; summary still publishes last for the run.

## Consequences

- Second+ sync reviews get a one-click path to the conversation summary without an extra GitHub write at publish time.
- Deleted or edited-away summary comments degrade gracefully to plain text.
- One optional list-comments or get-comment read per linked publish when inline findings exist.

## Reversal

Remove `shouldLinkToSummary` plumbing and always use the plain pointer sentence.
