# Maybe: review quality bets

Status: **Maybe**. Promote accepted items to `docs/adr/0015-*` or later.

This document lists larger review-quality improvements deferred from the grilled quick-wins PR. Each section includes a short Proposed ADR stub.

---

## Multi-pass ensemble / validator LLM

**Context:** Single-pass reviews miss issues that ensemble or majority-vote pipelines catch.

**Options:** 3-pass parallel review with merge; optional LLM judge on P0-P1 only; full 8-pass BugBot-style ensemble.

**Recommendation:** Start with 3-pass on large PRs only after eval harness exists.

**Proposed ADR:** Accept ensemble only when resolution rate improves on BugBench mini without unacceptable cost.

---

## Outcome metrics and resolution rate

**Context:** Commercial tools track whether flagged issues were fixed before merge.

**Options:** `review_outcomes` table; evlog-only metrics; GitHub thread state scraping.

**Recommendation:** Defer for self-hosted deployments; revisit if operators need SQL dashboards.

**Proposed ADR:** Add durable outcomes only when a concrete ops query requirement exists.

---

## Feedback and embedding filter

**Context:** Greptile-style learning from thumbs up/down reduces noise over time.

**Options:** Reaction webhooks; slash `/feedback`; vector similarity filter on finding text.

**Recommendation:** Not aligned with self-hosted minimal scope; document patterns for forks.

**Proposed ADR:** Reject until explicit product requirement for adaptive suppression.

---

## CI / check context prefetch

**Context:** Failing checks often explain the highest-value review findings.

**Options:** Worker prefetch of check runs; new GitHub tools; prompt-only guidance.

**Recommendation:** Prefetch + trusted context block when App permissions include checks:read.

**Proposed ADR:** Add check context when permission model and rate-limit budget are documented.

---

## Security review presets

**Context:** `/review-security` runs full DeepSec-style prompt; teams may want focused auth or secrets passes.

**Options:** Slash args (`/review-security auth`); payload preset field; separate sentinels per preset.

**Recommendation:** Preset in work payload + prompt fragment; keep one security summary comment.

**Proposed ADR:** Accept preset args without new `review_lens` DB values.

---

## PR-size limit scaling

**Context:** v1 ships advisory review budget tier hints only.

**Options:** Scale `MAX_TOOL_ROUNDS` and finding caps by tier; skip LLM on extreme size.

**Recommendation:** Scale limits only after measuring false skip rate on monorepos.

**Proposed ADR:** Tie scaled limits to tier constants and truncation flag.

---

## Repo dependency graph

**Context:** Diff-only review misses cross-file bugs.

**Options:** Import graph; symbol index; full Greptile-style repo graph.

**Recommendation:** Start with import graph for changed files only.

**Proposed ADR:** Index incrementally on synchronize; never block webhook intake on indexing.

---

## Sandbox analyzers / SAST

**Context:** CodeRabbit runs linters and static analyzers beside LLM review.

**Options:** Container sandbox with gVisor; CI check reuse; local eslint/typecheck only.

**Recommendation:** Sandbox required before executing untrusted repo code; start with read-only SAST APIs.

**Proposed ADR:** No arbitrary code execution without isolation boundary.

---

## Semantic review cache

**Context:** Repeated synchronize events re-review unchanged semantic chunks.

**Options:** File blob SHA cache; LLM summary diff; fingerprint-only skip (partially shipped for inline).

**Recommendation:** Extend fingerprint model before LLM-based semantic cache.

**Proposed ADR:** Cache at file SHA granularity with explicit invalidation on head SHA change.

---

## Custom repo rules (`.pr-agent.yml`)

**Context:** Teams want path-specific or plain-English rules.

**Options:** Repo config file; GitHub App manifest; env-only globs.

**Recommendation:** `.pr-agent.yml` with schema version 1; validate at worker preflight.

**Proposed ADR:** Rules augment prompts and gates; never replace structured publish path.

---

## Fix-in-agent integration

**Context:** Review comments could launch coding agents with bundled fix prompts.

**Options:** Cursor deep link; copy-paste accordion only (current); auto-branch.

**Recommendation:** Keep accordion; optional Cursor button as provider-specific enhancement.

**Proposed ADR:** Fix flow stays opt-in; no auto-commit from bot.

---

## Risk classifier routing

**Context:** Not every PR needs the same investigation depth.

**Options:** Heuristic tier router; cheap model classifier; path-only rules (partially shipped).

**Recommendation:** Combine path profile + size tier before adding ML classifier.

**Proposed ADR:** Classifier output selects budget tier and prompt fragment only.

---

## Dashboards

**Context:** Operators want resolution rate, cost per PR, and noise trends.

**Options:** SQL views on outcomes; Grafana; evlog export.

**Recommendation:** Defer until outcome metrics ADR is accepted.

**Proposed ADR:** Dashboards read from durable outcomes, not evlog alone.
