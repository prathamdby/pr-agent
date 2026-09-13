import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  applyCompletedRunCiIntake,
  applyCiStateIntake,
} from "../../src/agentWork/intake/applier.js";
import { loadRenderableHeadCi } from "../../src/agentWork/ciProjection.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import { executeCiProjectionJob } from "../../src/agentWork/executors/ciProjectionExecutor.js";
import { loadPrHeadCiState } from "../../src/agentWork/prHeadCiState.js";
import type { QueueConfig, WebhookHeaders } from "../../src/agentWork/types.js";
import type { CiSummaryAuthor } from "../../src/review/ci/authorCiSummary.js";
import { hashCiFacts, parseCiAuthoredCache } from "../../src/review/ci/ciAuthoredCache.js";
import type { CiCheckFact } from "../../src/review/ci/classifySnapshot.js";
import { renderCiRollupMarker } from "../../src/review/ci/ciRollupMarker.js";
import { parseCiSummaryMarkerVersion } from "../../src/review/ci/ciSummaryCell.js";
import { renderCiSummaryCell } from "../../src/review/ci/renderCiSummary.js";
import { createFindingLedger } from "../../src/review/orchestrator/orchestratorTypes.js";
import { tickProgressComment } from "../../src/review/orchestrator/stubTick.js";
import { publishReviewSummaryOnly } from "../../src/review/publish/publishSummaryOnly.js";
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

function reviewCommentBody(headSha: string, version: number, workItemId: string): string {
  const cell = renderCiSummaryCell(
    { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
    headSha,
    version,
  );
  return [
    REVIEW_SUMMARY_SENTINEL,
    "",
    `<table><tr><td><strong>CI</strong></td><td>${cell}</td></tr></table>`,
    "",
    `<!-- pr-agent:review-meta headSha=${headSha} lens=review stale=false -->`,
    `<!-- pr-agent:progress-revision workItemId=${workItemId} value=1 -->`,
  ].join("\n");
}

describe.skipIf(!hasDatabase)("CI projection against real pg-boss (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM webhook_events WHERE event_name = ANY($1::text[])", [
      ["workflow_run", "check_run"],
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
      ["workflow_run", "check_run"],
    ]);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM pr_head_ci_state WHERE owner = $1", [OWNER]);
    await deleteQueueJobs(boss, CI_PROJECTION_QUEUE);
  });

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
    expect(latest).not.toBeNull();
    expect(parseCiSummaryMarkerVersion(latest?.body ?? "")).toBe(row?.version);
    expect(latest?.body).toContain(`v=${row?.version}`);
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
    const afterFirst = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterFirst?.version).toBe(1);
    const authored = parseCiAuthoredCache(afterFirst?.authored);
    expect(authored?.headline).toBe("❌ authored lint");
    expect(authored?.factsHash).toBe(hashCiFacts(afterFirst?.checks ?? {}));

    await executeCiProjectionJob(cfg, pool, boss, job, options);
    expect(calls).toHaveLength(1);
    const afterSecond = await loadPrHeadCiState(pool, OWNER, REPO, headSha);
    expect(afterSecond?.version).toBe(1);
    expect(parseCiAuthoredCache(afterSecond?.authored)?.factsHash).toBe(authored?.factsHash);

    const latest = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(latest?.body).toContain("authored lint");
    expect(latest?.body).toContain("v=1");
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

    const latest = fake.controls.getProgressComment(TRIAGE_SUMMARY_SENTINEL);
    expect(latest?.body).toContain(renderCiRollupMarker(newHead, 1, "failing"));
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
        payload: {
          prCharacter: "No findings.",
          findings: [],
          size: "XS",
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        },
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

    await projectHead(headA);
    const afterOldProjection = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(afterOldProjection?.body).toContain(`head=${headB}`);
    expect(afterOldProjection?.body).not.toContain(`head=${headA}`);

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
    const afterNewProjection = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
    expect(afterNewProjection?.body).toContain(`head=${headB}`);
    expect(parseCiSummaryMarkerVersion(afterNewProjection?.body ?? "")).toBe(rowB?.version);
    expect(afterNewProjection?.body).toContain(`v=${rowB?.version}`);
  });
});
