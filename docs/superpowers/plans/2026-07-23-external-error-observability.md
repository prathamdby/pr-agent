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

### Task 3: Orchestrator records send/salvage failures; ReviewRunResult carries lastFailure

**Files:**
- Modify: `src/review/run/reviewRunTypes.ts`
- Modify: `src/review/orchestrator/orchestratorRun.ts` (sendWithRetry catch, salvage log, return)
- Modify: `src/review/run/reviewRunFallback.ts`
- Test: extend `test/orchestratorRun.test.ts` and/or a focused unit test that mocks send failure

**Interfaces:**
- Consumes: `recordClassifiedFailure`, `classifiedFailureLogFields`
- Produces: `ReviewRunResult.lastFailure?: ClassifiedFailure`

- [ ] **Step 1: Write failing test** — when orchestrator send fails with insufficient credits (existing harness pattern), metrics/result expose `lastFailure.errorKind === "quota"` and `review_synthesis_publish_salvage` / completed result includes it. Prefer the smallest existing orchestrator test hook.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**
  - In `sendWithRetry` catch: `recordClassifiedFailure(classifyFailure(appError, { phase, domain: "provider" }))`
  - On salvage `logWarn("review_synthesis_publish_salvage", { ..., ...classifiedFailureLogFields(last) })`
  - Return `lastFailure: snapshotReviewRunMetrics()?.lastFailure ?? undefined`
  - `publishReviewRunFailureNotice` accepts optional `lastFailure` and logs it on `agent_publish_fallback`

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

// review failed — when result.published=false and lastFailure is quota:
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
  - `handleReviewPublishResult`: for not-published (non-superseded), merge `classifiedFailurePostHogProperties(result.lastFailure ?? snapshot?.lastFailure ?? classifyFailure(new Error("Review was not published"), { phase: "publish" }))` into `"review failed"` and `review_not_published` log.
  - Durable job: same for `agent_work_failed` / retrying / `"work item failed"`.

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
- Test: `test/triageAnalytics.test.ts`; targeted ask/description soft-fail tests if harness exists, else unit-level on helper usage

**Interfaces:**
- Consumes: `classifyFailure`, PostHog/log mappers

- [ ] **Step 1: Write failing tests** — `captureTriageFailure` includes `failure_domain` + `error_kind`; description/ask soft-fail logs include classified fields (and PostHog `"description failed"` / `"ask failed"` if introduced for parity).

- [ ] **Step 2: Implement** — on `description_not_published` / ask terminal paths, classify and emit. Prefer adding `"ask failed"` / `"description failed"` PostHog events on soft-fail for parity with `"review failed"` (only when not superseded). Verification: durable job already covers thrown failures; if verification has a soft not-published path, attach the same fields.

- [ ] **Step 3: Update `docs/operations.md`** — under PostHog bullet, document `failure_domain`, `error_kind`, `error_message` on `review failed`, `work item failed`, `triage failed`, and siblings; note superseded uses `error_kind=superseded` not provider.

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
- Provider adapters: only if messages are currently swallowed — inspect during Task 3; normalize with `cause` preserved if a quick win; otherwise rely on classifier string matchers.
