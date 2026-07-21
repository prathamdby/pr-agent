# Structured AppError — Design

Date: 2026-07-21
Status: Approved (session walkthrough; implement now)

## Problem

Failures are mostly `throw new Error("...")` with opaque strings. Terminal paths
like review non-completion leave logs and dashboards without why / what / how.
PostHog and ops tooling cannot classify or debug consistently.

## Goals

1. One internal error type (`AppError`) across `src/`.
2. Every thrown failure carries a stable `code`, technical `message`, structured
   `context`, and optional `cause`.
3. PR-facing copy stays plain, non-technical English (separate constants /
   mappers). Never use `AppError.message` on the PR surface.
4. `logError` and durable-job failure logs serialize `code` + `context` + cause
   chain when the error is an `AppError`.

## Non-goals

- PostHog optional facade (tracked as a follow-up GitHub issue / PRD).
- Changing PR failure notice wording beyond keeping it user-facing and separate.
- Schema migration for `agent_work_items.last_error` (still a sanitized string;
  richer detail goes to logs).

## AppError shape

```ts
class AppError extends Error {
  readonly code: string; // "domain.reason_snake"
  readonly context: Record<string, unknown>; // JSON-safe bag
  readonly cause?: unknown;
}
```

Helpers: `isAppError`, `toAppError`, `serializeAppError` (for logs).

### Code convention

`<domain>.<reason_snake>` — examples: `review.publish_exhausted`,
`config.missing_env`, `triage.stale_head_push`, `webhook.parse_failed`.

### Domain subclasses

Existing typed errors (`WebhookParseError`, `StaleHeadPushError`,
`WorkItemPayloadValidationError`) extend `AppError`, keep their class names and
extra fields, and set a fixed `code`. Call sites using `instanceof` keep working.

### Message preservation

`.message` stays the same technical string tests and control flow already use.
Migration must not change user-visible PR strings.

## Logging

`logError(event, meta)` unchanged as API. Failure handlers merge
`serializeAppError(error)` into meta (sanitized). `last_error` DB column still
stores a sanitized message string only.

## Public vs internal

| Layer                    | Content                                   |
| ------------------------ | ----------------------------------------- |
| PR / ask failure notices | Short plain English constants (unslop)    |
| Logs / future PostHog    | `code`, technical message, context, cause |

## Verification

- Unit tests for `AppError` helpers
- Existing throw-message tests still pass
- `nub run check:code` and `nub run test`
