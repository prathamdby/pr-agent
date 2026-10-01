import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import * as intentRepository from "../../src/agentWork/operationIntentRepository.js";
import * as reconciliation from "../../src/agentWork/reconcilePendingIntents.js";
import * as durableJob from "../../src/agentWork/durableJob.js";
import type { DurableJobSpec } from "../../src/agentWork/durableJob.js";
import { executeReviewJob } from "../../src/agentWork/executors/reviewExecutor.js";
import { acquirePrActorLease } from "../../src/agentWork/prActorLease.js";
import {
  claimWorkForExecution,
  beginWorkAttempt,
  getWorkItem,
  loadReviewExecutorPublishContext,
  recordPublishStep,
  recordReviewCheckRun,
} from "../../src/agentWork/repository.js";
import { retryDispositionFor } from "../../src/agentWork/retryPolicy.js";
import { AppError } from "../../src/errors/appError.js";
import type { ReviewJobData } from "../../src/agentWork/types.js";
import * as appAuth from "../../src/github/appAuth.js";
import * as surfaceFactory from "../../src/github/prSurface.js";
import { withPrSurfaceMutationBoundary } from "../../src/github/prSurfaceMutation.js";
import { recoverPrSurfaceMutation } from "../../src/github/recoverPrSurfaceMutation.js";
import { findReviewCheckRunByName } from "../../src/github/reviewPublish.js";
import { CHECK_RUNS_MAX_PAGES, CHECK_RUNS_PAGE_SIZE } from "../../src/settings/index.js";
import { REVIEW_SUMMARY_SENTINEL } from "../../src/review/reviewSchema.js";
import { makeTestConfig } from "../helpers/config.js";
import {
  runInOperationIntentFrame,
  withOperationIntent,
  operationIntentMarker,
  type WithOperationIntentParams,
} from "../../src/agentWork/withOperationIntent.js";
import { createFakePrSurface } from "../../src/github/prSurface.js";
import { runMigrations } from "../../src/db/migrations.js";
import { hasDatabase, integrationPool } from "./db.js";

describe.skipIf(!hasDatabase)("inline review publish batches (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    durableJob.clearDurableAuthCachesForTest();
  });

  it("publishes distinct nested batches and records each once across retries", async () => {
    const workItemId = randomUUID();
    const resourceKey = `integration/publish-batches#${randomUUID()}`;
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, $3::jsonb)`,
      [workItemId, resourceKey, JSON.stringify({ mode: "review", source: "slash" })],
    );

    try {
      const { surface, controls } = createFakePrSurface(
        { owner: "o", repo: "r", prNumber: 1 },
        {
          mutationBoundary: {
            signal: new AbortController().signal,
            run: (mutation, mutate) =>
              withOperationIntent({
                client: pool,
                workItemId,
                operationKey: mutation.operationKey,
                mutationKind: mutation.mutationKind,
                detail: mutation.detail,
                recover: mutation.recover as WithOperationIntentParams<
                  Awaited<ReturnType<typeof mutate>>
                >["recover"],
                allowsUndefinedResult: mutation.allowsUndefinedResult,
                mutate,
              }),
          },
        },
      );
      const publish = (body: string) =>
        runInOperationIntentFrame("review:publish", () =>
          surface.publishThreadBatch({ body, event: "COMMENT", commitId: "abc1234" }),
        );
      const first = await publish("correctness findings");
      const second = await publish("security findings");
      expect(await publish("correctness findings")).toEqual(first);
      expect(await publish("security findings")).toEqual(second);
      expect(first.reviewId).not.toBe(second.reviewId);
      expect(controls.threadBatches.map((batch) => batch.body)).toEqual([
        "correctness findings",
        "security findings",
      ]);
      const intents = await pool.query<{ operation_key: string; status: string }>(
        "SELECT operation_key, status FROM operation_intents WHERE work_item_id = $1",
        [workItemId],
      );
      expect(intents.rows).toHaveLength(2);
      expect(new Set(intents.rows.map((intent) => intent.operation_key)).size).toBe(2);
      expect(intents.rows.map((intent) => intent.status)).toEqual(["reconciled", "reconciled"]);

      const firstBatch = {
        batchId: "batch-1",
        workItemId,
        specialist: "correctness",
        reviewId: first.reviewId,
        fingerprints: ["fp-1"],
        placements: [
          {
            finding: {
              severity: "P1",
              file: "src/a.ts",
              startLine: 10,
              endLine: 10,
              title: "Missing null check",
              detail: "The payload can be null.",
              fixPrompt: "Guard the payload before dereferencing it.",
            },
            resolvedLine: 10,
            canonicalFingerprint: "fp-1",
          },
        ],
      };
      const secondBatch = {
        batchId: "batch-2",
        workItemId,
        specialist: "security",
        reviewId: second.reviewId,
        fingerprints: ["fp-2"],
        placements: [],
      };
      const write = (detail: typeof firstBatch) =>
        recordPublishStep(pool, {
          workItemId,
          leaseEpoch: null,
          resourceKey,
          reviewLens: "review",
          step: "inline_review",
          githubId: detail.reviewId,
          detail,
        });

      await write(firstBatch);
      await write(firstBatch);
      await write(secondBatch);
      await recordPublishStep(pool, {
        workItemId,
        leaseEpoch: null,
        resourceKey,
        reviewLens: "review-security",
        step: "inline_review",
        githubId: 40,
        detail: { fingerprints: ["fp-legacy"] },
      });

      const result = await pool.query<{ github_id: string; detail: { batches: unknown[] } }>(
        `SELECT github_id, detail
           FROM publish_records
          WHERE resource_key = $1
            AND review_lens = 'review'
            AND step = 'inline_review'`,
        [resourceKey],
      );
      expect(result.rows).toEqual([
        {
          github_id: String(second.reviewId),
          detail: { batches: [firstBatch, secondBatch] },
        },
      ]);
      const context = await loadReviewExecutorPublishContext(
        pool,
        workItemId,
        resourceKey,
        "review",
      );
      expect(context.publishState.inlineReviewIds).toEqual([first.reviewId, second.reviewId]);
      expect(context.publishState.threadCallCount).toBe(2);
      expect(context.storedInlineFingerprints.toSorted()).toEqual(["fp-1", "fp-2", "fp-legacy"]);
      expect(context.resumedPlacements).toEqual([
        {
          kind: "resumed",
          source: "correctness",
          placement: {
            finding: firstBatch.placements[0]?.finding,
            inlineLine: 10,
            inlinePosted: true,
          },
          canonicalFingerprint: "fp-1",
          reviewId: first.reviewId,
        },
      ]);
    } finally {
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });

  it.each([true, false])(
    "retries an incomplete check lookup without remutation, observed match: %s",
    async (matched) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/check-lookup-${randomUUID()}#1`;
      const operationKey = "review:check-lookup";
      const token = `fake-check-lookup-${workItemId}`;
      const client = appAuth.installationOctokit(token);
      const originalList = client.rest.checks.listForRef;
      let incomplete = true;
      const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
      await pool.query(
        `INSERT INTO agent_work_items
           (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
         VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, '{"mode":"review","source":"slash"}')`,
        [workItemId, resourceKey],
      );
      try {
        await intentRepository.persistOperationIntent(pool, {
          workItemId,
          operationKey,
          mutationKind: "github.pr_surface.startReviewCheck",
          detail: {
            __mutating: true,
            surfaceMethod: "startReviewCheck",
            headSha: "abc1234",
            externalId: workItemId,
          },
        });
        const mutate = vi.fn(() => surface.startReviewCheck("abc1234", workItemId));
        const check = await mutate();
        const exact = {
          id: check.id,
          name: "PR Agent Review",
          head_sha: "abc1234",
          external_id: workItemId,
          html_url: check.url,
        };
        const rows = Array.from(
          { length: CHECK_RUNS_MAX_PAGES * CHECK_RUNS_PAGE_SIZE },
          (_, index) => ({
            ...exact,
            id: index + 100,
            external_id: `other-${index}`,
          }),
        );
        if (matched) rows[CHECK_RUNS_PAGE_SIZE] = exact;
        const list = vi.fn(async ({ page = 1 }: { page?: number }) => ({
          data: {
            check_runs: incomplete
              ? rows.slice((page - 1) * CHECK_RUNS_PAGE_SIZE, page * CHECK_RUNS_PAGE_SIZE)
              : [exact],
          },
        }));
        Object.assign(client.rest.checks, { listForRef: list });
        const recoverySurface = {
          ...surface,
          findReviewCheck: (headSha: string, externalId: string) =>
            findReviewCheckRunByName(token, "o", "r", headSha, "PR Agent Review", externalId),
        };
        const params = {
          client: pool,
          workItemId,
          operationKey,
          mutationKind: "github.pr_surface.startReviewCheck",
          mutate,
          recover: (intent: intentRepository.OperationIntentRow) =>
            recoverPrSurfaceMutation<typeof check>(recoverySurface, intent),
        };
        const failure = await withOperationIntent(params).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: "operation_intent.recovery_failed",
          cause: { code: "github.review_check_lookup_incomplete" },
        });
        expect(retryDispositionFor(failure)).toBe("transient");
        const unknown = await intentRepository.getOperationIntent(pool, workItemId, operationKey);
        expect(unknown?.detail.unknownResolution).toBeUndefined();
        expect(unknown?.detail.__result).toBeUndefined();
        expect(await getWorkItem(pool, workItemId)).toMatchObject({ status: "running" });
        expect(mutate).toHaveBeenCalledTimes(1);

        incomplete = false;
        expect(await withOperationIntent(params)).toEqual(check);
        await recordReviewCheckRun(pool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          githubId: check.id,
          detail: { headSha: "abc1234", externalId: workItemId },
        });
        await surface.finishReviewCheck({
          checkRunId: check.id,
          conclusion: "success",
          summary: "Recovered.",
        });
        const reads = list.mock.calls.length;
        const effects = controls.events.length;
        expect(await withOperationIntent(params)).toEqual(check);
        expect(list).toHaveBeenCalledTimes(reads);
        expect(controls.events).toHaveLength(effects);
        expect(mutate).toHaveBeenCalledTimes(1);
        expect(controls.events.filter((event) => event.kind === "startReviewCheck")).toHaveLength(
          1,
        );
        expect(controls.events).toContainEqual({
          kind: "finishReviewCheck",
          checkRunId: check.id,
          conclusion: "success",
        });
        expect(
          await intentRepository.getOperationIntent(pool, workItemId, operationKey),
        ).toMatchObject({
          status: "reconciled",
          detail: { __result: check },
        });
      } finally {
        Object.assign(client.rest.checks, { listForRef: originalList });
        appAuth.clearInstallationOctokitCacheForTest();
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it.each([
    "setAcknowledgementReaction",
    "setReviewCommitStatus",
    "setLabels",
    "finishReviewCheck",
    "replyAt",
    "handled stash error",
    "published summary",
  ] as const)(
    "resolves %s after landed mutation and missing stash, then replays quietly",
    async (method) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/unknown-${randomUUID()}#1`;
      const cfg = makeTestConfig();
      const boss = new PgBoss({ connectionString: cfg.databaseUrl });
      vi.spyOn(boss, "send").mockResolvedValue(randomUUID());
      vi.spyOn(boss, "findJobs").mockResolvedValue([]);
      vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
        type: "token",
        tokenType: "installation",
        token: "fake-integration-token",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        installationId: 42,
        permissions: {},
        repositorySelection: "all",
      });
      vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
        userId: 999,
        login: "pr-agent[bot]",
      });
      const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
      controls.setHeadSha("abc1234");
      controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "Review in progress", 70);
      vi.spyOn(surfaceFactory, "createPrSurface").mockImplementation((params) =>
        params.mutationBoundary
          ? withPrSurfaceMutationBoundary(surface, params.mutationBoundary)
          : surface,
      );
      const job = {
        id: randomUUID(),
        data: { workItemId },
        retryCount: 0,
        retryLimit: 3,
        startedOn: new Date(),
        expireInSeconds: 3600,
        signal: new AbortController().signal,
      } as JobWithMetadata<ReviewJobData>;
      const capture = vi.spyOn(durableJob, "runDurableWorkItem").mockResolvedValue(undefined);
      await executeReviewJob(cfg, pool, boss, job);
      const captured = capture.mock.calls[0]?.[0];
      capture.mockRestore();
      expect(captured?.type).toBe("review");
      const spec = captured as DurableJobSpec<"review">;
      const originalMethod =
        method === "handled stash error" || method === "published summary" ? "setLabels" : method;
      const execute: DurableJobSpec<"review">["execute"] = async (_item, env) => {
        await runInOperationIntentFrame("integration:crash", async () => {
          switch (originalMethod) {
            case "setAcknowledgementReaction":
              return env.prSurface.setAcknowledgementReaction(
                [{ kind: "pr", prNumber: 1 }],
                "eyes",
              );
            case "setReviewCommitStatus":
              return env.prSurface.setReviewCommitStatus("abc1234", {
                state: "pending",
                description: "original mutation",
              });
            case "setLabels":
              return env.prSurface.setLabels(["original mutation"]);
            case "finishReviewCheck":
              return env.prSurface.finishReviewCheck({
                checkRunId: 42,
                conclusion: "success",
                summary: "original mutation",
              });
            case "replyAt":
              return env.prSurface.replyAt(
                { kind: "prConversation", prNumber: 1 },
                `Original reply ${operationIntentMarker("integration:crash", workItemId)}`,
              );
          }
        });
        return { kind: "completed" };
      };
      await pool.query(
        `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'queued', 'o', 'r', 1, 42, 'abc1234', 'review', $2, '{"mode":"review","source":"slash"}')`,
        [workItemId, resourceKey],
      );
      const check = await surface.startReviewCheck("abc1234", workItemId);
      await recordReviewCheckRun(pool, {
        workItemId,
        resourceKey,
        reviewLens: "review",
        githubId: check.id,
        leaseEpoch: null,
        detail: { status: "in_progress", headSha: "abc1234", externalId: workItemId },
      });
      if (method === "published summary") {
        controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "Published review", 70);
        await recordPublishStep(pool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          step: "summary_comment",
          githubId: 70,
          leaseEpoch: null,
          detail: { findings: [] },
        });
      }
      const originalNotice = controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body;
      const merge = intentRepository.mergeOperationIntentDetail;
      let stashMissed = false;
      const fault = vi
        .spyOn(intentRepository, "mergeOperationIntentDetail")
        .mockImplementation(async (client, params) => {
          if (
            params.workItemId === workItemId &&
            Object.hasOwn(params.detail, "__result") &&
            !stashMissed
          ) {
            stashMissed = true;
            throw new Error("simulated death before result stash");
          }
          return merge(client, params);
        });
      try {
        if (method === "handled stash error") {
          await expect(durableJob.runDurableWorkItem({ ...spec, execute })).rejects.toMatchObject({
            code: "operation_intent.mutation_outcome_unknown",
          });
          expect(await getWorkItem(pool, workItemId)).toMatchObject({
            status: "queued",
            attemptCount: 0,
          });
          const lease = await pool.query(
            "SELECT work_item_id FROM pr_actor_leases WHERE resource_key = $1",
            [resourceKey],
          );
          expect(lease.rows[0]?.work_item_id).toBeNull();
        } else {
          const acquisition = await acquirePrActorLease(pool, {
            resourceKey,
            workType: "review",
            workItemId,
            holderId: "crashed-integration-worker",
            ttlSeconds: 900,
          });
          expect(acquisition).toEqual({ acquired: true, leaseEpoch: 1 });
          await claimWorkForExecution(pool, workItemId, 1);
          const fenced = withPrSurfaceMutationBoundary(surface, {
            signal: job.signal,
            run: (mutation, mutate) =>
              withOperationIntent({
                client: pool,
                workItemId,
                leaseEpoch: 1,
                operationKey: mutation.operationKey,
                mutationKind: mutation.mutationKind,
                detail: mutation.detail,
                mutate,
                recover: mutation.recover as WithOperationIntentParams<
                  Awaited<ReturnType<typeof mutate>>
                >["recover"],
                allowsUndefinedResult: mutation.allowsUndefinedResult,
              }),
          });
          const item = await getWorkItem(pool, workItemId);
          if (item?.type !== "review") throw new Error("missing review work");
          await expect(
            execute(item, {
              prSurface: fenced,
              headSha: "abc1234",
              leaseEpoch: 1,
              beginAttempt: async () => {
                const result = await beginWorkAttempt(pool, workItemId, 1, 4);
                if (result.kind !== "started") throw new Error("work not admitted");
                return { ...result.claim, resumed: true };
              },
              signal: job.signal,
            }),
          ).rejects.toMatchObject({
            code: "operation_intent.mutation_outcome_unknown",
          });
          expect(await getWorkItem(pool, workItemId)).toMatchObject({
            status: "running",
            attemptCount: 0,
          });
          const lease = await pool.query(
            "SELECT work_item_id FROM pr_actor_leases WHERE resource_key = $1",
            [resourceKey],
          );
          expect(lease.rows[0]?.work_item_id).toBe(workItemId);
          await pool.query(
            "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
            [resourceKey],
          );
        }
        fault.mockRestore();
        expect(stashMissed).toBe(true);
        const intents = await pool.query(
          "SELECT operation_key, status, detail FROM operation_intents WHERE work_item_id = $1",
          [workItemId],
        );
        expect(intents.rows).toHaveLength(1);
        expect(intents.rows[0]).toMatchObject({ status: "pending", detail: { __mutating: true } });
        expect(Object.hasOwn(intents.rows[0].detail, "__result")).toBe(false);
        expect(controls.events.filter((event) => event.kind === originalMethod)).toHaveLength(1);

        const attemptCap = cfg.queueRetryLimit + 1;
        await pool.query("UPDATE agent_work_items SET attempt_count = $2 WHERE id = $1", [
          workItemId,
          attemptCap,
        ]);
        await durableJob.runDurableWorkItem({ ...spec, execute });
        expect(
          controls.events.filter(
            (event) =>
              event.kind === originalMethod &&
              (event.kind !== "setAcknowledgementReaction" || event.reaction === "eyes") &&
              (event.kind !== "finishReviewCheck" || event.checkRunId === 42),
          ),
        ).toHaveLength(1);
        expect(await getWorkItem(pool, workItemId)).toMatchObject({
          status: method === "replyAt" ? "completed" : "failed",
          attemptCount: attemptCap,
        });
        const epoch = await pool.query(
          "SELECT execution_epoch FROM agent_work_items WHERE id = $1",
          [workItemId],
        );
        expect(Number(epoch.rows[0]?.execution_epoch)).toBe(2);
        const notice = controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
        if (method === "replyAt" || method === "published summary") {
          expect(notice?.body).toBe(originalNotice);
          if (method === "replyAt") expect(controls.replies).toHaveLength(1);
          expect(controls.events.filter((event) => event.kind === "editComment")).toHaveLength(0);
        } else {
          expect(notice?.body).toContain("/review");
          expect(notice?.body).not.toContain("simulated death");
          expect(controls.events.filter((event) => event.kind === "editComment")).toHaveLength(1);
          expect(controls.events).toContainEqual({
            kind: "finishReviewCheck",
            checkRunId: check.id,
            conclusion: "action_required",
          });
        }
        const eventCount = controls.events.length;
        for (let replay = 0; replay < 3; replay++)
          await durableJob.runDurableWorkItem({ ...spec, execute });
        expect(await getWorkItem(pool, workItemId)).toMatchObject({ attemptCount: attemptCap });
        expect(controls.events).toHaveLength(eventCount);
        console.info(
          "budget-survival-evidence",
          JSON.stringify({
            scenario: `recovery_at_cap:${method}`,
            originalMutations: 1,
            status: method === "replyAt" ? "completed" : "failed",
            quietRedeliveries: 3,
          }),
        );
        const outcome = await pool.query(
          "SELECT status, detail FROM operation_intents WHERE work_item_id = $1 AND operation_key = $2",
          [workItemId, intents.rows[0].operation_key],
        );
        if (method === "replyAt") {
          expect(outcome.rows[0]?.status).toBe("reconciled");
          expect(outcome.rows[0]?.detail.__result.commentId).toBeGreaterThan(0);
        } else {
          expect(outcome.rows[0]).toMatchObject({
            status: "outcome_unknown",
            detail: { unknownResolution: "terminal" },
          });
          expect(Object.hasOwn(outcome.rows[0].detail, "__result")).toBe(false);
        }
      } finally {
        vi.restoreAllMocks();
        await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it.each([
    "cached terminal",
    "typed absence",
    "reconciled typed",
    "void ledger",
    "typed ledger outage",
    "provider outage",
    "lookup outage",
    "proven rejection",
  ] as const)("preserves evidence and replay contracts: %s", async (scenario) => {
    const workItemId = randomUUID();
    const resourceKey = `integration/evidence-${randomUUID()}#1`;
    const operationKey = "review:summary:evidence";
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, '{"mode":"review","source":"slash"}')`,
      [workItemId, resourceKey],
    );
    try {
      const ledger =
        scenario === "void ledger" ||
        scenario === "typed ledger outage" ||
        scenario === "typed absence";
      if (ledger)
        await recordPublishStep(pool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          step: "summary_comment",
          githubId: 90,
          leaseEpoch: null,
          detail: {},
        });
      await intentRepository.persistOperationIntent(pool, {
        workItemId,
        operationKey,
        mutationKind: "review_summary",
        detail: {
          step: "summary_comment",
          resourceKey,
          reviewLens: "review",
          ...(scenario === "proven rejection" ? {} : { __mutating: true }),
        },
      });
      if (scenario === "cached terminal" || scenario === "reconciled typed") {
        await intentRepository.reconcileOperationIntent(pool, {
          workItemId,
          operationKey,
          status: scenario === "cached terminal" ? "outcome_unknown" : "reconciled",
          detail: scenario === "cached terminal" ? { unknownResolution: "terminal" } : {},
        });
      }
      const mutate = vi.fn(async () => ({ commentId: 90 }));
      const recover = vi.fn(
        async (): Promise<
          { kind: "absent" } | { kind: "reconciled"; value: { commentId: number } }
        > => ({ kind: "absent" }),
      );
      const params = {
        client: pool,
        workItemId,
        operationKey,
        mutationKind: "review_summary",
        mutate,
        recover,
        allowsUndefinedResult: scenario === "void ledger",
      };
      if (
        scenario === "provider outage" ||
        scenario === "typed ledger outage" ||
        scenario === "void ledger"
      ) {
        recover.mockRejectedValueOnce(new Error("temporary observation failure"));
      }
      const lookup = vi.spyOn(reconciliation, "findCompletedPublishRecordId");
      const reconcile = vi.spyOn(intentRepository, "reconcileOperationIntent");
      if (scenario === "lookup outage")
        lookup.mockRejectedValueOnce(new Error("temporary ledger read failure"));
      if (scenario === "proven rejection") {
        mutate.mockRejectedValueOnce(
          Object.assign(new Error("provider rejected before acceptance"), { status: 422 }),
        );
        await expect(
          withOperationIntent({ ...params, isKnownNoAcceptanceError: () => true }),
        ).rejects.toMatchObject({
          code: "operation_intent.mutation_failed",
        });
        expect(
          (await intentRepository.getOperationIntent(pool, workItemId, operationKey))?.status,
        ).toBe("failed");
        expect(await withOperationIntent(params)).toEqual({ commentId: 90 });
        expect(mutate).toHaveBeenCalledTimes(2);
      } else if (scenario === "void ledger") {
        expect(await withOperationIntent(params)).toBeUndefined();
        expect(
          (await intentRepository.getOperationIntent(pool, workItemId, operationKey))?.detail
            .__result,
        ).toBeNull();
      } else {
        const error = await withOperationIntent(params).catch((failure: unknown) => failure);
        const transient =
          scenario === "provider outage" ||
          scenario === "lookup outage" ||
          scenario === "typed ledger outage";
        expect(error).toMatchObject({
          code:
            scenario === "provider outage"
              ? "operation_intent.recovery_failed"
              : scenario === "lookup outage"
                ? "operation_intent.publish_record_lookup_failed"
                : "operation_intent.mutation_outcome_unknown",
        });
        expect(retryDispositionFor(error)).toBe(transient ? "transient" : "terminal");
        const intent = await intentRepository.getOperationIntent(pool, workItemId, operationKey);
        expect(intent?.detail.__result).toBeUndefined();
        if (transient) {
          expect(intent?.detail.unknownResolution).toBeUndefined();
          recover.mockResolvedValue({ kind: "reconciled", value: { commentId: 90 } });
          expect(await withOperationIntent(params)).toEqual({ commentId: 90 });
          const readCount = recover.mock.calls.length;
          expect(await withOperationIntent(params)).toEqual({ commentId: 90 });
          expect(recover).toHaveBeenCalledTimes(readCount);
        } else if (scenario === "cached terminal" || scenario === "typed absence") {
          const readCount = recover.mock.calls.length;
          const lookupCount = lookup.mock.calls.length;
          for (let replay = 0; replay < 2; replay++) {
            const next = await withOperationIntent(params).catch((failure: unknown) => failure);
            expect(retryDispositionFor(next)).toBe("terminal");
          }
          expect(recover).toHaveBeenCalledTimes(readCount);
          expect(lookup).toHaveBeenCalledTimes(lookupCount);
          if (scenario === "cached terminal") {
            expect(recover).not.toHaveBeenCalled();
            expect(lookup).not.toHaveBeenCalled();
          }
        } else {
          expect(intent?.status).toBe("reconciled");
          expect(reconcile).not.toHaveBeenCalled();
        }
      }
      if (scenario !== "proven rejection") expect(mutate).not.toHaveBeenCalled();
      expect(
        retryDispositionFor(
          new AppError({
            code: "operation_intent.mutation_outcome_unknown",
            message: "legacy unknown",
          }),
        ),
      ).toBe("transient");
    } finally {
      vi.restoreAllMocks();
      await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });
});
