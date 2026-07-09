# ADR 0022 — Prompt-cost strategy and offline compression eval

## Status

Accepted.

## Context

Operators want lower token cost for review runs and asked whether a custom tokenizer format or prompt-compression scheme would help. Shorthand and compression can shrink visible bytes, but:

1. **Tokenization is provider- and model-specific.** Character counts and `characters/4` estimates are not billing tokens. An exact tokenizer dependency (e.g. tiktoken) only matches one family and adds install/native-build cost.
2. **Prompt caching prefers stable prefixes.** Providers that cache system prompts reward long-lived, unchanged leading text. Aggressive rewrites of static contracts can _increase_ cost by busting the cache even when raw bytes drop.
3. **Lossy compression removes review cues.** Severity labels, `submitReview` contract text, schema field names, and fixture evidence markers keep structured submission reliable. A compact format that strips them is a quality regression, not a win.
4. **Learned compressors (LLMLingua and similar)** need task-specific regression checks and live model eval — out of scope for CI unit tests and for this spike.

The repo already measures static prompt and tool surfaces in `test/promptCostBaselines.test.ts` via `test/helpers/promptCost.ts` (`characters/4` estimated tokens). That is the right foundation; what was missing is a **decision record** for cost strategy and an **offline harness** that compares candidate transforms without touching production prompts.

## Decision

1. **Preferred order of attack (do not skip ahead):**
   1. **Measure** — keep and extend prompt/tool cost baselines (`promptCostBaselines` + this eval harness).
   2. **Telemetry** — runtime usage metadata already records input bytes where providers expose them; expand carefully before inventing formats.
   3. **Bounded dynamic tool outputs** — continue capping tool results (`toolOutputBudget`); dynamic tails dominate many runs.
   4. **Deduplicate static prompt contracts** — shared blocks in `reviewPromptBlocks` already reduce drift; further dedupe beats private shorthand.
   5. **Evaluated compression or custom formats** — only after 1–4, and only candidates that pass the offline invariant harness (and later, stronger live evals).

2. **Offline eval harness (this PR).** Synthetic fixtures (correctness, security, false-positive trap, quality, tests, large/truncated) plus pure string candidate transforms live under `test/promptCostEval/`. The harness:
   - builds baseline surfaces through existing prompt builders;
   - applies baseline, compact-static, compact-tool-result, and test-only custom-shorthand transforms;
   - measures bytes and `characters/4` estimated tokens;
   - rejects candidates that drop structured submission markers, payload field names, severity labels, lens markers, or fixture `EVIDENCE:*` labels;
   - needs no network, provider credentials, Postgres, or GitHub.

3. **No production prompt change.** Compressed formats and the custom shorthand prototype stay test-only. Shipping a compressed production prompt requires a later decision backed by harness evidence (and preferably live quality eval).

4. **No tokenizer dependency by default.** Estimates use the existing `measurePromptCost` character heuristic. Adding an exact tokenizer requires an explicit follow-up that documents compatibility with Nub/pnpm, keeps the package out of production request paths initially, and proves it is optional relative to the baseline estimate. If a candidate tokenizer needs native builds that conflict with the toolchain, stop and report rather than force it in.

5. **Optional report script.** `scripts/prompt-cost-eval-report.mjs` may print a JSON comparison for local inspection (writes via `PROMPT_COST_EVAL_OUT` on the report-shape test); it is not required CI beyond the deterministic vitest suite.

## Consequences

- Contributors have a written order of operations: measurement and caching discipline before private formats.
- CI gains a regression net against lossy “optimizations” that strip review contracts.
- Future compression spikes have a fixture set and a machine-readable report shape (`surfaceName`, baseline/candidate bytes and estimated tokens, percent reduction, invariant pass/fail).
- Production review behavior is unchanged by this ADR.

## External guidance captured

- **Stable prefixes → cache hits.** Keep long-lived system prompt prefixes stable across runs; put volatile PR-specific text in the user message / trusted context tail.
- **Provider tokens ≠ estimates.** Treat `estimatedTokens` as a relative metric for diffs between candidates, not as a billing forecast.
- **Task-specific regression.** Any learned or aggressive compressor must re-check structured submission and lens behavior; byte wins without invariant wins are rejected.

## Reversal

Delete `docs/adr/0022-prompt-cost-strategy.md`, `test/promptCostEval/`, `test/promptCostCompressionEval.test.ts`, and any optional report script. Baseline budget tests in `promptCostBaselines.test.ts` remain the sole cost guardrail.
