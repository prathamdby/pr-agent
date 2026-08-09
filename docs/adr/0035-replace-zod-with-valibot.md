# ADR 0035 — Replace Zod with Valibot

## Status

Accepted.

## Context

All runtime validation used `zod` v4: webhook payload parsing ([ADR 0001](0001-webhook-boundary.md)), Pi tool input schemas converted with `z.toJSONSchema` ([ADR 0004](0004-native-pi-ai-toolset.md)), and the structured `ReviewPayload` contract ([ADR 0005](0005-structured-review-output.md)). ADR 0001 calls out that replacing Zod at the webhook boundary should be an explicit decision.

Valibot offers the same features this codebase exercises (objects, variants, unions, refinement via `check`/`forward`, `safeParse`, JSON Schema conversion) with a smaller, fully tree-shakeable runtime. The migration is mechanical: no validation semantics change.

## Decision

1. **Single validation library.** `valibot` replaces `zod` everywhere; `zod` is removed from dependencies.
2. **Call style.** Schemas are plain values; parsing is `v.parse(schema, data)` / `v.safeParse(schema, data)` instead of methods on the schema. Results expose `output` (was `data`) and `issues` (was `error.issues`).
3. **JSON Schema for Pi tools.** `@valibot/to-json-schema` (`errorMode: "ignore"`) replaces `z.toJSONSchema(..., { unrepresentable: "any" })`. Emitted schemas are draft-07 and omit `additionalProperties: false`; this is not load-bearing because tools do not opt into pi-ai constrained sampling (`strict`).
4. **Error formatting.** `src/util/formatValidationIssues.ts` formats `v.GenericIssue[]` (dot paths via `v.getDotPath`); `formatReviewValidationError` takes the issue list directly. `WebhookParseError` carries `valibotError` (a `v.ValiError`).
5. **Refinements.** Zod `superRefine` chains become `v.pipe(schema, v.check(...))`, with `v.forward` to attach issues to nested paths.

## Current implementation

- Webhook boundary: [`src/webhook/payloads/`](../../src/webhook/payloads/), [`parseGithubPayload.ts`](../../src/webhook/parseGithubPayload.ts)
- Tool schemas: [`defineWorkspaceTool.ts`](../../src/agent/tools/defineWorkspaceTool.ts), orchestrator/publish/triage/verification tool modules
- Structured outputs: [`reviewSchema.ts`](../../src/review/reviewSchema.ts), [`specialistReport.ts`](../../src/review/orchestrator/specialistReport.ts), [`descriptionSchema.ts`](../../src/agent/description/descriptionSchema.ts), [`triageSchema.ts`](../../src/review/triageSchema.ts), [`ciSummarySchema.ts`](../../src/review/ci/ciSummarySchema.ts), [`workItemPayloadSchema.ts`](../../src/agentWork/workItemPayloadSchema.ts)

## Consequences

- One less heavy dependency; schema definitions compose via `v.pipe` instead of chained methods.
- Validation error message strings differ from Zod's; anything pattern-matching exact Zod message text would break (none does — failure-kind mapping is internal).
- ADRs 0001, 0004, and 0005 remain as historical context; their Zod references describe the superseded implementation.

## Reversal

Restore the `zod` dependency and revert this commit. The schema surface is small enough that the swap is a mechanical find-replace in either direction.
