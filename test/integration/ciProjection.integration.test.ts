import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  applyAutomatedPullRequestIntake,
  applyCompletedRunCiIntake,
  applyCiStateIntake,
} from "../../src/agentWork/intake/applier.js";
import {
  enqueueCiProjectionIfDue,
  loadRenderableHeadCi,
} from "../../src/agentWork/ciProjection.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import { executeCiProjectionJob } from "../../src/agentWork/executors/ciProjectionExecutor.js";
import { listTerminalReviewsWithOpenOwnChecks } from "../../src/agentWork/lostRunningWork.js";
import { loadPrHeadCiState, storePrNumbersForHead } from "../../src/agentWork/prHeadCiState.js";
import { recordPublishStep, recordReviewCheckRun } from "../../src/agentWork/repository.js";
import type { QueueConfig, WebhookHeaders } from "../../src/agentWork/types.js";
import type { CiSummaryAuthor } from "../../src/review/ci/authorCiSummary.js";
import { hashCiFacts, parseCiAuthoredCache } from "../../src/review/ci/ciAuthoredCache.js";
import { observedAtFromGithub, type CiCheckFact } from "../../src/review/ci/classifySnapshot.js";
import type { CiCheckRunSnapshot } from "../../src/review/ci/ciSummaryTypes.js";
import { renderCiRollupMarker } from "../../src/review/ci/ciRollupMarker.js";
import { parseCiSummaryMarkerVersion } from "../../src/review/ci/ciSummaryCell.js";
import { renderCiSummaryCell } from "../../src/review/ci/renderCiSummary.js";
import { createFindingLedger } from "../../src/review/orchestrator/orchestratorTypes.js";
import { tickProgressComment } from "../../src/review/orchestrator/stubTick.js";
import { publishReviewSummaryOnly } from "../../src/review/publish/publishSummaryOnly.js";
import { makeReviewPayload } from "../helpers/reviewPayloadFactory.js";
import { upsertSummaryCommentWithCreationClaim } from "../../src/review/publish/summaryCommentUpsert.js";
import { renderReviewProgressComment } from "../../src/review/run/progressComment.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createOperationLogger } from "../../src/evlog.js";
import { createFakePrSurface } from "../../src/github/prSurface.js";
import {
  CI_PROJECTION_QUEUE,
  DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  DEFAULT_QUEUE_RETENTION_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  DEFAULT_QUEUE_RETRY_LIMIT,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  REVIEW_CI_SUMMARY_INCOMPLETE,
  REVIEW_SUMMARY_SENTINEL,
  TRIAGE_SUMMARY_SENTINEL,
} from "../../src/settings/index.js";
import { makeTestConfig } from "../helpers/config.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "ci-projection-it";
const REPO = "app";
const PR_NUMBER = 7;
const DATABASE_URL = process.env.DATABASE_URL!;
const cfg = makeTestConfig();

const queueConfig: QueueConfig = {
  queueRetryLimit: DEFAULT_QUEUE_RETRY_LIMIT,
  queueRetryDelaySeconds: DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  queueRetryDelayMaxSeconds: DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  queueExpireInSeconds: DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  queueHeartbeatSeconds: DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  queuePollingIntervalSeconds: DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  queueRetentionSeconds: DEFAULT_QUEUE_RETENTION_SECONDS,
  queueDeleteAfterSeconds: DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  installationGroupConcurrency: DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
};

function headers(event: string, delivery: string): WebhookHeaders {
  return {
    event,
    delivery,
    rawBody: Buffer.from(JSON.stringify({ action: "completed", delivery })),
  };
}

function intakeLog() {
  return createOperationLogger({ method: "POST", path: "/webhooks" });
}

async function deleteQueueJobs(boss: PgBoss, queue: string): Promise<void> {
  const jobs = await boss.findJobs(queue, {});
  if (jobs.length > 0) {
    await boss.deleteJob(
      queue,
      jobs.map((job) => job.id),
    );
  }
}

function ciStateFact(overrides: Partial<CiCheckFact> = {}): CiCheckFact {
  return {
    name: "lint",
    source: "check_run",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/o/r/runs/1",
    external_id: null,
    app_id: 9,
    check_run_id: 77,
    observed_at: "2026-09-13T00:00:02.000Z",
    ...overrides,
  };
}

function stubCiAuthor(calls: unknown[]): CiSummaryAuthor {
  return async (input) => {
    calls.push(input);
    return {
      headline: "❌ authored lint",
      failures: [{ name: "lint", reason: "oxfmt failed", fixHint: "run oxfmt" }],
    };
  };
}

function reviewCommentBody(
  headSha: string,
  version: number,
  workItemId: string,
  options?: { readonly actionPhrase?: string },
): string {
  const cell = renderCiSummaryCell(
    { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
    headSha,
    version,
  );
  const action =
    options?.actionPhrase == null
      ? []
      : [
          "> [!NOTE]",
          `> No findings, ready to merge. <!-- pr-agent:ci-action fmt=1 -->${options.actionPhrase}<!-- /pr-agent:ci-action -->. All specialists ran with full coverage.`,
          "",
        ];
  return [
    REVIEW_SUMMARY_SENTINEL,
    "",
    ...action,
    `<table><tr><td><strong>CI</strong></td><td>${cell}</td></tr></table>`,
    "",
    `<!-- pr-agent:review-meta headSha=${headSha} lens=review stale=false -->`,
    `<!-- pr-agent:progress-revision workItemId=${workItemId} value=1 -->`,
  ].join("\n");
}

function checkRunSnapshot(
  overrides: Partial<CiCheckRunSnapshot> & Pick<CiCheckRunSnapshot, "id" | "name">,
): CiCheckRunSnapshot {
  return {
    status: "completed",
    conclusion: "success",
    htmlUrl: null,
    outputTitle: null,
    outputSummary: null,
    outputText: null,
    ...overrides,
  };
}

function getCiStatusCount(events: readonly { readonly kind: string }[]): number {
  return events.filter((event) => event.kind === "getCiStatus").length;
}

describe.skipIf(!hasDatabase)("CI projection against real pg-boss (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM webhook_events WHERE event_name = ANY($1::text[])", [
      ["workflow_run", "check_run", "pull_request"],
    ]);
    boss = await createStartedBoss({ databaseUrl: DATABASE_URL, role: "web" });
    await ensureAgentQueues(boss, queueConfig);
    await deleteQueueJobs(boss, CI_PROJECTION_QUEUE);
  });

  afterAll(async () => {
    await stopBoss(boss, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS * 1000);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM webhook_events WHERE event_name = ANY($1::text[])", [
      ["workflow_run", "check_run", "pull_request"],
    ]);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM pr_head_ci_state WHERE owner = $1", [OWNER]);
    await deleteQueueJobs(boss, CI_PROJECTION_QUEUE);
  });

  async function insertSeededHead(
    headSha: string,
    checks: Record<string, CiCheckFact>,
    rollup: string,
    version: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version, seeded_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())`,
      [OWNER, REPO, headSha, JSON.stringify(checks), rollup, version],
    );
  }

  async function insertReviewWorkItem(headSha: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, attempt_count, payload
       )
       VALUES ($1, 'review', 'auto', 'running', $2, $3, $4, 9001, $5, 'review', $6, 0, '{}'::jsonb)`,
      [id, OWNER, REPO, PR_NUMBER, headSha, `${OWNER}/${REPO}#${PR_NUMBER}`],
    );
    return id;
  }

  async function webhookDecision(delivery: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ processing_decision: string }>(
      "SELECT processing_decision FROM webhook_events WHERE delivery_id = $1",
      [delivery],
    );
    return rows[0]?.processing_decision;
  }

  it("enqueues one projection from workflow_run intake", async () => {
    const delivery = `ci-run-${randomUUID().slice(0, 8)}`;
    const headSha = "abc123def456";

    await applyCompletedRunCiIntake(
      boss,
      pool,
      headers("workflow_run", delivery),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        prNumbers: [42],
      },
      intakeLog(),
    );

    const { rows: events } = await pool.query<{ processing_decision: string }>(
      "SELECT processing_decision FROM webhook_events WHERE event_name = $1 AND delivery_id = $2",
      ["workflow_run", delivery],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.processing_decision).toBe("ci_projection_enqueued");

    const jobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      kind: "ci_projection",
      owner: OWNER,
      repo: REPO,
      headSha,
    });
  });

  it("enqueues one projection when workflow_run has no PR numbers", async () => {
    const delivery = `ci-run-empty-${randomUUID().slice(0, 8)}`;
    const headSha = "deadbeef0123456789abcdef0123456789abcdef";

    await applyCompletedRunCiIntake(
      boss,
      pool,
      headers("workflow_run", delivery),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        prNumbers: [],
      },
      intakeLog(),
    );

    const jobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      kind: "ci_projection",
      owner: OWNER,
      repo: REPO,
      headSha,
    });
  });

  it("enqueues a projection from pull_request opened when the head is unseeded", async () => {
    const delivery = `ci-pr-open-${randomUUID().slice(0, 8)}`;
    const headSha = "11".repeat(20);

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("pull_request", delivery),
      {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        installationId: 9001,
        headSha,
      },
      "opened",
      intakeLog(),
      cfg,
    );

    const jobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      kind: "ci_projection",
      owner: OWNER,
      repo: REPO,
      headSha,
      webhookEventId: expect.any(String),
    });
    await expect(webhookDecision(delivery)).resolves.toBe("automated_review_enqueued");
  });

  it("does not enqueue a projection from pull_request opened when the head is already seeded", async () => {
    const delivery = `ci-pr-seeded-${randomUUID().slice(0, 8)}`;
    const headSha = "0e".repeat(20);
    await pool.query(
      `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version, seeded_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'none', 1, now())`,
      [OWNER, REPO, headSha],
    );

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("pull_request", delivery),
      {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        installationId: 9001,
        headSha,
      },
      "opened",
      intakeLog(),
      cfg,
    );

    await expect(boss.findJobs(CI_PROJECTION_QUEUE, {})).resolves.toHaveLength(0);
    await expect(webhookDecision(delivery)).resolves.toBe("automated_review_enqueued");
  });

  it("enqueues a projection from pull_request opened when review is manual and the head is unseeded", async () => {
    const delivery = `ci-pr-manual-${randomUUID().slice(0, 8)}`;
    const headSha = "55".repeat(20);
    const manualCfg = makeTestConfig({
      features: { ...cfg.features, review: "manual", describe: "off", verification: "off" },
    });

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("pull_request", delivery),
      {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        installationId: 9001,
        headSha,
      },
      "opened",
      intakeLog(),
      manualCfg,
    );

    const jobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      kind: "ci_projection",
      owner: OWNER,
      repo: REPO,
      headSha,
      webhookEventId: expect.any(String),
    });
    await expect(webhookDecision(delivery)).resolves.toBe("ci_projection_enqueued");
  });

  it("records ignored_pull_request_opened when review is manual and the head is already seeded", async () => {
    const delivery = `ci-pr-manual-seeded-${randomUUID().slice(0, 8)}`;
    const headSha = "66".repeat(20);
    const manualCfg = makeTestConfig({
      features: { ...cfg.features, review: "manual", describe: "off", verification: "off" },
    });
    await pool.query(
      `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version, seeded_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'none', 1, now())`,
      [OWNER, REPO, headSha],
    );

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("pull_request", delivery),
      {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        installationId: 9001,
        headSha,
      },
      "opened",
      intakeLog(),
      manualCfg,
    );

    await expect(boss.findJobs(CI_PROJECTION_QUEUE, {})).resolves.toHaveLength(0);
    await expect(webhookDecision(delivery)).resolves.toBe("ignored_pull_request_opened");
  });

  it("does not enqueue a projection from pull_request labeled", async () => {
    const delivery = `ci-pr-label-${randomUUID().slice(0, 8)}`;
    const headSha = "22".repeat(20);

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("pull_request", delivery),
      {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        installationId: 9001,
        headSha,
      },
      "labeled",
      intakeLog(),
      cfg,
    );

    await expect(boss.findJobs(CI_PROJECTION_QUEUE, {})).resolves.toHaveLength(0);
    await expect(webhookDecision(delivery)).resolves.toBe("ignored_pull_request_labeled");
  });

  it("enqueues a projection after a claim-time write when the head is unseeded", async () => {
    const headSha = "33".repeat(20);

    await enqueueCiProjectionIfDue({
      boss,
      pool,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
      renderedVersion: 0,
    });

    const jobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      kind: "ci_projection",
      owner: OWNER,
      repo: REPO,
      headSha,
    });
  });

  it("enqueues a projection after a claim-time write when the row exists and seeded_at is null", async () => {
    const headSha = "0f".repeat(20);
    await pool.query(
      `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version)
       VALUES ($1, $2, $3, '{}'::jsonb, 'none', 0)`,
      [OWNER, REPO, headSha],
    );

    await enqueueCiProjectionIfDue({
      boss,
      pool,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
      renderedVersion: 0,
    });

    const jobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      kind: "ci_projection",
      owner: OWNER,
      repo: REPO,
      headSha,
    });
  });

  it("does not enqueue after a claim-time write when the head is seeded and the version matches", async () => {
    const headSha = "44".repeat(20);
    await pool.query(
      `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version, seeded_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'none', 2, now())`,
      [OWNER, REPO, headSha],
    );

    await enqueueCiProjectionIfDue({
      boss,
      pool,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
      renderedVersion: 2,
    });

    await expect(boss.findJobs(CI_PROJECTION_QUEUE, {})).resolves.toHaveLength(0);
  });

  it("writes pr_head_ci_state and enqueues a debounced projection", async () => {
    const delivery = `ci-state-${randomUUID().slice(0, 8)}`;
    const headSha = "cafebabe0123456789abcdef0123456789abcdef";
    const fact = ciStateFact();

    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", delivery),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact,
      },
      intakeLog(),
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row).not.toBeNull();
    expect(row?.version).toBe(1);
    expect(row?.rollup).toBe("failing");
    expect(row?.checks.lint?.conclusion).toBe("failure");

    const { rows: events } = await pool.query<{ processing_decision: string }>(
      "SELECT processing_decision FROM webhook_events WHERE delivery_id = $1",
      [delivery],
    );
    expect(events[0]?.processing_decision).toBe("ci_state_applied");

    const jobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      kind: "ci_projection",
      owner: OWNER,
      repo: REPO,
      headSha,
    });
  });

  it("rejects an older observation and does not enqueue another projection", async () => {
    const headSha = "feedbeef0123456789abcdef0123456789abcdef";
    const newer = ciStateFact({
      conclusion: "failure",
      observed_at: "2026-09-13T00:00:05.000Z",
    });
    const older = ciStateFact({
      conclusion: "success",
      observed_at: "2026-09-13T00:00:01.000Z",
    });

    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-new-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: newer,
      },
      intakeLog(),
    );
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-old-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: older,
      },
      intakeLog(),
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.version).toBe(1);
    expect(row?.checks.lint?.conclusion).toBe("failure");
    await expect(boss.findJobs(CI_PROJECTION_QUEUE, {})).resolves.toHaveLength(1);
  });

  it("interleaves a tick and a projection and keeps the newest v", async () => {
    const headSha = "aa".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-tick-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: ciStateFact({
          conclusion: "failure",
          observed_at: "2026-09-13T00:00:10.000Z",
        }),
      },
      intakeLog(),
    );
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-tick2-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: ciStateFact({
          name: "test",
          check_run_id: 88,
          conclusion: "success",
          observed_at: "2026-09-13T00:00:11.000Z",
        }),
      },
      intakeLog(),
    );
    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.version).toBeGreaterThanOrEqual(2);

    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 1, workItemId),
      88,
    );

    const job = {
      kind: "ci_projection" as const,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
    };

    await Promise.all([
      tickProgressComment({
        pool,
        workItemId,
        resourceKey: `${OWNER}/${REPO}#${PR_NUMBER}`,
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        mode: "review",
        headSha,
        source: "auto",
        progressRevision: 2,
        prSurface: fake.surface,
        installationId: 9001,
        boss,
        tickState: {
          kind: "specialists",
          recon: "done",
          specialists: {
            correctness: { phase: "done", findingsAccepted: 0 },
            security: { phase: "running" },
            quality: { phase: "running" },
            tests: { phase: "running" },
          },
        },
      }),
      executeCiProjectionJob(cfg, pool, boss, job, {
        createSurface: async () => fake.surface,
        author: stubCiAuthor([]),
      }),
    ]);

    await executeCiProjectionJob(cfg, pool, boss, job, {
      createSurface: async () => fake.surface,
      author: stubCiAuthor([]),
    });

    const latest = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    const projected = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(latest).not.toBeNull();
    expect(parseCiSummaryMarkerVersion(latest?.body ?? "")).toBe(projected?.version);
    expect(latest?.body).toContain(`v=${projected?.version}`);
    expect(latest?.body).toContain(`head=${headSha}`);
  });

  it("authors a failing rollup once per facts hash and does not bump version", async () => {
    const headSha = "cc".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-author-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: ciStateFact({
          observed_at: "2026-09-13T00:00:20.000Z",
        }),
      },
      intakeLog(),
    );
    const afterIntake = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterIntake?.version).toBe(1);
    expect(afterIntake?.rollup).toBe("failing");
    expect(parseCiAuthoredCache(afterIntake?.authored)).toBeNull();

    const calls: unknown[] = [];
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 0, workItemId),
      91,
    );
    fake.controls.setJobLogs(
      77,
      ["Format issues found in above 1 files.", "Error: Process completed with exit code 1."].join(
        "\n",
      ),
    );

    const job = {
      kind: "ci_projection" as const,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
    };
    const options = {
      createSurface: async () => fake.surface,
      author: stubCiAuthor(calls),
    };

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    expect(calls).toHaveLength(1);
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
    const afterFirst = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    // Fact write was v=1; first seed advances once more. Authored cache must not bump again.
    expect(afterFirst?.version).toBe(2);
    expect(afterFirst?.seededAt).not.toBeNull();
    const authored = parseCiAuthoredCache(afterFirst?.authored);
    expect(authored?.headline).toBe("❌ authored lint");
    expect(authored?.factsHash).toBe(hashCiFacts(afterFirst?.checks ?? {}));

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    expect(calls).toHaveLength(1);
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
    const afterSecond = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterSecond?.version).toBe(2);
    expect(parseCiAuthoredCache(afterSecond?.authored)?.factsHash).toBe(authored?.factsHash);

    const latest = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(latest?.body).toContain("authored lint");
    expect(latest?.body).toContain("v=2");
  });

  it("patches a triage rollup marker after a push whose work-item head is older", async () => {
    const oldHead = "11".repeat(20);
    const newHead = "22".repeat(20);
    await insertReviewWorkItem(oldHead);
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-triage-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha: newHead,
        fact: ciStateFact({
          observed_at: "2026-09-13T00:00:30.000Z",
        }),
      },
      intakeLog(),
    );
    const row = await loadPrHeadCiState(pool, OWNER, REPO, newHead);
    expect(row?.rollup).toBe("failing");
    expect(row?.version).toBe(1);

    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(newHead, [{ number: PR_NUMBER }]);
    fake.controls.setProgressComment(
      TRIAGE_SUMMARY_SENTINEL,
      [
        TRIAGE_SUMMARY_SENTINEL,
        "",
        "Full PR triage.",
        `Evaluated head: \`${oldHead}\``,
        "",
        `CI: ${renderCiRollupMarker(newHead, 0, "none")}`,
      ].join("\n"),
      92,
    );

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha: newHead,
      },
      {
        createSurface: async () => fake.surface,
        author: stubCiAuthor([]),
      },
    );

    const seeded = await loadPrHeadCiState(pool, OWNER, REPO, newHead);
    const latest = fake.controls.getProgressComment(TRIAGE_SUMMARY_SENTINEL);
    expect(latest?.body).toContain(renderCiRollupMarker(newHead, seeded?.version ?? 0, "failing"));
    expect(latest?.body).not.toContain(renderCiRollupMarker(newHead, 0, "none"));
  });

  it("keeps an older-head cell when a later head is published and projected", async () => {
    const resourceKey = `${OWNER}/${REPO}#${PR_NUMBER}`;
    const headA = "33".repeat(20);
    const headB = "44".repeat(20);
    const workA = await insertReviewWorkItem(headA);
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-e2e-a-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha: headA,
        fact: ciStateFact({
          name: "lint-a",
          check_run_id: 201,
          observed_at: "2026-09-13T00:01:00.000Z",
        }),
      },
      intakeLog(),
    );

    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headA, [{ number: PR_NUMBER }]);
    fake.controls.setPullsForHead(headB, [{ number: PR_NUMBER }]);

    const postAckStub = async (workItemId: string, headSha: string) => {
      const rendered = await loadRenderableHeadCi(pool, OWNER, REPO, headSha);
      const body = renderReviewProgressComment({
        mode: "review",
        headSha,
        source: "auto",
        ciSummary: rendered.summary,
        ciVersion: rendered.version,
        progressRevision: 0,
        progressWorkItemId: workItemId,
      });
      await upsertSummaryCommentWithCreationClaim({
        pool,
        workItemId,
        resourceKey,
        reviewLens: "review",
        prSurface: fake.surface,
        body,
        sentinel: REVIEW_SUMMARY_SENTINEL,
        progressRevision: 0,
        ciHeadSha: headSha,
        ciVersion: rendered.version,
      });
    };
    const tickReview = async (workItemId: string, headSha: string) => {
      await tickProgressComment({
        pool,
        workItemId,
        resourceKey,
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        mode: "review",
        headSha,
        source: "auto",
        progressRevision: 2,
        prSurface: fake.surface,
        installationId: 9001,
        boss,
        tickState: {
          kind: "specialists",
          recon: "done",
          specialists: {
            correctness: { phase: "done", findingsAccepted: 0 },
            security: { phase: "running" },
            quality: { phase: "running" },
            tests: { phase: "running" },
          },
        },
      });
    };
    const publishReview = async (workItemId: string, headSha: string) => {
      const result = await publishReviewSummaryOnly({
        cfg,
        ctx: {
          owner: OWNER,
          repo: REPO,
          prNumber: PR_NUMBER,
          headSha,
          hasDescriptionReviewMap: false,
        },
        prSurface: fake.surface,
        payload: makeReviewPayload({ size: "XS" }),
        ledger: createFindingLedger(),
        pool,
        workItemId,
        resourceKey,
        boss,
        installationId: 9001,
      });
      expect(result.kind).toBe("published");
    };
    const projectHead = async (headSha: string) => {
      await executeCiProjectionJob(
        cfg,
        pool,
        boss,
        {
          kind: "ci_projection",
          installationId: 9001,
          owner: OWNER,
          repo: REPO,
          headSha,
        },
        {
          createSurface: async () => fake.surface,
          author: stubCiAuthor([]),
        },
      );
    };

    await postAckStub(workA, headA);
    await tickReview(workA, headA);
    await publishReview(workA, headA);
    await pool.query(
      `UPDATE agent_work_items
          SET status = 'completed', completed_at = now()
        WHERE id = $1`,
      [workA],
    );
    const afterHeadA = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(afterHeadA?.body).toContain(`head=${headA}`);

    const workB = await insertReviewWorkItem(headB);
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-e2e-b-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha: headB,
        fact: ciStateFact({
          name: "lint-b",
          check_run_id: 202,
          observed_at: "2026-09-13T00:02:00.000Z",
        }),
      },
      intakeLog(),
    );
    await applyCompletedRunCiIntake(
      boss,
      pool,
      headers("workflow_run", `ci-e2e-b-run-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha: headB,
        prNumbers: [PR_NUMBER],
      },
      intakeLog(),
    );

    await postAckStub(workB, headB);
    await tickReview(workB, headB);
    await publishReview(workB, headB);
    const afterHeadB = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(afterHeadB?.body).toContain(`head=${headB}`);
    expect(afterHeadB?.body).not.toContain(`head=${headA}`);

    await pool.query(
      `UPDATE pr_head_ci_state
          SET projection_repair_pending = true
        WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
      [OWNER, REPO, headA],
    );
    await projectHead(headA);
    const afterOldProjection = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(afterOldProjection?.body).toContain(`head=${headB}`);
    expect(afterOldProjection?.body).not.toContain(`head=${headA}`);
    const repairedOldHead = await loadPrHeadCiState(pool, OWNER, REPO, headA);
    expect(repairedOldHead?.projectionRepairPending).toBe(false);

    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-e2e-b2-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha: headB,
        fact: ciStateFact({
          name: "test-b",
          check_run_id: 203,
          conclusion: "success",
          observed_at: "2026-09-13T00:03:00.000Z",
        }),
      },
      intakeLog(),
    );
    const rowB = await loadPrHeadCiState(pool, OWNER, REPO, headB);
    expect(rowB?.version).toBeGreaterThanOrEqual(2);

    await projectHead(headB);
    const projectedB = await loadPrHeadCiState(pool, OWNER, REPO, headB);
    const afterNewProjection = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(afterNewProjection?.body).toContain(`head=${headB}`);
    expect(parseCiSummaryMarkerVersion(afterNewProjection?.body ?? "")).toBe(projectedB?.version);
    expect(afterNewProjection?.body).toContain(`v=${projectedB?.version}`);
  });

  it("renders an incomplete seed as unavailable on the cell and the rollup", async () => {
    const headSha = "55".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        {
          id: 1,
          name: "lint",
          status: "completed",
          conclusion: "success",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      checkRunsComplete: false,
      legacyStatuses: [],
    });
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 0, workItemId),
      55,
    );
    fake.controls.setProgressComment(
      TRIAGE_SUMMARY_SENTINEL,
      [
        TRIAGE_SUMMARY_SENTINEL,
        "",
        "Full PR triage.",
        "",
        `CI: ${renderCiRollupMarker(headSha, 0, "none")}`,
      ].join("\n"),
      56,
    );

    const job = {
      kind: "ci_projection" as const,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
    };
    const options = { createSurface: async () => fake.surface, author: stubCiAuthor([]) };

    await executeCiProjectionJob(cfg, pool, boss, job, options);

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.rollup).toBe("unknown");
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
    const review = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(review?.body).toContain(REVIEW_CI_SUMMARY_INCOMPLETE);
    expect(review?.body).not.toContain("<!-- pr-agent:ci-rollup");
    expect(review?.body).not.toMatch(/All CI is passing/i);
    const triage = fake.controls.getProgressComment(TRIAGE_SUMMARY_SENTINEL);
    expect(triage?.body).toContain(renderCiRollupMarker(headSha, row?.version ?? 0, "unknown"));

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    expect(getCiStatusCount(fake.controls.events)).toBe(2);
    const afterSecond = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterSecond?.rollup).toBe("unknown");
  });

  it("projects a second PR after the stored list already held the first", async () => {
    const headSha = "66".repeat(20);
    const secondPr = 8;
    const firstWork = await insertReviewWorkItem(headSha);
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-prs-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: ciStateFact({
          observed_at: "2026-09-13T00:04:00.000Z",
        }),
      },
      intakeLog(),
    );
    await storePrNumbersForHead(pool, OWNER, REPO, headSha, [PR_NUMBER]);

    const fakeFirst = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    const fakeSecond = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: secondPr });
    fakeFirst.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }, { number: secondPr }]);
    fakeSecond.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }, { number: secondPr }]);
    fakeFirst.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 0, firstWork),
      66,
    );
    fakeSecond.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 0, firstWork),
      67,
    );

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      {
        createSurface: async (prNumber) =>
          prNumber === secondPr ? fakeSecond.surface : fakeFirst.surface,
        author: stubCiAuthor([]),
      },
    );

    const stored = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(stored?.prNumbers).toEqual(expect.arrayContaining([PR_NUMBER, secondPr]));
    expect(fakeFirst.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body).toContain(
      `v=${stored?.version}`,
    );
    expect(fakeSecond.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body).toContain(
      `v=${stored?.version}`,
    );
  });

  it("closes a started check after the review fails", async () => {
    const headSha = "77".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    await pool.query(
      `UPDATE agent_work_items SET status = 'failed', completed_at = now() WHERE id = $1`,
      [workItemId],
    );
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-started-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: ciStateFact({
          observed_at: "2026-09-13T00:05:00.000Z",
        }),
      },
      intakeLog(),
    );
    await recordReviewCheckRun(pool, {
      workItemId,
      resourceKey: `${OWNER}/${REPO}#${PR_NUMBER}`,
      reviewLens: "review",
      githubId: 11,
      detail: { status: "in_progress", headSha, name: "PR Agent Review" },
    });
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    expect(fake.controls.events).toContainEqual(
      expect.objectContaining({ kind: "finishReviewCheck", conclusion: "action_required" }),
    );
    const { rows } = await pool.query<{ detail: { status?: string; conclusion?: string } }>(
      `SELECT detail FROM publish_records
        WHERE work_item_id = $1 AND step = 'check_run'`,
      [workItemId],
    );
    expect(rows[0]?.detail.status).toBe("completed");
    expect(rows[0]?.detail.conclusion).toBe("action_required");
  });

  it("does not close a published review as unpublished", async () => {
    const headSha = "88".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    await pool.query(
      `UPDATE agent_work_items SET status = 'completed', completed_at = now() WHERE id = $1`,
      [workItemId],
    );
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-state-published-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: ciStateFact({
          observed_at: "2026-09-13T00:06:00.000Z",
        }),
      },
      intakeLog(),
    );
    const resourceKey = `${OWNER}/${REPO}#${PR_NUMBER}`;
    await recordReviewCheckRun(pool, {
      workItemId,
      resourceKey,
      reviewLens: "review",
      githubId: 22,
      detail: { status: "in_progress", headSha, name: "PR Agent Review" },
    });
    await recordPublishStep(pool, {
      workItemId,
      resourceKey,
      reviewLens: "review",
      step: "summary_comment",
      githubId: 99,
      leaseEpoch: null,
      detail: { ownVerdictKind: "published", ownCheckFailing: true },
    });
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    expect(fake.controls.events).toContainEqual(
      expect.objectContaining({ kind: "finishReviewCheck", conclusion: "failure" }),
    );
    const { rows } = await pool.query<{ detail: { status?: string; conclusion?: string } }>(
      `SELECT detail FROM publish_records
        WHERE work_item_id = $1 AND step = 'check_run'`,
      [workItemId],
    );
    expect(rows[0]?.detail.status).toBe("completed");
    expect(rows[0]?.detail.conclusion).toBe("failure");
    expect(rows[0]?.detail.conclusion).not.toBe("action_required");
  });

  it("seeds after a failed first getCiStatus once the row exists", async () => {
    const headSha = "99".repeat(20);
    await insertReviewWorkItem(headSha);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatusError(new Error("github unavailable"));

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const afterFail = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterFail?.seededAt).toBeNull();
    expect(afterFail?.version).toBe(0);
    const afterFailJobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(afterFailJobs.map((job) => job.data)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ headSha })]),
    );

    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        {
          id: 7,
          name: "lint",
          status: "completed",
          conclusion: "success",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      checkRunsComplete: true,
      legacyStatuses: [],
    });

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const afterSeed = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterSeed?.seededAt).not.toBeNull();
    expect(afterSeed?.rollup).toBe("passing");
    expect(afterSeed?.version).toBe(1);
  });

  it("seeds an empty head as none, advances version, and repairs waiting comments", async () => {
    const headSha = "bb".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [],
      checkRunsComplete: true,
      legacyStatuses: [],
    });
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      [
        REVIEW_SUMMARY_SENTINEL,
        "",
        "> [!NOTE]",
        "> No findings, ready to merge. CI is pending. All specialists ran with full coverage.",
        "",
        `<table><tr><td><strong>CI</strong></td><td>${renderCiSummaryCell(
          { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
          headSha,
          0,
        )}</td></tr></table>`,
        "",
        `<!-- pr-agent:review-meta headSha=${headSha} lens=review stale=false -->`,
        `<!-- pr-agent:progress-revision workItemId=${workItemId} value=1 -->`,
      ].join("\n"),
      501,
    );

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.seededAt).not.toBeNull();
    expect(row?.rollup).toBe("none");
    expect(row?.version).toBe(1);
    const claim = await loadRenderableHeadCi(pool, OWNER, REPO, headSha);
    expect(claim.summary.status).toBe("none");
    expect(claim.summary.headline).toBe("No CI checks on this head");

    const latest = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(latest?.body).toContain("No CI checks on this head");
    expect(latest?.body).toContain("No CI checks ran on this head");
    expect(latest?.body).not.toContain("Waiting for CI");
    expect(latest?.body).not.toContain("CI is pending");
    expect(parseCiSummaryMarkerVersion(latest?.body ?? "")).toBe(1);

    const again = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );
    const afterRepeat = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterRepeat?.version).toBe(again?.version);
  });

  it("advances version on first seed even when pre-seed facts are identical", async () => {
    const headSha = "cc".repeat(20);
    await insertReviewWorkItem(headSha);
    await applyCiStateIntake(
      boss,
      pool,
      headers("check_run", `ci-preseed-${randomUUID().slice(0, 8)}`),
      {
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
        fact: ciStateFact({
          name: "lint",
          conclusion: "success",
          observed_at: "2026-09-13T00:00:01.000Z",
        }),
      },
      intakeLog(),
    );
    const before = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(before?.seededAt).toBeNull();
    expect(before?.version).toBe(1);

    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        {
          id: 9,
          name: "lint",
          status: "completed",
          conclusion: "success",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      checkRunsComplete: true,
      legacyStatuses: [],
    });

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const after = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(after?.seededAt).not.toBeNull();
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it("bumps projection revision when verification activates or clears", async () => {
    const headSha = "dd".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    await pool.query(
      `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version, seeded_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'none', 2, now())`,
      [OWNER, REPO, headSha],
    );
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 2, workItemId),
      601,
    );

    const { publishVerificationFailure, clearVerificationFailureSignal } =
      await import("../../src/agent/verification/publishVerificationFailure.js");
    await publishVerificationFailure({
      pool,
      workItemId,
      resourceKey: `${OWNER}/${REPO}#${PR_NUMBER}`,
      prSurface: fake.surface,
      headSha,
      leaseEpoch: null,
      boss,
      installationId: 9001,
    });
    const afterActivate = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterActivate?.version).toBe(3);

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );
    const withFailure = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(withFailure?.body).toContain("Verification did not complete");

    await publishVerificationFailure({
      pool,
      workItemId,
      resourceKey: `${OWNER}/${REPO}#${PR_NUMBER}`,
      prSurface: fake.surface,
      headSha,
      leaseEpoch: null,
      boss,
      installationId: 9001,
    });
    const afterDuplicate = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterDuplicate?.version).toBe(3);

    await clearVerificationFailureSignal({
      pool,
      workItemId,
      resourceKey: `${OWNER}/${REPO}#${PR_NUMBER}`,
      prSurface: fake.surface,
      headSha,
      leaseEpoch: null,
      boss,
      installationId: 9001,
    });
    const afterClear = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterClear?.version).toBe(4);

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );
    const cleared = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(cleared?.body).not.toContain("Verification did not complete");
  });

  it("keeps projection_repair_pending when a comment edit fails, then clears after success", async () => {
    const headSha = "ee".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    await pool.query(
      `INSERT INTO pr_head_ci_state
         (owner, repo, head_sha, checks, rollup, version, seeded_at, projection_repair_pending)
       VALUES ($1, $2, $3, '{}'::jsonb, 'none', 1, now(), true)`,
      [OWNER, REPO, headSha],
    );
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      [
        REVIEW_SUMMARY_SENTINEL,
        "",
        "> [!NOTE]",
        "> No findings, ready to merge. CI is pending. All specialists ran with full coverage.",
        "",
        `<table><tr><td><strong>CI</strong></td><td><!-- pr-agent:ci-summary head=${headSha} v=1 -->⏳ Waiting for CI<!-- /pr-agent:ci-summary --></td></tr></table>`,
        "",
        `<!-- pr-agent:review-meta headSha=${headSha} lens=review stale=false -->`,
        `<!-- pr-agent:progress-revision workItemId=${workItemId} value=1 -->`,
      ].join("\n"),
      701,
    );

    let failEdit = true;
    const surface = {
      ...fake.surface,
      editComment: async (commentId: number, body: string) => {
        if (failEdit) throw new Error("github edit failed");
        return fake.surface.editComment(commentId, body);
      },
    };

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => surface, author: stubCiAuthor([]) },
    );
    const stillPending = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(stillPending?.projectionRepairPending).toBe(true);

    failEdit = false;
    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => surface, author: stubCiAuthor([]) },
    );
    const cleared = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(cleared?.projectionRepairPending).toBe(false);
    const body = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body ?? "";
    expect(body).toContain("No CI checks on this head");
    expect(body).toContain(`fmt=`);
  });

  it("lists a failed review whose recorded check is still open", async () => {
    const headSha = "aa".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    await pool.query(
      `UPDATE agent_work_items SET status = 'failed', completed_at = now() WHERE id = $1`,
      [workItemId],
    );
    await recordReviewCheckRun(pool, {
      workItemId,
      resourceKey: `${OWNER}/${REPO}#${PR_NUMBER}`,
      reviewLens: "review",
      githubId: 33,
      detail: { status: "in_progress", headSha, name: "PR Agent Review" },
    });

    const open = await listTerminalReviewsWithOpenOwnChecks(pool);
    expect(open.map((item) => item.workItemId)).toContain(workItemId);
  });

  it("pending-refreshes a sticky pending webhook fact to passing from a completed snapshot", async () => {
    const headSha = "f1".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    const pending = ciStateFact({
      name: "GitGuardian",
      status: "in_progress",
      conclusion: null,
      check_run_id: 105778514181,
      observed_at: "2026-09-13T00:00:02.000Z",
    });
    await insertSeededHead(headSha, { GitGuardian: pending }, "pending", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    const startedAt = "2026-09-13T00:00:01.000Z";
    const completedAt = "2026-09-13T00:00:10.000Z";
    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        checkRunSnapshot({
          id: 105778514181,
          name: "GitGuardian",
          startedAt,
          completedAt,
        }),
      ],
      checkRunsComplete: true,
      legacyStatuses: [],
    });
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 1, workItemId, { actionPhrase: "CI is pending" }),
      801,
    );

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.rollup).toBe("passing");
    expect(row?.version).toBe(2);
    expect(row?.checks.GitGuardian?.status).toBe("completed");
    expect(row?.checks.GitGuardian?.conclusion).toBe("success");
    expect(row?.checks.GitGuardian?.observed_at).toBe(observedAtFromGithub(completedAt, startedAt));
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
    const body = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body ?? "";
    expect(body).not.toMatch(/CI is pending/i);
    expect(body).not.toMatch(/CI still running/i);
    expect(body).not.toContain("Waiting for CI");
    expect(body).toContain("CI is passing");
  });

  it("pending-refreshes a new failing check while completing a pending fact", async () => {
    const headSha = "f2".repeat(20);
    await insertReviewWorkItem(headSha);
    const pendingA = ciStateFact({
      name: "lint",
      status: "in_progress",
      conclusion: null,
      check_run_id: 11,
      observed_at: "2026-09-13T00:00:02.000Z",
    });
    await insertSeededHead(headSha, { lint: pendingA }, "pending", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        checkRunSnapshot({
          id: 11,
          name: "lint",
          startedAt: "2026-09-13T00:00:01.000Z",
          completedAt: "2026-09-13T00:00:10.000Z",
        }),
        checkRunSnapshot({
          id: 12,
          name: "test",
          conclusion: "failure",
          startedAt: "2026-09-13T00:00:01.000Z",
          completedAt: "2026-09-13T00:00:11.000Z",
        }),
      ],
      checkRunsComplete: true,
      legacyStatuses: [],
    });

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.checks.lint?.status).toBe("completed");
    expect(row?.checks.test?.conclusion).toBe("failure");
    expect(row?.rollup).toBe("failing");
    expect(row?.version).toBe(2);
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
  });

  it("keeps an identical pending snapshot revision-neutral and stops listing after terminal", async () => {
    const headSha = "f3".repeat(20);
    await insertReviewWorkItem(headSha);
    const pending = ciStateFact({
      name: "lint",
      status: "in_progress",
      conclusion: null,
      check_run_id: 21,
      observed_at: "2026-09-13T00:00:02.000Z",
    });
    await insertSeededHead(headSha, { lint: pending }, "pending", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    const pendingSnapshot = {
      checkRuns: [
        checkRunSnapshot({
          id: 21,
          name: "lint",
          status: "in_progress",
          conclusion: null,
          startedAt: "2026-09-13T00:00:05.000Z",
        }),
      ],
      checkRunsComplete: true,
      legacyStatuses: [],
    };
    fake.controls.setCiStatus(headSha, pendingSnapshot);
    const job = {
      kind: "ci_projection" as const,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
    };
    const options = { createSurface: async () => fake.surface, author: stubCiAuthor([]) };

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    const afterFirst = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterFirst?.version).toBe(1);
    expect(afterFirst?.rollup).toBe("pending");
    expect(getCiStatusCount(fake.controls.events)).toBe(1);

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    const afterSecond = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterSecond?.version).toBe(1);
    expect(afterSecond?.rollup).toBe("pending");
    expect(getCiStatusCount(fake.controls.events)).toBe(2);

    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        checkRunSnapshot({
          id: 21,
          name: "lint",
          startedAt: "2026-09-13T00:00:05.000Z",
          completedAt: "2026-09-13T00:00:20.000Z",
        }),
      ],
      checkRunsComplete: true,
      legacyStatuses: [],
    });
    await executeCiProjectionJob(cfg, pool, boss, job, options);
    const afterComplete = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterComplete?.rollup).toBe("passing");
    expect(afterComplete?.version).toBe(2);
    expect(getCiStatusCount(fake.controls.events)).toBe(3);

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    const afterTerminal = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterTerminal?.version).toBe(2);
    expect(getCiStatusCount(fake.controls.events)).toBe(3);
  });

  it("skips a cross-source same name and excludes the own check from pending refresh", async () => {
    const headSha = "f4".repeat(20);
    await insertReviewWorkItem(headSha);
    const pending = ciStateFact({
      name: "lint",
      status: "in_progress",
      conclusion: null,
      check_run_id: 31,
      observed_at: "2026-09-13T00:00:02.000Z",
    });
    await insertSeededHead(headSha, { lint: pending }, "pending", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        checkRunSnapshot({
          id: 99,
          name: "PR Agent Review",
          appId: Number(cfg.githubAppId),
          startedAt: "2026-09-13T00:00:01.000Z",
          completedAt: "2026-09-13T00:00:10.000Z",
        }),
      ],
      checkRunsComplete: true,
      legacyStatuses: [
        {
          context: "lint",
          state: "success",
          description: null,
          targetUrl: null,
        },
        {
          context: "pr-agent/review",
          state: "success",
          description: null,
          targetUrl: null,
        },
      ],
    });

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.version).toBe(1);
    expect(row?.checks.lint?.source).toBe("check_run");
    expect(row?.checks.lint?.status).toBe("in_progress");
    expect(row?.checks["PR Agent Review"]).toBeUndefined();
    expect(row?.checks["pr-agent/review"]).toBeUndefined();
    expect(row?.rollup).toBe("pending");
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
  });

  it("keeps an incomplete pending-refresh snapshot unknown and still lists later", async () => {
    const headSha = "f5".repeat(20);
    await insertReviewWorkItem(headSha);
    const pending = ciStateFact({
      name: "lint",
      status: "in_progress",
      conclusion: null,
      check_run_id: 41,
      observed_at: "2026-09-13T00:00:02.000Z",
    });
    await insertSeededHead(headSha, { lint: pending }, "pending", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        checkRunSnapshot({
          id: 41,
          name: "lint",
          startedAt: "2026-09-13T00:00:01.000Z",
          completedAt: "2026-09-13T00:00:10.000Z",
        }),
      ],
      checkRunsComplete: false,
      legacyStatuses: [],
    });
    const job = {
      kind: "ci_projection" as const,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
    };
    const options = { createSurface: async () => fake.surface, author: stubCiAuthor([]) };

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    const afterFirst = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterFirst?.checks.lint?.status).toBe("completed");
    expect(afterFirst?.rollup).toBe("unknown");
    expect(getCiStatusCount(fake.controls.events)).toBe(1);

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    expect(getCiStatusCount(fake.controls.events)).toBe(2);
    const afterSecond = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterSecond?.rollup).toBe("unknown");
    expect(afterSecond?.version).toBe(afterFirst?.version);
  });

  it("persists a complete listing that only lifts unknown rollup to none", async () => {
    const headSha = "fa".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    await insertSeededHead(headSha, {}, "unknown", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [],
      checkRunsComplete: true,
      legacyStatuses: [],
    });
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 1, workItemId),
      91,
    );
    const job = {
      kind: "ci_projection" as const,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
    };
    const options = { createSurface: async () => fake.surface, author: stubCiAuthor([]) };

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    const afterFirst = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterFirst?.rollup).toBe("none");
    expect(afterFirst?.version).toBe(2);
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
    const review = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(review?.body).toContain("No CI checks on this head");

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
    const afterSecond = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterSecond?.rollup).toBe("none");
    expect(afterSecond?.version).toBe(2);
  });

  it("leaves the row unchanged and re-enqueues when pending-refresh getCiStatus throws", async () => {
    const headSha = "f6".repeat(20);
    const workItemId = await insertReviewWorkItem(headSha);
    const pending = ciStateFact({
      name: "lint",
      status: "in_progress",
      conclusion: null,
      check_run_id: 51,
      observed_at: "2026-09-13T00:00:02.000Z",
    });
    await insertSeededHead(headSha, { lint: pending }, "pending", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatusError(new Error("github unavailable"));
    fake.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewCommentBody(headSha, 1, workItemId, { actionPhrase: "CI is pending" }),
      806,
    );

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.version).toBe(1);
    expect(row?.rollup).toBe("pending");
    expect(row?.checks.lint?.status).toBe("in_progress");
    const body = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body ?? "";
    expect(body).toContain("<!-- pr-agent:ci-summary");
    expect(body).toContain("CI is pending");
    const jobs = await boss.findJobs(CI_PROJECTION_QUEUE, {});
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.map((job) => job.data)).toEqual(
      expect.arrayContaining([expect.objectContaining({ headSha })]),
    );
  });

  it("rejects a snapshot older than a concurrent terminal webhook observation", async () => {
    const headSha = "f7".repeat(20);
    await insertReviewWorkItem(headSha);
    const pending = ciStateFact({
      name: "lint",
      status: "in_progress",
      conclusion: null,
      check_run_id: 61,
      observed_at: "2026-09-13T00:00:02.000Z",
    });
    await insertSeededHead(headSha, { lint: pending }, "pending", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    const terminal = ciStateFact({
      name: "lint",
      status: "completed",
      conclusion: "success",
      check_run_id: 61,
      observed_at: "2026-09-13T00:00:30.000Z",
    });
    const surface = {
      ...fake.surface,
      getCiStatus: async () => {
        await pool.query(
          `UPDATE pr_head_ci_state
              SET checks = $4::jsonb,
                  rollup = 'passing'
            WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
          [OWNER, REPO, headSha, JSON.stringify({ lint: terminal })],
        );
        return {
          checkRuns: [
            checkRunSnapshot({
              id: 61,
              name: "lint",
              startedAt: "2026-09-13T00:00:01.000Z",
              completedAt: "2026-09-13T00:00:10.000Z",
            }),
          ],
          checkRunsComplete: true,
          legacyStatuses: [],
        };
      },
    };

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => surface, author: stubCiAuthor([]) },
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.version).toBe(1);
    expect(row?.checks.lint?.status).toBe("completed");
    expect(row?.checks.lint?.observed_at).toBe("2026-09-13T00:00:30.000Z");
    expect(row?.rollup).toBe("passing");
  });

  it("keeps names absent from a pending-refresh snapshot", async () => {
    const headSha = "f8".repeat(20);
    await insertReviewWorkItem(headSha);
    const pending = ciStateFact({
      name: "lint",
      status: "in_progress",
      conclusion: null,
      check_run_id: 71,
      observed_at: "2026-09-13T00:00:02.000Z",
    });
    const keeper = ciStateFact({
      name: "keeper",
      status: "completed",
      conclusion: "success",
      check_run_id: 72,
      observed_at: "2026-09-13T00:00:01.000Z",
    });
    await insertSeededHead(headSha, { lint: pending, keeper }, "pending", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [
        checkRunSnapshot({
          id: 71,
          name: "lint",
          startedAt: "2026-09-13T00:00:01.000Z",
          completedAt: "2026-09-13T00:00:10.000Z",
        }),
      ],
      checkRunsComplete: true,
      legacyStatuses: [],
    });

    await executeCiProjectionJob(
      cfg,
      pool,
      boss,
      {
        kind: "ci_projection",
        installationId: 9001,
        owner: OWNER,
        repo: REPO,
        headSha,
      },
      { createSurface: async () => fake.surface, author: stubCiAuthor([]) },
    );

    const row = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(row?.checks.lint?.status).toBe("completed");
    expect(row?.checks.keeper?.conclusion).toBe("success");
    expect(row?.checks.keeper?.observed_at).toBe("2026-09-13T00:00:01.000Z");
    expect(row?.version).toBe(2);
    expect(getCiStatusCount(fake.controls.events)).toBe(1);
  });

  it("does not list GitHub again for a seeded none head", async () => {
    const headSha = "f9".repeat(20);
    await insertReviewWorkItem(headSha);
    await insertSeededHead(headSha, {}, "none", 1);
    const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
    fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
    fake.controls.setCiStatus(headSha, {
      checkRuns: [checkRunSnapshot({ id: 81, name: "late" })],
      checkRunsComplete: true,
      legacyStatuses: [],
    });
    const job = {
      kind: "ci_projection" as const,
      installationId: 9001,
      owner: OWNER,
      repo: REPO,
      headSha,
    };
    const options = { createSurface: async () => fake.surface, author: stubCiAuthor([]) };

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    expect(getCiStatusCount(fake.controls.events)).toBe(0);
    const afterFirst = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterFirst?.rollup).toBe("none");
    expect(afterFirst?.version).toBe(1);

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    expect(getCiStatusCount(fake.controls.events)).toBe(0);
    const afterSecond = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterSecond?.version).toBe(1);
    expect(afterSecond?.checks.late).toBeUndefined();
  });
});
