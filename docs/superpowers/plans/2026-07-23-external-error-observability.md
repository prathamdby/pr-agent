# External-error observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every terminal and soft-fail agent-work path records a classified failure (`failure_domain`, `error_kind`, sanitized `error_message`) in evlog and PostHog so provider quota/billing is diagnosable from one event.

**Architecture:** Shared `ClassifiedFailure` + `classifyFailure` (provider + GitHub + lifecycle hints). Persist last signal on `reviewRunMetrics`. Flatten into log meta (camelCase) and PostHog props (snake_case) at durable job, review executor, fallback, salvage, ask/description/triage failure sites. PR-facing copy unchanged.

**Tech Stack:** TypeScript, Vitest, existing `classifyProviderError`, `AppError`/`errorLogFields`, `sanitizeLogMessage`, PostHog `captureEvent`, evlog.

## Global Constraints

- CONTEXT.md vocabulary only — no synonym invention.
- Classification is logs/analytics only — never put credit/billing wording on GitHub comments.
- Prefer extending helpers over parallel systems.
- Last error wins; keep counters (`toolCallErrors` / `error_count`).
- Superseded/cancelled/stale_head must not classify as provider.
- Keep PostHog `provider_error_kind` on durable `"work item failed"` when `failure_domain === "provider"` (back-compat).
- No new env knobs unless required; reuse `MAX_LOG_MESSAGE_LEN` for truncation.
- Same-PR: update `docs/operations.md`.
- Run `nub run check:code` and tests before PR.

## File map

| File | Responsibility |
| ---- | -------------- |
| `src/errors/classifiedFailure.ts` | Types, `classifyFailure`, log/PostHog mappers, sanitize/truncate |
| `src/agent/providers/providerErrors.ts` | Expand credit/billing/402 matchers |
| `src/github/githubErrors.ts` | `GithubErrorKind` + `classifyGithubError` |
| `src/review/run/reviewRunMetrics.ts` | `lastFailure`, `recentToolErrors` (cap 3), `external_failure` / tool error text |
| `src/review/run/reviewRunTypes.ts` | Optional `lastFailure` on `ReviewRunResult` |
| `src/review/orchestrator/orchestratorRun.ts` | Record failures on send/salvage; return lastFailure |
| `src/review/run/reviewRunFallback.ts` | Log classified fields on `agent_publish_fallback` |
| `src/agentWork/durableJob.ts` | Full contract on retry/fail + PostHog |
| `src/agentWork/executors/reviewExecutor.ts` | `"review failed"` + `review_not_published` props |
| `src/agentWork/executors/askExecutor.ts` / `descriptionExecutor.ts` | Soft-fail classification |
| `src/agentWork/triageAnalytics.ts` | Merge classified props into `triage failed` |
| `docs/operations.md` | Query notes for new fields |
| Tests under `test/` mirroring above |

---

### Task 1: ClassifiedFailure core + expanded classifiers

**Files:**
- Create: `src/errors/classifiedFailure.ts`
- Create: `src/github/githubErrors.ts`
- Modify: `src/agent/providers/providerErrors.ts`
- Test: `test/classifiedFailure.test.ts`, `test/providerErrors.test.ts`, `test/githubErrors.test.ts`

**Interfaces:**
- Produces: `ClassifiedFailure`, `classifyFailure`, `classifiedFailureLogFields`, `classifiedFailurePostHogProperties`, `classifyGithubError`, expanded `classifyProviderError`

- [ ] **Step 1: Write failing classifier tests**

```ts
// test/providerErrors.test.ts — add:
it("classifies insufficient credits as quota", () => {
  expect(classifyProviderError(new Error("Insufficient credits for model"))).toBe("quota");
});
it("classifies 402 payment_required as billing", () => {
  expect(classifyProviderError(new Error("402 Payment Required: balance depleted"))).toBe("billing");
});

// test/githubErrors.test.ts
it("classifies Resource not accessible by integration as forbidden", () => {
  expect(
    classifyGithubError(Object.assign(new Error("Resource not accessible by integration"), { status: 403 })),
  ).toBe("forbidden");
});

// test/classifiedFailure.test.ts
it("classifies provider credit errors as provider/quota with sanitized message", () => {
  const f = classifyFailure(new Error("Insufficient credits"));
  expect(f.failureDomain).toBe("provider");
  expect(f.errorKind).toBe("quota");
  expect(f.errorMessage.toLowerCase()).toContain("credit");
});
it("does not label superseded as provider", () => {
  const f = classifyFailure(new Error("whatever"), { lifecycle: "superseded" });
  expect(f.failureDomain).toBe("internal");
  expect(f.errorKind).toBe("superseded");
});
it("maps stale_head lifecycle to internal/cancelled", () => {
  const f = classifyFailure(new Error("head moved"), { lifecycle: "stale_head" });
  expect(f.failureDomain).toBe("internal");
  expect(f.errorKind).toBe("cancelled");
});
```

- [ ] **Step 2: Run tests — expect FAIL** (`classifyFailure` / matchers missing)

Run: `nub run test -- test/providerErrors.test.ts test/githubErrors.test.ts test/classifiedFailure.test.ts`

- [ ] **Step 3: Implement classifiers + ClassifiedFailure**

`src/errors/classifiedFailure.ts` exports:

```ts
export type FailureDomain = "provider" | "github" | "internal" | "unknown";
export type ClassifiedErrorKind =
  | ProviderErrorKind
  | GithubErrorKind
  | "validation"
  | "publish"
  | "cancelled"
  | "superseded"
  | "unknown";

export type ClassifiedFailure = {
  readonly failureDomain: FailureDomain;
  readonly errorKind: ClassifiedErrorKind;
  readonly errorCode?: string;
  readonly errorMessage: string;
  readonly phase?: string;
  readonly toolName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly causeChain?: readonly string[];
  readonly errorCount?: number;
};

export type ClassifyFailureHints = {
  readonly domain?: FailureDomain;
  readonly phase?: string;
  readonly toolName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly lifecycle?: "superseded" | "cancelled" | "stale_head";
};

export function classifyFailure(error: unknown, hints?: ClassifyFailureHints): ClassifiedFailure;
export function classifiedFailureLogFields(f: ClassifiedFailure): Record<string, unknown>;
export function classifiedFailurePostHogProperties(f: ClassifiedFailure): Record<string, unknown>;
```

`classifyGithubError` kinds: `"auth" | "forbidden" | "not_found" | "validation" | "rate_limit" | "unknown"`.

Expand provider matchers for: `insufficient credits`, `credit`, `balance`, `payment_required`, `\b402\b`, `out of credits`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/errors/classifiedFailure.ts src/github/githubErrors.ts src/agent/providers/providerErrors.ts \
  test/classifiedFailure.test.ts test/providerErrors.test.ts test/githubErrors.test.ts
git commit -m "feat: add ClassifiedFailure and expand provider/GitHub classifiers"
```

---

### Task 2: Persist last failure on reviewRunMetrics

**Files:**
- Modify: `src/review/run/reviewRunMetrics.ts`
- Test: `test/reviewRunMetrics.test.ts`

**Interfaces:**
- Consumes: `ClassifiedFailure`, `classifyFailure`
- Produces: snapshot fields `lastFailure`, `recentToolErrors`; `recordClassifiedFailure`; tool_call may include `errorMessage?`

- [ ] **Step 1: Write failing test**

```ts
it("retains lastFailure and recent tool errors when tool_call fails with error text", async () => {
  await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
    initReviewRunMetrics({ provider: "pi", model: "m", mode: "review" });
    recordReviewMetric({
      kind: "tool_call",
      name: "publish_summary",
      ok: false,
      errorMessage: "Insufficient credits",
    });
    const snap = snapshotReviewRunMetrics();
    expect(snap?.toolCallErrors).toBe(1);
    expect(snap?.lastFailure?.errorKind).toBe("quota");
    expect(snap?.lastFailure?.toolName).toBe("publish_summary");
    expect(snap?.recentToolErrors?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — add fields; on failed tool_call with message, `classifyFailure` + push to `recentToolErrors` (cap 3, FIFO); export `recordClassifiedFailure(f)` that sets `lastFailure` and bumps `errorCount` if provided.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: retain last classified failure on review run metrics"
```

---

### Task 3: Orchestrator + tool adapters record real failures; ReviewRunResult carries lastFailure

**Files:**
- Modify: `src/review/run/reviewRunTypes.ts`
- Modify: `src/review/orchestrator/orchestratorRun.ts` (sendWithRetry catch, specialist error outcomes, salvage log, return)
- Modify: `src/review/run/reviewRunFallback.ts`
- Modify: provider tool_call sites that emit `ok: false` without text (e.g. `src/agent/providers/pi/index.ts`, cursor MCP bridge) to pass `errorMessage` (sanitized) or call `recordClassifiedFailure`
- Test: extend `test/orchestratorRun.test.ts` and/or focused unit tests for send/specialist/tool failure recording

**Interfaces:**
- Consumes: `recordClassifiedFailure`, `classifiedFailureLogFields`, `classifyFailure` (no forced `domain: "provider"`)
- Produces: `ReviewRunResult.lastFailure?: ClassifiedFailure`

**Classification precedence (required):** lifecycle hint → GitHub-shaped error (including `cause` chain) → provider classifier → AppError/internal → unknown. Never force `domain: "provider"` on send/tool catch.

**`stale_head` mapping:** `ClassifyFailureHints.lifecycle: "stale_head"` → `failureDomain: "internal"`, `errorKind: "cancelled"` (same family as cancelled; message may say stale head). Do not invent a new kind.

- [ ] **Step 1: Write failing tests**
  - Send / specialist / tool failure with “Insufficient credits” leaves `lastFailure.errorKind === "quota"` on metrics and `ReviewRunResult`.
  - Failed `tool_call` producers pass enough text for classification (not only `ok: false`).
  - GitHub-shaped publish error classifies as `failureDomain: "github"` (not provider).

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**
  - `sendWithRetry` catch: `recordClassifiedFailure(classifyFailure(appError, { phase }))` — no forced domain.
  - Specialist `outcome.kind === "error"`: record classified failure from `outcome.error` with phase/specialist hints before/alongside `review_specialist_failed`.
  - Publish-tool / GitHub failures: record with auto domain detection (cause-aware).
  - Pi / cursor MCP: on `ok: false`, pass `errorMessage` (or record classified failure) so metrics retain the reason.
  - Salvage + `publishReviewRunFailureNotice` / `publishFailureNotice`: always attach `snapshot.lastFailure` (or result field), not only when salvage/send path set it locally.
  - Return `lastFailure: snapshotReviewRunMetrics()?.lastFailure ?? undefined`

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: thread last classified failure through orchestrator soft-fail"
```

---

### Task 4: Review executor + durable job PostHog/evlog parity

**Files:**
- Modify: `src/agentWork/executors/reviewExecutor.ts`
- Modify: `src/agentWork/durableJob.ts`
- Test: `test/durableJobAnalytics.test.ts`; add/extend review executor analytics coverage

**Interfaces:**
- Consumes: `classifiedFailurePostHogProperties`, `classifiedFailureLogFields`, metrics snapshot / `result.lastFailure`

- [ ] **Step 1: Write failing tests**

```ts
// durableJobAnalytics — expect capture properties to include:
failure_domain, error_kind, error_message
// and provider_error_kind when domain is provider

// review failed — when a prior provider credit error was recorded on the run
// but publish soft-failed: MUST include failure_domain/error_kind/error_message.
// Do NOT accept a synthetic-only "Review was not published" fallback when
// snapshot/result already had lastFailure from tool/send/specialist.
expect(capture).toHaveBeenCalledWith(expect.objectContaining({
  event: "review failed",
  properties: expect.objectContaining({
    failure_domain: "provider",
    error_kind: "quota",
    error_message: expect.stringMatching(/credit/i),
  }),
}));
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**
  - `handleReviewPublishResult`: for not-published (non-superseded), require `result.lastFailure ?? snapshot?.lastFailure`. If present, merge `classifiedFailurePostHogProperties` into `"review failed"` and `review_not_published`. Synthetic fallback (`phase: "publish"`, kind `publish`/`unknown`) only when **no** prior signal exists — and a test must fail if a prior signal was dropped.
  - Check-run completion on failure: when completing with `conclusion: "failure"`, log classified fields alongside the existing summary if `lastFailure` is available (same source as PostHog).
  - Durable job: full contract on `agent_work_failed` / retrying / `"work item failed"`.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: attach classified failure to review failed and work item failed"
```

---

### Task 5: Ask / description / triage failure parity + ops docs

**Files:**
- Modify: `src/agentWork/executors/askExecutor.ts`, `descriptionExecutor.ts`
- Modify: `src/agentWork/triageAnalytics.ts`
- Modify: `docs/operations.md`
- Test: `test/triageAnalytics.test.ts`; ask/description soft-fail PostHog tests

**Interfaces:**
- Consumes: `classifyFailure`, PostHog/log mappers

- [ ] **Step 1: Write failing tests** — `captureTriageFailure` includes `failure_domain` + `error_kind`; non-superseded ask/description soft-fail emit PostHog `"ask failed"` / `"description failed"` with the same three required fields.

- [ ] **Step 2: Implement** — on `description_not_published` / ask soft-fail (and terminal failure hooks where needed), classify and emit `"ask failed"` / `"description failed"` (required, not optional). Verification: durable job covers thrown failures; attach classified fields on any soft not-published path if present.

- [ ] **Step 3: Update `docs/operations.md`** — under PostHog bullet, document `failure_domain`, `error_kind`, `error_message` on `review failed`, `work item failed`, `ask failed`, `description failed`, `triage failed`; note superseded uses `error_kind=superseded` not provider.

- [ ] **Step 4: Run `nub run check:code` and `nub run test`**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: parity classified failures for ask/description/triage; document ops fields"
```

---

## Spec coverage checklist

| Spec requirement | Task |
| ---------------- | ---- |
| Shared ClassifiedFailure contract | 1 |
| Expand provider credit/billing matchers | 1 |
| GitHub GraphQL integration forbidden | 1 |
| Superseded not provider | 1 |
| reviewRunMetrics last tool/send failure | 2 |
| Orchestrator send/salvage + soft-fail thread | 3 |
| agent_publish_fallback fields | 3 |
| review failed + review_not_published | 4 |
| work item failed full contract | 4 |
| Ask/description/triage parity | 5 |
| ops doc query notes | 5 |
| No PR-facing billing copy | all (no notice string changes) |

## Self-review notes

- No TBD placeholders.
- Types consistent: `ClassifiedFailure` / `classifyFailure` / mappers used across tasks.
- P1 “last N tool errors” capped at 3 via `recentToolErrors`.
- Provider tool_call sites that omit error text are in Task 3 (required), not optional.
- Peer-review (2026-07-23): fixed soft-fail lastFailure threading, no forced provider domain, required ask/description PostHog events, stale_head→cancelled mapping.
