# Rule Violation Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a finding cites a violated `.pr-agent/*.mdc` repo policy rule, show that path as a `<sub>` footer on the inline review thread body.

**Architecture:** Add optional `violatedRule` on `ReviewFinding`, validate it as a flat `.pr-agent/<name>.mdc` path, teach specialists via prompt contract, and append an escaped subscript line in `renderInlineThreadBody` after the Prompt to fix accordion. No summary-table or summary-only footer.

**Tech Stack:** TypeScript, Zod, Vitest, GitHub markdown (`<sub>`).

## Global Constraints

- Product term: **repo policy rules** (CONTEXT.md); field name `violatedRule` stores the relative path.
- Footer only on **inline review thread** bodies.
- Path shape: exactly `` `.pr-agent/<filename>.mdc` `` with filename `[A-Za-z0-9._-]+`.
- User-visible footer copy: `Rule · .pr-agent/<filename>.mdc` inside `<sub>…</sub>`, HTML-escaped.
- New max-char constant documented in `docs/configuration.md`.
- No new env knobs.

---

## File map

| File                                       | Responsibility                                       |
| ------------------------------------------ | ---------------------------------------------------- |
| `src/settings/reviewConstants.ts`          | `REVIEW_FINDING_VIOLATED_RULE_MAX_CHARS`             |
| `src/settings/index.ts`                    | re-export if needed                                  |
| `src/review/reviewSchema.ts`               | optional field + refine                              |
| `src/review/run/reviewRender.ts`           | footer render helper                                 |
| `src/review/prompts/reviewPromptBlocks.ts` | field contract in `reviewPayloadPerFindingContracts` |
| `CONTEXT.md`                               | glossary note on finding / repo policy               |
| `docs/configuration.md`                    | constant row                                         |
| `test/reviewSchema.test.ts`                | accept/reject                                        |
| `test/reviewRender.test.ts`                | footer present/absent                                |
| `test/reviewPromptContract.test.ts`        | contract string present                              |

---

### Task 1: Schema + constant

**Files:**

- Modify: `src/settings/reviewConstants.ts`
- Modify: `src/settings/index.ts` (only if constant not already barrel-exported via wildcards)
- Modify: `src/review/reviewSchema.ts`
- Modify: `docs/configuration.md`
- Test: `test/reviewSchema.test.ts`

- [ ] Add `REVIEW_FINDING_VIOLATED_RULE_MAX_CHARS` (use 80; path is short).
- [ ] Document the constant in `docs/configuration.md` beside other `REVIEW_FINDING_*` rows.
- [ ] Add optional `violatedRule: z.string().min(1).max(...).optional()` to `reviewFindingSchema`.
- [ ] `superRefine`: when present, must match `^\.pr-agent\/[A-Za-z0-9._-]+\.mdc$`.
- [ ] Update `formatReviewValidationError` field list if it enumerates finding keys.
- [ ] Tests: accept `.pr-agent/foo.mdc`; reject `../x`, `pr-agent/foo.mdc`, nested paths, empty string; legacy payloads without the field still parse.
- [ ] Run: `npx vitest run test/reviewSchema.test.ts`

### Task 2: Render footer

**Files:**

- Modify: `src/review/run/reviewRender.ts`
- Test: `test/reviewRender.test.ts`

- [ ] Add `renderViolatedRuleFooter(finding)` returning `[]` or `["", "<sub>Rule · …</sub>"]` with `escapeTableHtml` on the path.
- [ ] Append after the Prompt to fix `</details>` in `renderInlineThreadBody`.
- [ ] Tests: with field → footer present at end; without → no `<sub>Rule`; HTML special chars in filename escaped.
- [ ] Run: `npx vitest run test/reviewRender.test.ts`

### Task 3: Prompt + glossary

**Files:**

- Modify: `src/review/prompts/reviewPromptBlocks.ts`
- Modify: `CONTEXT.md`
- Test: `test/reviewPromptContract.test.ts`

- [ ] Add `violatedRuleFieldContract` describing optional path, only when grounded in that repo policy rule, never invent missing rules.
- [ ] Include it in `reviewPayloadPerFindingContracts`.
- [ ] In CONTEXT.md under **Repo policy rules** or **Finding fix prompt** neighborhood, note that inline threads may show a subscript footer naming the violated rule path when set.
- [ ] Assert specialists’ shared contracts include `violatedRule` wording.
- [ ] Run: `npx vitest run test/reviewPromptContract.test.ts`

### Task 4: Verify + ship

- [ ] Run focused suite: schema + render + prompt contract.
- [ ] deslop → commit → make-pr to `main`.
