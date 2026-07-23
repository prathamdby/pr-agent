# External-error observability (logs + PostHog) — Design

Date: 2026-07-23  
Status: Approved (mission brief for PR #333 incident; implement now)  
Incident: orchestrated review failed after specialists when the LLM provider ran out of credits; operators and PostHog saw only `review failed` / `agent_publish_fallback` with `publish_attempts` and no error reason.

## Problem

Soft-fail and “not published” paths often finish without throwing. Terminal handlers then emit evlog / PostHog events that count attempts (`publish_attempts`, `toolCallErrors`) but omit **why**. Durable job hard-fail already calls `classifyProviderError`; review / ask / description / triage soft-fail paths do not. PostHog AI then guesses GitHub App permissions when the real cause was provider quota/billing.

## Goals

1. Every terminal and near-terminal agent-work failure records a **classified external failure** (domain + kind + sanitized message) in **evlog and PostHog**.
2. Soft-fail “not published” paths attach the **last known** external failure from the run (last error wins), not omit because the final branch was local.
3. Classification stays **logs/analytics only** — PR-facing failure notices remain neutral (no credit/billing wording).
4. Prefer extending existing helpers (`classifyProviderError`, `AppError` / `errorLogFields`, durable-job pattern, `reviewRunMetrics`) over parallel systems.

## Non-goals

- Changing PR-visible failure copy.
- Fixing provider credits/billing.
- A new analytics product or dashboard.
- Dumping full stack traces / prompts / tool bodies into PostHog.

## Approaches considered

| Approach       | Idea                                                                                                                                                                                 | Trade-off                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **A (chosen)** | Shared `ClassifiedFailure` + `classifyFailure(error, hints)`; persist last signal on `reviewRunMetrics` / run result; flatten into log meta and PostHog props at every failure event | Small surface; matches durable-job pattern; soft-fail readable without ALS magic |
| B              | Separate failure ring-buffer on logger context for all work types                                                                                                                    | Better “last N” history; more invasive; duplicates metrics store for review      |
| C              | Analytics middleware auto-attaches classification from async context                                                                                                                 | Hard to test; opaque call sites; easy to attach stale/wrong signals              |

**Recommendation:** A. Put last-signal fields on `reviewRunMetrics` (already ALS-backed). For ask/description/triage/verification, classify at the catch / soft-fail site (error is in hand). Cap recent tool errors at N=3 on metrics for P1.

## Data contract

Internal type (camelCase, matching `AppError` / metrics style):

```ts
type FailureDomain = "provider" | "github" | "internal" | "unknown";
type ClassifiedErrorKind =
  | ProviderErrorKind // auth | quota | billing | rate_limit | timeout | unknown
  | GithubErrorKind // auth | forbidden | not_found | validation | rate_limit | unknown
  | "validation"
  | "publish"
  | "cancelled"
  | "superseded"
  | "unknown";

type ClassifiedFailure = {
  failureDomain: FailureDomain;
  errorKind: ClassifiedErrorKind;
  errorCode?: string; // AppError.code when present
  errorMessage: string; // sanitizeLogMessage, truncated
  phase?: string;
  toolName?: string;
  provider?: string;
  model?: string;
  causeChain?: string[]; // short sanitized messages, hard-capped (e.g. 5)
  errorCount?: number; // optional; tool_call_errors / retry count
};
```

PostHog property names (snake_case, matching existing `provider_error_kind` / `pr_number`):

| Field         | PostHog key      |
| ------------- | ---------------- |
| failureDomain | `failure_domain` |
| errorKind     | `error_kind`     |
| errorCode     | `error_code`     |
| errorMessage  | `error_message`  |
| phase         | `phase`          |
| toolName      | `tool_name`      |
| provider      | `provider`       |
| model         | `model`          |
| causeChain    | `cause_chain`    |
| errorCount    | `error_count`    |

**Rules**

- Every terminal failure event **must** include at least `failure_domain`, `error_kind`, `error_message`.
- Soft failures that end as “not published” **must** attach the last known signal from the run.
- Last error wins; keep counters (`toolCallErrors` / `error_count`) so recovery rounds do not erase reason.
- Superseded / cancelled / stale_head → `failureDomain: "internal"`, `errorKind` in `{superseded, cancelled}` — never provider.
- Do not log full prompts, tool result bodies, or secrets.

## Architecture

### Classification module

Extend / add under `src/agent/providers/` and `src/github/` (or thin `src/errors/classifyFailure.ts` that owns the union):

1. **`classifyProviderError`** — expand matchers: credit, balance, payment_required, 402, OpenCode/DeepSeek/Cursor SDK wording. Keep logs-only.
2. **`classifyGithubError`** — new; kinds from HTTP status + GraphQL “Resource not accessible by integration”, 401/403/404/422, GitHub rate limit. Reuse `httpStatus` / message helpers near `src/github/reviewErrors.ts`.
3. **`classifyFailure(error, hints?)`** — picks domain:
   - hints: `{ domain?, phase?, toolName?, provider?, model?, lifecycle?: "superseded" | "cancelled" | "stale_head" }`
   - if lifecycle hint → internal superseded/cancelled
   - else if GitHub-shaped (Octokit / GraphQL / status) → github
   - else if provider classifier ≠ unknown, or phase is model/tool → provider
   - else AppError.code domain prefix / validation → internal
   - else unknown
4. **Mappers:** `classifiedFailureLogFields(f)` (camelCase meta), `classifiedFailurePostHogProperties(f)` (snake_case). Always run `sanitizeLogMessage` on messages / cause chain.

### Persistence of last signal (review)

`reviewRunMetrics` gains:

- `lastFailure: ClassifiedFailure | null`
- `recentToolErrors: ClassifiedFailure[]` (cap 3)
- `lastToolErrorKind` / `lastToolErrorMessage` may be derived from `lastFailure` when `toolName` set — prefer single `lastFailure` field plus optional recent list to avoid three sources of truth.

New metric events (or extend `tool_call`):

- `tool_call` may carry optional `error?: unknown` / classified fields when `ok: false`
- `external_failure` event to record send/session/GitHub publish failures

Orchestrator `sendWithRetry` / specialist failures / publish tool failures call `recordReviewMetric` (or a thin `recordClassifiedFailure`) so soft-fail terminal paths still see the last reason when `judgment` stays `"model"` and no exception escapes.

`ReviewRunResult` optionally carries `lastFailure` for executors that do not have logger metrics context; prefer metrics snapshot when available, result field as belt-and-suspenders.

### Call-site inventory (must instrument)

| Surface              | Events / logs                                                                                          | Source of signal                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Durable job          | `agent_work_failed`, `agent_work_retrying`, PostHog `"work item failed"`                               | thrown error → `classifyFailure`; emit full contract (`failure_domain`, `error_kind`, `error_message`, …). Keep `provider_error_kind` when `failure_domain === "provider"` for back-compat (same value as `error_kind`). |
| Review executor      | `review_not_published`, PostHog `"review failed"`                                                      | metrics / result lastFailure; superseded path does **not** emit `"review failed"` as provider                                                                                                                            |
| Review fallback      | `agent_publish_fallback`                                                                               | accept optional lastFailure; log kind+message                                                                                                                                                                            |
| Orchestrator         | `review_synthesis_publish_salvage`, send retry/fail, session create fail                               | record + log classified fields                                                                                                                                                                                           |
| Ask / description    | soft-fail logs + add failure PostHog events where missing                                              | classify at catch / not-published                                                                                                                                                                                        |
| Triage               | `captureTriageFailure`                                                                                 | merge classified PostHog props                                                                                                                                                                                           |
| Verification         | terminal failure paths                                                                                 | same contract                                                                                                                                                                                                            |
| Check-run completion | failure summaries already set; ensure complete-from-failure logs include classification when available |                                                                                                                                                                                                                          |

### Provider adapters

When wrapping SDK errors in `src/agent/providers/{pi,cursor}/`, preserve `cause` and a useful `.message` so classifiers see credit/quota text. No new provider surface on PRs.

## Testing (TDD)

1. Classifier unit tests: provider credit/billing strings → `quota` / `billing`; GitHub GraphQL “Resource not accessible by integration” → github `forbidden` (or authz kind); superseded hint → not provider.
2. Metrics: recording a failed tool/send leaves `lastFailure` readable from snapshot.
3. Executor / durable-job tests: fake “insufficient credits” → PostHog props include `error_kind` in `{quota,billing}` and sanitized `error_message`; `"review failed"` never only `publish_attempts` when a prior failure was recorded.
4. Existing analytics / sanitize tests still pass.

## Docs (same PR)

- `docs/operations.md` — note new PostHog/evlog fields and how to query (`error_kind`, `failure_domain`, `error_message` on `review failed` / `work item failed` / siblings).
- No CONTEXT.md synonym invention.
- Configuration inventory only if new constants appear (message truncation caps may reuse `MAX_LOG_MESSAGE_LEN`).

## Acceptance

An on-call engineer can answer from one PostHog event or one worker log line: provider credits/billing vs GitHub authz vs rate limit vs timeout vs validation vs superseded/cancelled — and the sanitized reason.

## Out of scope reminders

- Do not reintroduce misleading fields (e.g. `MAX_REVIEW_PUBLISH_CALLS` next to orchestrator `publishAttempts`).
- Do not ask humans to check GitHub App permissions first when the signal is clearly provider quota/billing.
