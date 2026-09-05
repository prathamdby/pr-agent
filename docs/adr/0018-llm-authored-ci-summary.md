# ADR 0018 — LLM-authored CI summary from condensed Actions logs

## Status

Accepted.

## Context

An earlier server-derived **CI summary** gate used Checks annotations and check output. Digests were weak: they never downloaded Actions job logs, and warning annotations (for example Node 20 deprecation) could dominate the row when the real failure was lint/format/tests.

Product intent shifted: maintainers (and coding agents) need a natural-language explanation of _what failed and how to fix_, authored from condensed logs—not a static string pick from annotations.

Constraints that still hold:

1. Investigation budget stays on the local PR workspace ([ADR 0011](0011-agent-runner-local-pr-workspace.md)) — do not give the review agent open-ended GitHub log tools as the primary CI path.
2. Layout stays in code ([ADR 0003](0003-structured-review-output.md)) — the model fills structured fields; the server renders the HTML table cell.
3. Auto-review remains `opened`-only — do not re-run full review on every push just to refresh CI.

## Decision

1. **Split ownership.** Server fetches external checks/statuses, waits/polls, downloads failing Actions job logs when permitted, then selects **one** condensed, redacted, size-bounded context (Actions logs, else check output) before the LLM turn. It validates schema and renders the CI cell. The LLM interprets that single `<ci_context>` and fills `headline` / `failures[]` (reason + fixHint). Server overwrites `status` and check `name`s from GitHub facts when the model drifts. It also owns check-run completeness: an incomplete retrieved view never becomes passing or none, and a model headline cannot restore an all-passing claim. Known failures stay failing with a partial-coverage headline. Raw check output is never a second author/prompt field.

2. **Option B — separate cheap CI-summary call.** Finding investigation stays CI-free. At publish (and on CI-complete refresh), run a small tool-free LLM turn: condensed `<ci_context>` in → structured CI fields out. Ack stays facts-only (no LLM): `⏳ CI still running` / green / red headline without failure digests.

3. **`CiSummary` remains outside `ReviewPayload`.** It is a validated sibling merged at publish/refresh. Placement unchanged: after Security in the overview gate table.

4. **Actions: read** is required for job-log download. Soft-fail without breaking the review: missing Checks shows a grant-Checks CI row; missing Actions on a red head keeps the failure row, falls back to condensed/redacted/size-bounded check output when possible, and adds a grant-Actions note.

5. **Timing.** Publish reuses `REVIEW_CI_SUMMARY_WAIT_*` wait/poll. Wait durations stay as they are. Failing-head annotation and job-log fetches run concurrently within `REVIEW_CI_SUMMARY_FETCH_CONCURRENCY`; workflow runs are filtered to the reviewed head before job listing; raw logs are bounded to a failure-preserving intake window before condensation. If still pending at publish, leave a pending row. When CI later completes, a `workflow_run` or `check_suite` (completed) webhook enqueues a CI-refresh job that surgically edits the CI cell (HTML markers) on the matching **review summary comment** for that head SHA — without a full re-review. A refresh that arrives while a review is still queued or running is retained on that same lane (delayed re-enqueue, bounded `attempt`) until it can patch or the cap is exhausted; a superseded head never overwrites a newer cell.

6. **Noise filter.** Condensation and the prompt contract prefer real failures (test/lint/type/build) over Actions runner deprecation warnings.

## Consequences

- Operators need **Actions: read** in addition to Checks read for rich failure explanations.
- A second LLM call runs at publish when CI is failing (and again on refresh). Passing/pending/none use server templates without a model call.
- Webhook subscriptions grow to include **`workflow_run`** and **`check_suite`**. Topology gains a CI-refresh queue lane.
- Annotation-first digests and “no Actions permission” assumptions from the first CI-summary design are obsolete.

## Reversal

Remove CI authoring, log download, refresh queue/webhook, and markers; restore a server-only digest or drop the CI row.
