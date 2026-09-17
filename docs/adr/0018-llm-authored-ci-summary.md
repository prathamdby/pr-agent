# ADR 0018 — LLM-authored CI summary from condensed Actions logs

## Status

Accepted. Decisions 5 and 6 are superseded by [ADR 0035](0035-head-ci-state-projection.md). Authoring lives on the projector and is cached by facts hash. Publish does not wait or poll. Later cells come from `pr_head_ci_state`, not a refresh job.

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

3. **`CiSummary` remains outside `ReviewPayload`.** It is a validated sibling merged at publish/refresh. Placement unchanged: after the findings rows in the overview gate table (the Security row was removed on 2026-09-14; see [ADR 0003](0003-structured-review-output.md)).

4. **Actions: read** is required for job-log download. Soft-fail without breaking the review: missing Checks shows a grant-Checks CI row; missing Actions on a red head keeps the failure row, falls back to condensed/redacted/size-bounded check output when possible, and adds a grant-Actions note.

5. **Timing. Superseded by [ADR 0035](0035-head-ci-state-projection.md).** Publish no longer waits or polls. `workflow_run` and `check_suite` completed deliveries enqueue one head-scoped `ci-projection`. The projector patches the marked cell from `pr_head_ci_state` when `head` matches and `v` is older.

6. **Noise filter. Superseded in part by [ADR 0035](0035-head-ci-state-projection.md).** Condensation and the prompt contract still prefer real failures over runner deprecation warnings. The LLM turn now runs on the projector once per facts hash, not at publish or on a refresh job.

## Amendment

The CI marker carries `head=<sha>`, `v=<version>`, and `fmt=<projection-format>`. Preserve drops the prior row when the marker head is missing or differs from the next review-meta head. Missing or unseeded heads render as `Waiting for CI`. A complete seeded empty snapshot renders `none` / "No CI checks on this head" on the visible gate and "No CI checks ran on this head" on the completed action line; the agent-fix prompt still omits `none`. Own-app `check_suite` deliveries are ignored at intake.

## Consequences

- Operators need **Actions: read** in addition to Checks read for rich failure explanations.
- A second LLM call runs on the projector when CI is failing and the facts hash is new. Passing/pending/none use server templates without a model call.
- Webhook subscriptions include **`workflow_run`** and **`check_suite`**. Those events enqueue `ci-projection`. The refresh queue lane is deleted.
- Annotation-first digests and “no Actions permission” assumptions from the first CI-summary design are obsolete.

## Reversal

Remove CI authoring, log download, refresh queue/webhook, and markers; restore a server-only digest or drop the CI row.
