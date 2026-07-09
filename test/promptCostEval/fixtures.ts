/** Synthetic offline fixtures for prompt-cost compression eval. */

export type ReviewLens = "review" | "review-security" | "review-quality" | "review-tests";

export type PromptCostEvalFixture = {
  readonly id: string;
  readonly lens: ReviewLens;
  readonly title: string;
  readonly changedFiles: readonly string[];
  readonly diffContent: string;
  readonly supportingContext: string;
  readonly expectedFindingMechanisms: readonly string[];
  readonly mustNotReportMechanisms: readonly string[];
  readonly evidenceLabels: readonly string[];
};

export const PROMPT_COST_EVAL_FIXTURES: readonly PromptCostEvalFixture[] = [
  {
    id: "correctness-null-deref",
    lens: "review",
    title: "Null dereference after optional map lookup",
    changedFiles: ["src/billing/retry.ts"],
    diffContent: [
      "diff --git a/src/billing/retry.ts b/src/billing/retry.ts",
      "--- a/src/billing/retry.ts",
      "+++ b/src/billing/retry.ts",
      "@@ -10,6 +10,9 @@ export function nextAttempt(job: Job | undefined) {",
      "-  return job.attempts + 1;",
      "+  const found = jobs.find((j) => j.id === job?.id);",
      "+  // EVIDENCE:null-deref — found may be undefined when job is missing",
      "+  return found.attempts + 1;",
    ].join("\n"),
    supportingContext: [
      "Changed files: src/billing/retry.ts",
      "Path profile: application code",
      "EVIDENCE:billing-retry-path",
    ].join("\n"),
    expectedFindingMechanisms: [
      "optional map/find result used without null check",
      "runtime TypeError when job is missing",
    ],
    mustNotReportMechanisms: ["rename variable for style", "prefer const over let without bug"],
    evidenceLabels: ["EVIDENCE:null-deref", "EVIDENCE:billing-retry-path"],
  },
  {
    id: "security-sql-interpolation",
    lens: "review-security",
    title: "SQL built with string concatenation from request id",
    changedFiles: ["src/api/orders.ts"],
    diffContent: [
      "diff --git a/src/api/orders.ts b/src/api/orders.ts",
      "--- a/src/api/orders.ts",
      "+++ b/src/api/orders.ts",
      "@@ -4,3 +4,6 @@ export async function getOrder(req: Request) {",
      "+  // EVIDENCE:sql-injection — user-controlled orderId in query text",
      '+  const sql = "SELECT * FROM orders WHERE id = \'" + req.params.orderId + "\'";',
      "+  return db.query(sql);",
    ].join("\n"),
    supportingContext: [
      "Changed files: src/api/orders.ts",
      "Trust boundary: HTTP request params",
      "EVIDENCE:trust-boundary-http",
    ].join("\n"),
    expectedFindingMechanisms: [
      "sql-injection via string interpolation",
      "user-controlled identifier reaches raw SQL",
    ],
    mustNotReportMechanisms: ["missing rate limit with no sensitive side effect claimed"],
    evidenceLabels: ["EVIDENCE:sql-injection", "EVIDENCE:trust-boundary-http"],
  },
  {
    id: "false-positive-intentional-any",
    lens: "review",
    title: "Intentional any at a documented interop boundary",
    changedFiles: ["src/interop/legacy.ts"],
    diffContent: [
      "diff --git a/src/interop/legacy.ts b/src/interop/legacy.ts",
      "--- a/src/interop/legacy.ts",
      "+++ b/src/interop/legacy.ts",
      "@@ -1,3 +1,6 @@",
      "+// EVIDENCE:intentional-any — documented bridge to untyped vendor SDK",
      "+// The vendor SDK has no types; cast is intentional and reviewed.",
      "+export function bridge(input: unknown): any {",
      "+  return input;",
      "+}",
    ].join("\n"),
    supportingContext: [
      "Changed files: src/interop/legacy.ts",
      "EVIDENCE:documented-interop",
      "Maintainer note: intentional untyped bridge; do not re-report style-only any usage.",
    ].join("\n"),
    expectedFindingMechanisms: [],
    mustNotReportMechanisms: [
      "forbid any without trigger path",
      "style-only cast nit with no bug",
      "cosmetic rename of bridge",
    ],
    evidenceLabels: ["EVIDENCE:intentional-any", "EVIDENCE:documented-interop"],
  },
  {
    id: "quality-1k-line-growth",
    lens: "review-quality",
    title: "File crosses 1000 lines without decomposition",
    changedFiles: ["src/handlers/mega.ts"],
    diffContent: [
      "diff --git a/src/handlers/mega.ts b/src/handlers/mega.ts",
      "--- a/src/handlers/mega.ts",
      "+++ b/src/handlers/mega.ts",
      "@@ -990,3 +990,20 @@ export function handleMega(req: Request) {",
      "+  // EVIDENCE:1k-line-growth — file moves past 1000 lines with new branch",
      '+  if (req.query.mode === "special") {',
      "+    return specialCasePath(req);",
      "+  }",
      "+  // ... many more lines pushing file over 1000 ...",
    ].join("\n"),
    supportingContext: [
      "Changed files: src/handlers/mega.ts",
      "File size before: 995 lines; after: 1020 lines",
      "EVIDENCE:file-size-smell",
    ].join("\n"),
    expectedFindingMechanisms: [
      "1k-line file-growth smell",
      "prefer decomposition over growing mega handler",
    ],
    mustNotReportMechanisms: ["missing unit test for specialCasePath (wrong lens)"],
    evidenceLabels: ["EVIDENCE:1k-line-growth", "EVIDENCE:file-size-smell"],
  },
  {
    id: "tests-untested-error-path",
    lens: "review-tests",
    title: "New error branch without a test case",
    changedFiles: ["src/payments/charge.ts", "test/payments/charge.test.ts"],
    diffContent: [
      "diff --git a/src/payments/charge.ts b/src/payments/charge.ts",
      "--- a/src/payments/charge.ts",
      "+++ b/src/payments/charge.ts",
      "@@ -20,4 +20,8 @@ export async function charge(card: Card) {",
      "+  // EVIDENCE:untested-error-path — new timeout branch, no test asserts it",
      "+  if (card.networkTimedOut) {",
      "+    throw new ChargeTimeoutError(card.id);",
      "+  }",
      "diff --git a/test/payments/charge.test.ts b/test/payments/charge.test.ts",
      "--- a/test/payments/charge.test.ts",
      "+++ b/test/payments/charge.test.ts",
      "@@ -5,3 +5,6 @@",
      "+// EVIDENCE:happy-path-only — still only covers successful charge",
      '+it("charges a valid card", async () => { ... });',
    ].join("\n"),
    supportingContext: [
      "Changed files: src/payments/charge.ts, test/payments/charge.test.ts",
      "EVIDENCE:test-gap-timeout",
    ].join("\n"),
    expectedFindingMechanisms: [
      "proposed test for ChargeTimeoutError path",
      "untested error branch on busy payment path",
    ],
    mustNotReportMechanisms: ["sql-injection (wrong lens)", "file-size smell (wrong lens)"],
    evidenceLabels: [
      "EVIDENCE:untested-error-path",
      "EVIDENCE:happy-path-only",
      "EVIDENCE:test-gap-timeout",
    ],
  },
  {
    id: "large-truncated-context",
    lens: "review",
    title: "Large diff with truncated tool output marker",
    changedFiles: ["src/bulk/transform.ts", "src/bulk/helpers.ts"],
    diffContent: [
      "diff --git a/src/bulk/transform.ts b/src/bulk/transform.ts",
      "--- a/src/bulk/transform.ts",
      "+++ b/src/bulk/transform.ts",
      "@@ -1,3 +1,12 @@",
      "+// EVIDENCE:off-by-one — loop uses <= length causing out-of-range read",
      "+export function mapAll(items: Item[]) {",
      "+  const out = [];",
      "+  for (let i = 0; i <= items.length; i++) {",
      "+    out.push(items[i].id);",
      "+  }",
      "+  return out;",
      "+}",
      '<!-- tool_result truncated="true" reason="response byte budget exceeded" -->',
      "EVIDENCE:truncated-tool-result",
    ].join("\n"),
    supportingContext: [
      "Changed files: src/bulk/transform.ts, src/bulk/helpers.ts",
      "Size budget: large PR; tool outputs may be truncated",
      "EVIDENCE:large-pr-budget",
    ].join("\n"),
    expectedFindingMechanisms: [
      "off-by-one loop bound",
      "out-of-range array access when i equals length",
    ],
    mustNotReportMechanisms: ["report every helper rename as P0"],
    evidenceLabels: [
      "EVIDENCE:off-by-one",
      "EVIDENCE:truncated-tool-result",
      "EVIDENCE:large-pr-budget",
    ],
  },
];
