# ADR 0016 — Separate code-quality review lens

## Status

Superseded by [ADR 0028](0028-orchestrated-review.md). Quality is now one fixed
specialist inside the orchestrated review run. The command, sentinel, and mode
described below remain recognized only as legacy artifacts. `submitReview` is
deleted ([ADR 0039](0039-measured-tool-surface.md)).

## Context

Operators asked for the depth of the thermo-nuclear code quality review skill (abstraction quality, file-size smells, spaghetti-condition growth, code-judo restructurings) inside pr-agent. The general `/review` prompt is a defect hunter that explicitly forbids prescriptions and refactors. Thermo-nuclear is entirely prescriptions. Folding it into the general prompt would corrupt every auto-review.

## Decision

1. **Third lens, slash-only.** Add `/review-quality` as a trigger-only deep code-quality pass (mirrors `/review-security`). Never auto-runs on `pull_request` webhooks.

2. **Dual sentinel.** Quality runs upsert comments starting with `## PR Agent Quality Review`. General and security summaries are unchanged; all three can coexist on one PR.

3. **Reuse P0–P3.** Map thermo's structural ladder onto existing severities in the prompt only — no schema, validator, publish, label, or fingerprint changes.

4. **Prescription posture.** Unlike the general lens, the quality prompt requires actionable restructuring direction in `fixPrompt`. This is prompt prose only; the shared `ReviewPayload` schema is unchanged.

5. **Shared pipeline.** Same `ReviewPayload` schema, `submitReview` tool, durable review worker lane, and `MAX_TOOL_ROUNDS` — only the system prompt and publish surfaces differ (`mode: "review" | "review-security" | "review-quality"`).

## Consequences

- Up to three summary comments may exist on one PR; help text documents this.
- Renderers and upsert logic pass the correct sentinel and pointer body per mode.
- Database CHECK constraints on `review_lens` are widened via migration `002_review_quality_lens.sql`.

## Reversal

Remove the lens, migration rollback, and sentinel/pointer constants if product prefers folding quality into general review (not recommended — contradicts general prompt contract).
