# Design: Repo policy rule footer on inline findings

## Problem

When a finding is an evidenced violation of a **repo policy rule** (`.pr-agent/*.mdc`), readers of the **inline review thread** cannot see which rule was cited unless the model buried it in `detail`. Maintainers want a quiet, structured mention.

## Decision

1. Add optional finding field `violatedRule`: relative path to one `.pr-agent/<name>.mdc` file loaded for the review.
2. When present, `renderInlineThreadBody` appends a single subscript footer after the Prompt to fix accordion:
   `<sub>Rule · .pr-agent/&lt;name&gt;.mdc</sub>`
3. Omit the footer when the field is absent or empty. Do not put the footer on the review summary table or summary-only rows.
4. Specialists set the field only when the finding is grounded in that rule; ordinary findings leave it unset.
5. Schema accepts only `.pr-agent/<filename>.mdc` (no `..`, no nested dirs, no other prefixes). Invalid values fail validation so the model repairs.

## Non-goals

- Agent instruction files (`AGENTS.md` / etc.) — not “pr-agent rules.”
- Auto-inferring the rule from detail text.
- Showing the rule body or linking into the blob (path text is enough).

## Surfaces

| Surface                     | Change                                                                |
| --------------------------- | --------------------------------------------------------------------- |
| `reviewFindingSchema`       | optional `violatedRule`                                               |
| Specialist + review prompts | field contract                                                        |
| `renderInlineThreadBody`    | subscript footer                                                      |
| Docs                        | `CONTEXT.md` glossary note; `docs/configuration.md` max-char constant |
| Tests                       | schema, render, prompt contract                                       |
