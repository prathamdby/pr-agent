# Phase 1 — AppError scaffold

Back: [overview.md](./overview.md)

## Goal

Ship `AppError` and helpers with unit tests. No call-site migration yet.

## Changes

- Add `src/errors/appError.ts` (`AppError`, `isAppError`, `toAppError`,
  `serializeAppError`).
- Add `test/appError.test.ts`.

## Data structures

`AppError`: `code: string`, `message: string`, `context: Record<string, unknown>`,
optional `cause`. `serializeAppError` returns a JSON-safe log bag.

## Verification

`nub run test -- test/appError.test.ts`
