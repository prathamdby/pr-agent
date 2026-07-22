# Plan: inline single-use helpers

## Goal

Collapse Speculative Generality / Middle Man helpers that have exactly one caller, following a codebase-wide hunt. Example target: `isRecord` in test helpers.

## Requirements

1. Hunt across `src/`, `test/helpers/`, and `site/` with parallel agents.
2. Inline only one-caller helpers whose bodies are small enough that inlining lowers reader load.
3. Keep helpers with 2+ callers (for example `isRecord` in `publishRecordRepository.ts`).
4. No behavior change. Pin with the existing unit suite.
5. Ship on a follow-up branch from the knip cleanup tip.

## Non-goals

- Do not inline large one-caller functions (>~8 lines of real logic).
- Do not remove type predicates that mark a parse boundary when they earn their name and have multiple uses.
