# ADR 0036 — Validate then repair tool inputs

## Status

Accepted.

## Context

Models emit structurally invalid tool arguments in a handful of predictable ways: a JSON array serialized as a string, a single object where the schema wants an array, a bare string where an array of strings is wanted, or `null` for an optional field. Before this change every parse site handled failures on its own: workspace tools threw a raw `ValiError` dump at the model, structured-output tools each formatted their own issue list, and `submitReview` ran its domain coercions unconditionally before every parse — mutating payloads that were already valid and logging `review_payload_coerced` for submissions the coercion never touched.

The four failure shapes above are mechanical and deterministic. Fixing them per call site duplicated the same logic and left most tools with no repair at all.

## Decision

1. **One validate-then-repair seam.** `src/agent/tools/parseToolInput.ts` exports `parseToolInput(schema, input, options)`: strict `v.safeParse` first; only on failure, clone the input and apply repairs at the failing dot paths; re-parse exactly once; return the parsed value or a formatted issue list. Valid input is never cloned or mutated.
2. **Exactly four ordered repairs.** `null_optional_dropped`, `stringified_json_array`, `object_wrapped_as_array`, `string_wrapped_as_array`. Ordering matters: a stringified array parses to the real array (rule 2) and is never re-wrapped by rule 4. Each repair is decided from the schema node at the failing path (valibot `wrapped` / `item` / `entries` / `pipe` shapes), not guessed from the value. `null_optional_dropped` fires only when the parent is an object, so a `null` nested inside an array stays put.
3. **Domain coercions run after validation failure.** `submitReview` tries the strict schema first and runs `coerceReviewPayloadInput` only when that fails, then the generic repairs. Valid payloads pass through untouched, and the `coercions` metric counts only submissions that actually needed a domain rule. `submitDescription` keeps its existing coerce-first order; its coercions are part of its accepted-input contract and are out of scope here.
4. **Shared across every tool surface.** The workspace executor seams (`defineWorkspaceTool`, `context7Tools`) and every structured-output submit tool (specialist brief, specialist report, publish thread, publish summary, submitReview, submitDescription, submitTriage, submitVerification) parse through the same helper. The generic `object_wrapped_as_array` rule covers the old `findings_object_to_array` domain coercion, which is deleted.
5. **Telemetry, not retries.** A repaired call logs `tool_input_repaired` with the tool name and the applied repair kinds, and bumps `toolInputRepairs` (keyed `${tool}:${repair}`) on the `review_run_completed` metrics snapshot. Repairs never loop: a still-invalid payload returns the formatted issue list to the model for a normal repair round.

## Current implementation

- Helper: [`src/agent/tools/parseToolInput.ts`](../../src/agent/tools/parseToolInput.ts)
- Executor seams: [`defineWorkspaceTool.ts`](../../src/agent/tools/defineWorkspaceTool.ts), [`context7Tools.ts`](../../src/agent/tools/context7Tools.ts)
- Metrics variant: [`reviewRunMetrics.ts`](../../src/review/run/reviewRunMetrics.ts) (`tool_input_repaired`)
- Validate-then-repair reorder originally lived in `submitReviewTool.ts` (deleted; [ADR 0039](0039-measured-tool-surface.md)); deleted domain rule in [`reviewSchema.ts`](../../src/review/reviewSchema.ts)

## Consequences

- Model-visible error text for workspace tools changes from a raw `ValiError` dump to a formatted dot-path issue list.
- The `findings_object_to_array` signal moves from `coercionsApplied` to `toolInputRepairs` (`submitReview:object_wrapped_as_array`); dashboards counting the old tag should switch.
- Valid `submitReview` payloads are no longer trimmed or fence-stripped by the domain coercion; text is published as the model sent it.
- Repair is bounded: one re-parse, four deterministic rules, no extra model round-trip.

## Reversal

Delete `parseToolInput.ts`, restore the deleted domain coercion, and point each call site back at `v.safeParse`. The seam is call-site shallow.
