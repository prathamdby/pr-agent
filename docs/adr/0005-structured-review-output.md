# ADR 0005 — Structured review payload and two non-overlapping surfaces

## Status

Accepted.

## Context

The review agent previously instructed the model to submit a GitHub pull request review **and** a freehand PR conversation comment. Both surfaces repeated the same severity-tagged findings. PR-Agent solves layout drift with a structured intermediate and server-side render, but collapses findings into one conversation comment with deep-links—we keep **inline review threads** on the Files Changed tab as the primary surface.

## Decision

1. **`ReviewPayload`** (Zod) is the single source of truth per review run, emitted via a **`submitReview`** pseudo-tool exactly once. The payload accepts up to 12 findings.
2. **Server-side renderers** (`reviewRender.ts`) produce inline thread bodies (P0–P2, with `Prompt to fix` accordion), the **review pointer body** (Files-tab pull request review header with a link to the review summary comment plus an aggregate **agent fix prompt** accordion), and the **review summary comment** (sentinel `## PR Agent Review`, table overview with deep-links only—no duplicated finding bodies).
3. **Publish** (`publishReview.ts` + `github/reviewPublish.ts`) calls Octokit directly; `createPullRequestReview` / `addPullRequestComment` are **filtered out** of the review agent tool list. Before creating inline review threads, publish ensures a sentinel summary placeholder exists so the pointer body can link to it; the final summary is written only after inline publish succeeds.
4. **Phase 3:** summary comment upsert by sentinel; optional idempotent labels (`Review effort N/5`, `Possible security concern`) behind config flags.
5. **Exhaustive single-pass review** — prompts require one broad investigation phase that inventories changed files, sweeps each visible patch, applies lens-specific cross-cutting checks, then submits once. This borrows the coverage benefits of multi-pass review without adding a continuous re-review loop.
6. **Strict bugs only** — no suggestions/improvements framing; `fixPrompt` is for coding agents, not human refactor advice. P2 findings may be plausible defects with file/line evidence even when not proven end-to-end; P3 remains overview-only.

## Consequences

- Three publish surfaces per review run when P0–P2 findings exist: **inline review threads** (per-finding on the diff), **review pointer body** (aggregate agent fix prompt for copy-paste into coding agents), and **review summary comment** (overview table only). The no-duplication rule applies to the summary comment, not the pointer body.
- The pointer body can link to the summary comment without risking loss of the final summary when GitHub rejects inline thread creation, because only a placeholder is created before inline publish.
- Raising the cap to 12 increases recall and inline-comment volume; false positives and secondary rate-limit pressure must be monitored.
- Layout changes require code, not prompt edits (intentional).
- Validation failures get one repair turn; double failure logs only (no PR comment).
- We diverge from PR-Agent on surface model (inline threads retained) and scope (no `/improve`-style suggestions).

## Reversal

Revert `submitReview`, renderers, and publish pipeline; restore freehand delivery instructions in `reviewRun.ts` and full GitHub tool exposure to the agent.
