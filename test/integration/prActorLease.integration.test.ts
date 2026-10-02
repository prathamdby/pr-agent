import { createPublishContext } from "../../src/agentWork/publishOnce.js";
import {
  operationIntentMarker,
  runInOperationIntentFrame,
} from "../../src/agentWork/publishOnce.js";
import { createFakePrSurface, withPrSurfaceMutationBoundary } from "../../src/github/prSurface.js";
import type { PrSurfaceMutation, PrSurfaceMutationBoundary } from "../../src/github/prSurface.js";
import { recoverPrSurfaceMutation } from "../../src/github/recoverPrSurfaceMutation.js";

import { createDurableRuntime } from "../../src/agentWork/durableJob.js";
import { createWorkDefinitions } from "../../src/agentWork/workDefinition.js";
import { openInstallationSurface } from "../../src/agentWork/installationSurface.js";
import * as localPrWorkspaceModule from "../../src/prWorkspace/localPrWorkspace.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { PgBoss } from "pg-boss";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import * as postgres from "../../src/db/postgres.js";
import * as bossModule from "../../src/agentWork/boss.js";
import * as executionTrackerModule from "../../src/agentWork/executionTracker.js";
import * as reviewExecutorModule from "../../src/agentWork/executors/reviewExecutor.js";
import * as descriptionRun from "../../src/agent/description/descriptionRun.js";
import { AppError } from "../../src/errors/appError.js";
import { assistantFromText } from "../../src/agent/runtime/featureAgent.js";
import { mockLocalPrWorkspace } from "../helpers/mockWorkspace.js";
import { makeDurableJobMetadata } from "../helpers/executorDurableHarness.js";
import * as retentionModule from "../../src/agentWork/retention.js";
import * as lostRunningModule from "../../src/agentWork/lostRunningWork.js";
import * as projectionRepairModule from "../../src/agentWork/projectionRepair.js";
import * as workerHealthModule from "../../src/agentWork/workerHealth.js";
import * as prWorkspaceModule from "../../src/prWorkspace/prRepositoryView.js";
import { agentWorkWorkerLive } from "../../src/agentWork/worker.js";
import {
  DEFERRED_HEAD_SHA,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
  REVIEW_SUMMARY_SENTINEL,
  STALE_QUEUED_WORK_GRACE_SECONDS,
} from "../../src/settings/index.js";
import { retryDispositionFor } from "../../src/agentWork/retryPolicy.js";
import { runMigrations } from "../../src/db/migrations.js";
import { inTransaction } from "../../src/db/postgres.js";
import * as evlog from "../../src/evlog.js";
import * as leaseRepository from "../../src/agentWork/prActorLease.js";
import * as intentRepository from "../../src/agentWork/operationIntentRepository.js";
import * as workRepository from "../../src/agentWork/workItemStateRepository.js";
import { recordReviewCheckRun } from "../../src/agentWork/publishRecordRepository.js";
import * as appAuth from "../../src/github/appAuth.js";
import * as prSurfaceModule from "../../src/github/prSurface.js";
import { runDurableWorkItem, type DurableJobSpec } from "../../src/agentWork/durableJob.js";
import { acquireAndClaimWorkItem } from "../../src/agentWork/leasedExecution.js";

import { makeTestConfig } from "../helpers/config.js";
import {
  acquirePrActorLease,
  armLeaseWatchdogHop,
  assertPrActorLeaseHeld,
  isPrActorLeaseHeld,
  releasePrActorLease,
  releasePrActorLeaseHeldByWorkItems,
  renewPrActorLease,
} from "../../src/agentWork/prActorLease.js";
import type { OperationIntentRow } from "../../src/agentWork/operationIntentRepository.js";
import { publishOnce } from "../../src/agentWork/publishOnce.js";
import {
  cancelPendingStaleHeadReplacement,
  createReviewRescheduleWorkItem,
} from "../../src/agentWork/reviewReschedule.js";
import { installationGroupId, type ReviewWorkItem } from "../../src/agentWork/types.js";
import {
  cancelActiveReviews,
  cancelActiveTriage,
} from "../../src/agentWork/intake/workItemRepository.js";
import {
  replaceActiveAutoWorkItem,
  replaceAutoWorkItem,
} from "../../src/agentWork/autoWorkEnqueue.js";
import {
  claimWorkForExecution,
  getWorkItem,
  markWorkCompleted,
  markWorkFailed,
  markWorkPublishDegraded,
  updateRunningWorkHeadSha,
} from "../../src/agentWork/workItemStateRepository.js";
import { hasDatabase, integrationPool } from "./db.js";
import { reviewVerdict } from "../../src/agentWork/reviewVerdict.js";
import * as ownVerdictModule from "../../src/agentWork/reviewVerdict.js";

const OWNER = "lease-it";
const TTL_SECONDS = 900;

type LeaseRow = {
  readonly lease_epoch: string | number;
  readonly work_item_id: string | null;
  readonly holder_id: string | null;
  readonly expires_at: Date;
};

describe.skipIf(!hasDatabase)("PR actor lease (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query("DELETE FROM pr_actor_leases WHERE resource_key LIKE $1", [`${OWNER}/%`]);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
  });

  async function insertRunningWorkItem(resourceKey: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES (
         $1, 'review', 'auto', 'queued', $2, 'r', 1, 1, 'h', 'review', $3,
         '{"mode":"review","source":"auto"}'::jsonb
       )`,
      [id, OWNER, resourceKey],
    );
    await claimWorkForExecution(pool, id);
    return id;
  }

  async function getLeaseRow(resourceKey: string): Promise<LeaseRow> {
    const { rows } = await pool.query<LeaseRow>(
      `SELECT lease_epoch, work_item_id, holder_id, expires_at
         FROM pr_actor_leases
        WHERE resource_key = $1 AND work_type = 'review'`,
      [resourceKey],
    );
    const row = rows[0];
    if (!row) throw new Error(`missing lease row for ${resourceKey}`);
    return row;
  }

  function acquire(resourceKey: string, workItemId: string) {
    return acquirePrActorLease(pool, {
      resourceKey,
      workType: "review",
      workItemId,
      holderId: "lease-it-holder",
      ttlSeconds: TTL_SECONDS,
    });
  }

  const surfaceParams = { owner: "o", repo: "r", prNumber: 1 };

  describe("PrSurface lease mutation boundary", () => {
    it("blocks every mutating method before the fake external call when ownership is lost", async () => {
      const resourceKey = `${OWNER}/surface-fence-${randomUUID()}#1`;
      const workItemId = await insertRunningWorkItem(resourceKey);
      const initial = await acquire(resourceKey, workItemId);
      if (!initial.acquired) throw new Error("expected initial lease");
      await releasePrActorLease(pool, {
        resourceKey,
        workType: "review",
        leaseEpoch: initial.leaseEpoch,
      });
      let epoch = initial.leaseEpoch;
      const runCalls: PrSurfaceMutation[] = [];
      const run: PrSurfaceMutationBoundary["run"] = async <T>(
        mutation: PrSurfaceMutation,
        mutate: () => Promise<T>,
      ): Promise<T> => {
        runCalls.push(mutation);
        await assertPrActorLeaseHeld(pool, workItemId, epoch);
        return mutate();
      };
      const { surface, controls } = createFakePrSurface(surfaceParams, {
        mutationBoundary: { signal: new AbortController().signal, run },
      });

      const attempts: Array<readonly [string, () => Promise<unknown>]> = [
        [
          "setAcknowledgementReaction",
          () => surface.setAcknowledgementReaction([{ kind: "pr", prNumber: 1 }], "eyes"),
        ],
        ["replyAt", () => surface.replyAt({ kind: "prConversation", prNumber: 1 }, "reply")],
        ["upsertProgressComment", () => surface.upsertProgressComment("body", "sentinel")],
        ["editComment", () => surface.editComment(10, "body")],
        [
          "setReviewCommitStatus",
          () => surface.setReviewCommitStatus("head", { state: "success", description: "done" }),
        ],
        [
          "publishThreadBatch",
          () => surface.publishThreadBatch({ body: "review", event: "COMMENT" }),
        ],
        ["resolveInlineReviewThread", () => surface.resolveInlineReviewThread("thread")],
        ["setLabels", () => surface.setLabels(["pr-agent-size-small"])],
        ["startReviewCheck", () => surface.startReviewCheck("head", "work-item")],
        [
          "finishReviewCheck",
          () =>
            surface.finishReviewCheck({
              checkRunId: 1,
              conclusion: "cancelled",
              summary: "cancelled",
            }),
        ],
        ["editReviewComment", () => surface.editReviewComment(10, "body")],
        ["updatePullRequest", () => surface.updatePullRequest({ title: "title", body: "body" })],
      ];

      for (const [, attempt] of attempts) {
        await expect(attempt()).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });
      }

      expect(runCalls).toHaveLength(attempts.length);
      expect(
        controls.events.filter((event) =>
          [
            "setAcknowledgementReaction",
            "replyAt",
            "upsertProgressComment",
            "editComment",
            "setReviewCommitStatus",
            "publishThreadBatch",
            "resolveInlineReviewThread",
            "setLabels",
            "startReviewCheck",
            "finishReviewCheck",
            "editReviewComment",
            "updatePullRequest",
          ].includes(event.kind),
        ),
      ).toHaveLength(0);

      const current = await acquire(resourceKey, workItemId);
      if (!current.acquired) throw new Error("expected current lease");
      epoch = current.leaseEpoch;
      await surface.setLabels(["pr-agent-size-small"]);
      expect(controls.events).toContainEqual({
        kind: "setLabels",
        labels: ["pr-agent-size-small"],
      });
    });

    it("does not invoke the boundary after cancellation and leaves every read available", async () => {
      const controller = new AbortController();
      let runCalled = false;
      const run: PrSurfaceMutationBoundary["run"] = async <T>(
        _mutation: PrSurfaceMutation,
        _mutate: () => Promise<T>,
      ): Promise<T> => {
        runCalled = true;
        return undefined as T;
      };
      const { surface, controls } = createFakePrSurface(surfaceParams, {
        mutationBoundary: { signal: controller.signal, run },
      });

      const resourceKey = `${OWNER}/surface-cancel-${randomUUID()}#1`;
      const workItemId = await insertRunningWorkItem(resourceKey);
      const lease = await acquire(resourceKey, workItemId);
      if (!lease.acquired) throw new Error("expected lease");
      await workRepository.markWorkCancelled(pool, workItemId, lease.leaseEpoch);
      expect(await workRepository.shouldSkipWork(pool, { id: workItemId })).toBe(true);
      controller.abort(new Error("renewal lost"));
      await expect(
        surface.replyAt({ kind: "prConversation", prNumber: 1 }, "reply"),
      ).rejects.toThrow("renewal lost");
      expect(runCalled).toBe(false);

      const reads: Array<readonly [string, () => Promise<unknown>]> = [
        ["getHead", () => surface.getHead()],
        ["getHeadSha", () => surface.getHeadSha()],
        ["findProgressComment", () => surface.findProgressComment("sentinel")],
        ["resolveProgressComment", () => surface.resolveProgressComment("sentinel")],
        ["listReviewComments", () => surface.listReviewComments()],
        ["listPullRequestReviews", () => surface.listPullRequestReviews()],
        ["listInlineReviewThreads", () => surface.listInlineReviewThreads()],
        [
          "listChangedFiles",
          () =>
            surface.listChangedFiles({
              maxPrFilesListed: 10,
              maxPrFilesPatchBytes: 100,
            }),
        ],
        ["listCommitCompareFiles", () => surface.listCommitCompareFiles("base", "head")],
        ["getLabels", () => surface.getLabels()],
        ["getCiStatus", () => surface.getCiStatus("head")],
        ["listPullsForHead", () => surface.listPullsForHead("head")],
        ["listFailingActionsJobs", () => surface.listFailingActionsJobs("head")],
        ["downloadActionsJobLogs", () => surface.downloadActionsJobLogs(1)],
        ["gitCredentialAuth", () => surface.gitCredentialAuth()],
        ["listConversationComments", () => surface.listConversationComments()],
        ["listPushedCommits", () => surface.listPushedCommits()],
        ["lookupGitHubUser", () => surface.lookupGitHubUser(1)],
      ];

      for (const [, read] of reads) await expect(read()).resolves.not.toBeUndefined();
      expect(runCalled).toBe(false);
      expect(controls.events.map((event) => event.kind)).toEqual(
        expect.arrayContaining(reads.map(([kind]) => kind)),
      );
    });

    it("records stable mutation metadata and preserves unleased ask semantics", async () => {
      const resourceKey = `${OWNER}/surface-identity-${randomUUID()}#1`;
      const workItemId = await insertRunningWorkItem(resourceKey);
      const lease = await acquire(resourceKey, workItemId);
      if (!lease.acquired) throw new Error("expected lease");
      const mutations: PrSurfaceMutation[] = [];
      const { surface } = createFakePrSurface(surfaceParams, {
        mutationBoundary: {
          signal: new AbortController().signal,
          run: async (mutation, mutate) => {
            await assertPrActorLeaseHeld(pool, workItemId, lease.leaseEpoch);
            mutations.push(mutation);
            return mutate();
          },
        },
      });

      await surface.setLabels(["pr-agent-size-small"]);
      expect(mutations[0]).toMatchObject({
        operationKey: expect.stringMatching(/^pr-surface:setLabels:/),
        mutationKind: "github.pr_surface.setLabels",
        detail: { surfaceMethod: "setLabels" },
      });
      await surface.publishThreadBatch({ body: "review", event: "COMMENT", commitId: "head" });
      await surface.publishThreadBatch({ commitId: "head", event: "COMMENT", body: "review" });
      expect(mutations[1]?.operationKey).toBe(mutations[2]?.operationKey);
      expect(mutations[1]?.detail?.inputHash).toHaveLength(64);

      const unleased = createFakePrSurface(surfaceParams);
      await unleased.surface.replyAt({ kind: "prConversation", prNumber: 1 }, "ask reply");
      expect(unleased.controls.replies).toEqual([
        { target: { kind: "prConversation", prNumber: 1 }, body: "ask reply" },
      ]);
    });

    it("scopes nested surface mutation keys by input under a stable parent", async () => {
      const mutations: PrSurfaceMutation[] = [];
      const { surface } = createFakePrSurface(surfaceParams, {
        mutationBoundary: {
          signal: new AbortController().signal,
          run: async (mutation, mutate) => {
            mutations.push(mutation);
            return mutate();
          },
        },
      });

      await runInOperationIntentFrame("ask:reply:1:o/r#1", async () => {
        await surface.replyAt({ kind: "prConversation", prNumber: 1 }, "first body");
        await surface.replyAt({ kind: "prConversation", prNumber: 1 }, "second body");
        await surface.replyAt({ kind: "prConversation", prNumber: 1 }, "first body");
      });

      expect(mutations).toHaveLength(3);
      expect(mutations[0]?.operationKey).toMatch(/^ask:reply:1:o\/r#1:surface:replyAt:/);
      expect(mutations[1]?.operationKey).not.toBe(mutations[0]?.operationKey);
      expect(mutations[2]?.operationKey).toBe(mutations[0]?.operationKey);
      expect(mutations[0]?.detail).toMatchObject({
        surfaceMethod: "replyAt",
        parentOperationKey: "ask:reply:1:o/r#1",
      });
      expect(mutations[0]?.detail?.inputHash).not.toBe(mutations[1]?.detail?.inputHash);
    });

    it("returns the cached wrapped surface instead of the raw surface", async () => {
      const raw = createFakePrSurface(surfaceParams).surface;
      const boundary: PrSurfaceMutationBoundary = {
        signal: new AbortController().signal,
        run: async (_mutation, mutate) => mutate(),
      };

      const first = withPrSurfaceMutationBoundary(raw, boundary);
      expect(withPrSurfaceMutationBoundary(raw, boundary)).toBe(first);
      expect(withPrSurfaceMutationBoundary(first, boundary)).toBe(first);
    });

    it("recovers a marked replyAt without remutating and fails closed for labels", async () => {
      const mutations: PrSurfaceMutation[] = [];
      const { surface } = createFakePrSurface(surfaceParams, {
        mutationBoundary: {
          signal: new AbortController().signal,
          run: async (mutation, mutate) => {
            mutations.push(mutation);
            return mutate();
          },
        },
      });
      const marker = operationIntentMarker("verification:thread:9", "wi-1");

      const posted = await surface.replyAt(
        { kind: "prConversation", prNumber: 1 },
        `${marker}\nverification note`,
      );
      const replyMutation = mutations[0];
      expect(replyMutation?.detail).toMatchObject({
        surfaceMethod: "replyAt",
        operationMarker: marker,
        replyTargetKind: "prConversation",
      });
      expect(replyMutation?.recover).toEqual(expect.any(Function));

      const recovered = await recoverPrSurfaceMutation(surface, {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: replyMutation?.operationKey ?? "pr-surface:replyAt",
        mutationKind: "github.pr_surface.replyAt",
        status: "pending",
        publishRecordId: null,
        detail: { ...replyMutation?.detail, __mutating: true },
      } satisfies OperationIntentRow);
      expect(recovered).toEqual({ kind: "reconciled", value: { commentId: posted.commentId } });

      await surface.setLabels(["pr-agent-size-small"]);
      const labelMutation = mutations[1];
      const labelsRecovered = await recoverPrSurfaceMutation(surface, {
        id: "intent-2",
        workItemId: "wi-1",
        operationKey: labelMutation?.operationKey ?? "pr-surface:setLabels",
        mutationKind: "github.pr_surface.setLabels",
        status: "pending",
        publishRecordId: null,
        detail: { ...labelMutation?.detail, __mutating: true },
      } satisfies OperationIntentRow);
      expect(labelsRecovered).toEqual({ kind: "absent" });
    });

    it("recovers marked review-comment edits, thread resolution, and check runs", async () => {
      const mutations: PrSurfaceMutation[] = [];
      const { surface, controls } = createFakePrSurface(surfaceParams, {
        mutationBoundary: {
          signal: new AbortController().signal,
          run: async (mutation, mutate) => {
            mutations.push(mutation);
            return mutate();
          },
        },
      });
      const marker = operationIntentMarker("verification:thread:3", "wi-1");
      controls.setReviewCommentBody(8, "prior");
      controls.setReviewComments([
        {
          id: 8,
          inReplyToId: 3,
          pullRequestReviewId: null,
          userId: null,
          authorLogin: "pr-agent[bot]",
          body: `${marker}\n**Verification**: Still open`,
          path: null,
          line: null,
          originalLine: null,
          htmlUrl: "",
        },
      ]);
      controls.setThreads(new Map([[3, { threadNodeId: "thread-node", isResolved: true }]]));

      await surface.editReviewComment(8, `${marker}\n**Verification**: Still open`);
      const editRecovered = await recoverPrSurfaceMutation(surface, {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: "verification:thread:3:surface:editReviewComment",
        mutationKind: "github.pr_surface.editReviewComment",
        status: "pending",
        publishRecordId: null,
        detail: { ...mutations[0]?.detail, __mutating: true },
      } satisfies OperationIntentRow);
      expect(editRecovered).toEqual({ kind: "reconciled", value: true });

      await surface.resolveInlineReviewThread("thread-node");
      const resolveRecovered = await recoverPrSurfaceMutation(surface, {
        id: "intent-2",
        workItemId: "wi-1",
        operationKey: "verification:thread:3:surface:resolveInlineReviewThread",
        mutationKind: "github.pr_surface.resolveInlineReviewThread",
        status: "pending",
        publishRecordId: null,
        detail: { ...mutations[1]?.detail, __mutating: true },
      } satisfies OperationIntentRow);
      expect(resolveRecovered).toEqual({ kind: "reconciled", value: undefined });

      const check = await surface.startReviewCheck("abc123", "wi-1");
      const checkRecovered = await recoverPrSurfaceMutation(surface, {
        id: "intent-3",
        workItemId: "wi-1",
        operationKey: "review:check_run:wi-1:surface:startReviewCheck",
        mutationKind: "github.pr_surface.startReviewCheck",
        status: "pending",
        publishRecordId: null,
        detail: { ...mutations[2]?.detail, __mutating: true },
      } satisfies OperationIntentRow);
      expect(checkRecovered).toEqual({ kind: "reconciled", value: check });
    });

    it("derives progress updated from knownExistingId and fails closed without a marker", async () => {
      const mutations: PrSurfaceMutation[] = [];
      const { surface, controls } = createFakePrSurface(surfaceParams, {
        mutationBoundary: {
          signal: new AbortController().signal,
          run: async (mutation, mutate) => {
            mutations.push(mutation);
            return mutate();
          },
        },
      });
      const marker = operationIntentMarker("review:summary:review:o/r#1", "wi-1");
      const created = await surface.upsertProgressComment(
        `${marker}\n## PR Agent Review`,
        "## PR Agent Review",
      );
      expect(created.updated).toBe(false);
      expect(mutations[0]?.detail).toMatchObject({
        surfaceMethod: "upsertProgressComment",
        operationMarker: marker,
        sentinel: "## PR Agent Review",
      });

      const createdRecovered = await recoverPrSurfaceMutation(surface, {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: mutations[0]?.operationKey ?? "pr-surface:upsertProgressComment",
        mutationKind: "github.pr_surface.upsertProgressComment",
        status: "pending",
        publishRecordId: null,
        detail: { ...mutations[0]?.detail, __mutating: true },
      } satisfies OperationIntentRow);
      expect(createdRecovered).toEqual({
        kind: "reconciled",
        value: { id: created.id, updated: false },
      });

      const updated = await surface.upsertProgressComment(
        `${marker}\n## PR Agent Review\ndone`,
        "## PR Agent Review",
        { id: created.id, url: "https://example.test/1" },
      );
      expect(updated.updated).toBe(true);
      const updateRecovered = await recoverPrSurfaceMutation(surface, {
        id: "intent-2",
        workItemId: "wi-1",
        operationKey: mutations[1]?.operationKey ?? "pr-surface:upsertProgressComment",
        mutationKind: "github.pr_surface.upsertProgressComment",
        status: "pending",
        publishRecordId: null,
        detail: { ...mutations[1]?.detail, __mutating: true },
      } satisfies OperationIntentRow);
      expect(mutations[1]?.detail).toMatchObject({ knownExistingId: created.id });
      expect(updateRecovered).toEqual({
        kind: "reconciled",
        value: { id: created.id, updated: true },
      });

      controls.setConversationComments([
        {
          id: 99,
          inReplyToId: null,
          authorLogin: "attacker",
          body: "## PR Agent Review\nspoofed",
        },
      ]);
      const sentinelOnly = await recoverPrSurfaceMutation(surface, {
        id: "intent-3",
        workItemId: "wi-1",
        operationKey: "pr-surface:upsertProgressComment",
        mutationKind: "github.pr_surface.upsertProgressComment",
        status: "pending",
        publishRecordId: null,
        detail: { surfaceMethod: "upsertProgressComment", sentinel: "## PR Agent Review" },
      } satisfies OperationIntentRow);
      expect(sentinelOnly).toEqual({ kind: "absent" });
    });

    it("recovers a marked description body without synthesizing titleUpdated", async () => {
      const marker = operationIntentMarker("description:pr_body:o/r#1", "wi-1");
      const { surface, controls } = createFakePrSurface(surfaceParams);
      controls.setPullRequestBody(`agent block\n${marker}`);
      const recovered = await recoverPrSurfaceMutation(surface, {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: "description:pr_body:o/r#1:surface:publishDescription",
        mutationKind: "github.pr_surface.publishDescription",
        status: "pending",
        publishRecordId: null,
        detail: { surfaceMethod: "publishDescription", operationMarker: marker },
      } satisfies OperationIntentRow);
      expect(recovered).toEqual({
        kind: "reconciled",
        value: { prNumber: 1, bodyUpdated: true },
      });
    });
  });

  it.each(["lightweight", "ordinary_summary", "foreign_lightweight"] as const)(
    "#657 recovers interrupted lightweight publication at the cap (%s)",
    async (mode) => {
      const resourceKey = `${OWNER}/lightweight-recovery-${randomUUID()}#1`;
      const workItemId = await insertAutoQueued(resourceKey, "review");
      const cfg = makeTestConfig({ queue: { retryLimit: 0 } });
      const job = {
        ...makeDurableJobMetadata(workItemId, 0, 0),
        data: { kind: "review" as const, workItemId },
      };
      const boss = new PgBoss(cfg.runtime.databaseUrl);
      vi.spyOn(boss, "send").mockResolvedValue(randomUUID());
      vi.spyOn(boss, "sendDebounced").mockResolvedValue(randomUUID());
      vi.spyOn(boss, "findJobs").mockResolvedValue([]);
      vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
        type: "token",
        tokenType: "installation",
        token: "synthetic-installation-token",
        installationId: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(),
        permissions: {},
        repositorySelection: "all",
      });
      const fake = prSurfaceModule.createFakePrSurface(
        { owner: OWNER, repo: "r", prNumber: 1 },
        { headSha: "h" },
      );
      fake.controls.setChangedFilesResult({
        files: [
          {
            filename: "README.md",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "+Synthetic documentation change",
          },
        ],
        truncated: false,
        omittedCountLowerBound: 0,
        totalChanges: 1,
        headSha: "h",
      });
      vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation((params) =>
        params.mutationBoundary == null
          ? fake.surface
          : prSurfaceModule.withPrSurfaceMutationBoundary(fake.surface, params.mutationBoundary),
      );
      const workspace = vi.spyOn(prWorkspaceModule, "withPrRepositoryView");
      const createVerdict = ownVerdictModule.reviewVerdict;
      let interrupted = false;
      vi.spyOn(ownVerdictModule, "reviewVerdict").mockImplementation((params) => {
        const verdict = createVerdict(params);
        return {
          ...verdict,
          close: async (outcome) => {
            if (!interrupted && params.workItemId === workItemId && outcome.kind === "published") {
              interrupted = true;
              await pool.query(
                "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
                [resourceKey],
              );
              expect(await acquire(resourceKey, workItemId)).toMatchObject({ acquired: true });
              throw new AppError({
                code: "agent_work.pr_actor_lease_lost",
                message: "Synthetic interruption before verdict close",
              });
            }
            return verdict.close(outcome);
          },
        };
      });
      await createWorkDefinitions({
        cfg: cfg,
        pool: pool,
        boss: boss,
        installationSurface: openInstallationSurface(),
      }).review.dispatch(job);
      expect(interrupted).toBe(true);
      expect(await getWorkItem(pool, workItemId)).toMatchObject({
        status: "running",
        attemptCount: 1,
      });
      const summary = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
      const published = fake.controls.events.filter(
        (event) => event.kind === "upsertProgressComment",
      );
      expect(published).toHaveLength(1);
      const stored = await createPublishContext(pool, {
        workItemId,
        resourceKey,
        reviewLens: "review",
      }).completed("summary_comment");
      expect(stored?.lightweightCompletion).toBe(true);
      if (mode === "ordinary_summary") {
        await pool.query(
          "UPDATE publish_records SET detail = detail - 'lightweightCompletion' WHERE work_item_id = $1 AND step = 'summary_comment'",
          [workItemId],
        );
      } else if (mode === "foreign_lightweight") {
        const foreignId = await insertAutoQueued(resourceKey, "review");
        await pool.query("UPDATE agent_work_items SET status = 'completed' WHERE id = $1", [
          foreignId,
        ]);
        await pool.query(
          "UPDATE publish_records SET work_item_id = $2 WHERE work_item_id = $1 AND step = 'summary_comment'",
          [workItemId, foreignId],
        );
      }
      await pool.query(
        "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
        [resourceKey],
      );
      await createWorkDefinitions({
        cfg: cfg,
        pool: pool,
        boss: boss,
        installationSurface: openInstallationSurface(),
      }).review.dispatch({ ...job, id: randomUUID() });
      const expectedStatus = mode === "lightweight" ? "completed" : "failed";
      expect(await getWorkItem(pool, workItemId)).toMatchObject({
        status: expectedStatus,
        attemptCount: 1,
      });
      expect(workspace).not.toHaveBeenCalled();
      if (mode === "lightweight") {
        expect(fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)).toEqual(summary);
        expect(
          fake.controls.events.filter((event) => event.kind === "upsertProgressComment"),
        ).toHaveLength(1);
        expect(fake.controls.events).toContainEqual(
          expect.objectContaining({
            kind: "finishReviewCheck",
            conclusion: "success",
          }),
        );
        expect(fake.controls.reactions.map((reaction) => reaction.kind)).toEqual(["+1"]);
      } else {
        expect(fake.controls.reactions.map((reaction) => reaction.kind)).toEqual(["-1"]);
      }
      const eventCount = fake.controls.events.length;
      await createWorkDefinitions({
        cfg: cfg,
        pool: pool,
        boss: boss,
        installationSurface: openInstallationSurface(),
      }).review.dispatch({ ...job, id: randomUUID() });
      expect(fake.controls.events).toHaveLength(eventCount);
      console.info(
        "lightweight-recovery-evidence",
        JSON.stringify({
          mode,
          status: expectedStatus,
          originalPublications: published.length,
          freshWorkspaceEntries: 0,
        }),
      );
    },
  );

  it.each([
    "published",
    "failed",
    "deterministic",
    "running_resume",
    "admission_gap",
    "rollback",
    "admission_ack_lost",
    "deadlock_retry",
    "memoized",
    "cancel_before_start",
    "takeover_before_start",
    "recovery_at_cap",
    "last_slot",
  ] as const)(
    "#657 retains real retries after committed claim-only crash loops (%s)",
    async (outcome) => {
      const resourceKey = `${OWNER}/budget-${randomUUID()}#1`;
      const workItemId = await insertAutoQueued(resourceKey, "description");
      const cfg = makeTestConfig({ queue: { retryLimit: 2 } });
      const jobs = Array.from({ length: 5 }, () => ({
        ...makeDurableJobMetadata(workItemId, 0, 2),
        id: randomUUID(),
        data: { kind: "description" as const, workItemId },
      }));
      const boss = new PgBoss(cfg.runtime.databaseUrl);
      vi.spyOn(boss, "send").mockResolvedValue(randomUUID());
      vi.spyOn(boss, "findJobs").mockResolvedValue([]);
      const core = await workRepository.getWorkItemCore(pool, workItemId);
      if (core?.type !== "description") throw new Error("missing description core");
      const neutralCycles = ["published", "failed", "deterministic", "rollback"].includes(outcome)
        ? 4
        : 0;
      for (let cycle = 0; cycle < neutralCycles; cycle++) {
        await expect(
          acquireAndClaimWorkItem({
            pool,
            boss,
            queue: "agent-work-description",
            leaseKey: { resourceKey, workType: "description" },
            core,
            ttlSeconds: TTL_SECONDS,
            seededLiveHop: true,
          }),
        ).resolves.toMatchObject({ acquired: true });
        await pool.query(
          `UPDATE pr_actor_leases SET expires_at = now() - interval '1 second'
             WHERE resource_key = $1 AND work_type = 'description'`,
          [resourceKey],
        );
      }
      vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
        type: "token",
        tokenType: "installation",
        token: "synthetic-installation-token",
        installationId: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(),
        permissions: {},
        repositorySelection: "all",
      });
      const fake = prSurfaceModule.createFakePrSurface(
        { owner: OWNER, repo: "r", prNumber: 1 },
        { headSha: "h" },
      );
      vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation((params) =>
        params.mutationBoundary == null
          ? fake.surface
          : prSurfaceModule.withPrSurfaceMutationBoundary(fake.surface, params.mutationBoundary),
      );
      vi.spyOn(prWorkspaceModule, "withPrRepositoryView").mockImplementation(async (_params, run) =>
        run({
          agentCwd: "/tmp/pr-agent",
          workspace: mockLocalPrWorkspace(),
          preflight: { files: [], truncated: false, fileCount: 0, totalChanges: 0 },
        }),
      );
      const failure =
        outcome === "deterministic"
          ? new AppError({ code: "triage.missing_submit", message: "synthetic missing submit" })
          : new Error("synthetic transient feature failure");
      const run = vi.spyOn(descriptionRun, "runFullPrDescription").mockRejectedValue(failure);
      if (outcome === "recovery_at_cap") {
        vi.spyOn(boss, "sendDebounced").mockResolvedValue(randomUUID());
        vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
          userId: 42,
          login: "synthetic[bot]",
        });
        const verificationId = await insertAutoQueued(
          `${resourceKey}-verification`,
          "verification",
        );
        await pool.query("UPDATE agent_work_items SET attempt_count = 3 WHERE id = $1", [
          verificationId,
        ]);
        await createWorkDefinitions({
          cfg: cfg,
          pool: pool,
          boss: boss,
          installationSurface: openInstallationSurface(),
        }).verification.dispatch({
          ...jobs[0],
          data: { kind: "verification", workItemId: verificationId },
        });
        expect(await getWorkItem(pool, verificationId)).toMatchObject({
          status: "completed",
          attemptCount: 3,
        });
        expect(prWorkspaceModule.withPrRepositoryView).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        console.info(
          "budget-survival-evidence",
          JSON.stringify({
            scenario: outcome,
            substantiveInvocations: 0,
            status: "completed",
            publications: 0,
          }),
        );
        return;
      }
      if (outcome === "last_slot") {
        const claim = await acquireAndClaimWorkItem({
          pool,
          boss,
          core,
          queue: "agent-work-description",
          leaseKey: { resourceKey, workType: "description" },
          ttlSeconds: TTL_SECONDS,
          seededLiveHop: true,
        });
        if (!claim?.acquired) throw new Error("missing race lease");
        await pool.query("UPDATE agent_work_items SET attempt_count = 2 WHERE id = $1", [
          workItemId,
        ]);
        const holder = await pool.connect();
        const contenders: Array<ReturnType<typeof workRepository.beginWorkAttempt>> = [];
        try {
          await holder.query("BEGIN");
          const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          await leaseRepository.lockPrActorLeaseForUpdate(holder, workItemId, claim.leaseEpoch);
          contenders.push(
            workRepository.beginWorkAttempt(pool, workItemId, claim.leaseEpoch, 3),
            workRepository.beginWorkAttempt(pool, workItemId, claim.leaseEpoch, 3),
          );
          await expect
            .poll(async () => {
              const blocked = await pool.query<{ count: number }>(
                `WITH RECURSIVE waits(pid) AS (
                 SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
                 UNION
                 SELECT a.pid FROM pg_stat_activity a JOIN waits w ON w.pid = ANY(pg_blocking_pids(a.pid))
               ) SELECT count(*)::int AS count FROM waits`,
                [pid],
              );
              return blocked.rows[0].count;
            })
            .toBe(2);
          await holder.query("COMMIT");
          const results = await Promise.all(contenders);
          expect(results.map((result) => result.kind).toSorted()).toEqual(["exhausted", "started"]);
          for (const result of results) {
            if (result.kind === "started") {
              await expect(
                descriptionRun.runFullPrDescription({
                  cfg,
                  prSurface: fake.surface,
                  owner: OWNER,
                  repo: "r",
                  prNumber: 1,
                  headSha: "h",
                  workspace: mockLocalPrWorkspace(),
                }),
              ).rejects.toBe(failure);
            }
          }
        } finally {
          await holder.query("ROLLBACK");
          holder.release();
          await Promise.allSettled(contenders);
        }
        await pool.query(
          "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
          [resourceKey],
        );
        await createWorkDefinitions({
          cfg: cfg,
          pool: pool,
          boss: boss,
          installationSurface: openInstallationSurface(),
        }).description.dispatch(jobs[1]);
        expect(run).toHaveBeenCalledOnce();
        expect((await getWorkItem(pool, workItemId))?.status).toBe("failed");
        expect(fake.controls.replies).toHaveLength(1);
        console.info(
          "budget-survival-evidence",
          JSON.stringify({
            scenario: outcome,
            substantiveInvocations: 1,
            status: "failed",
            admitted: 1,
            refused: 1,
          }),
        );
        return;
      }
      let firstLaterJob = 0;
      if (outcome === "admission_ack_lost" || outcome === "deadlock_retry") {
        const transact = postgres.inTransaction;
        vi.spyOn(postgres, "inTransaction")
          .mockImplementationOnce(transact)
          .mockImplementationOnce(async (selectedPool, work) => {
            if (outcome === "deadlock_retry") {
              throw Object.assign(new Error("synthetic admission deadlock"), { code: "40P01" });
            }
            await transact(selectedPool, work);
            throw failure;
          });
        if (outcome === "admission_ack_lost") {
          await expect(
            createWorkDefinitions({
              cfg: cfg,
              pool: pool,
              boss: boss,
              installationSurface: openInstallationSurface(),
            }).description.dispatch(jobs[0]),
          ).rejects.toBe(failure);
          expect(prWorkspaceModule.withPrRepositoryView).not.toHaveBeenCalled();
          expect(run).not.toHaveBeenCalled();
          expect(await getWorkItem(pool, workItemId)).toMatchObject({
            status: "queued",
            attemptCount: 1,
          });
          firstLaterJob = 1;
        }
      }
      if (outcome === "rollback") {
        const transact = postgres.inTransaction;
        vi.spyOn(postgres, "inTransaction")
          .mockImplementationOnce(transact)
          .mockImplementationOnce(async (selectedPool, work) =>
            transact(selectedPool, async (client) => {
              await work(client);
              throw failure;
            }),
          );
        await expect(
          createWorkDefinitions({
            cfg: cfg,
            pool: pool,
            boss: boss,
            installationSurface: openInstallationSurface(),
          }).description.dispatch(jobs[0]),
        ).rejects.toBe(failure);
        expect(prWorkspaceModule.withPrRepositoryView).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
      }
      if (
        outcome === "memoized" ||
        outcome === "cancel_before_start" ||
        outcome === "takeover_before_start"
      ) {
        let entered = false;
        let epoch: number | null = null;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const held = runDurableWorkItem({
          contextPolicy: createWorkDefinitions({ cfg, pool, boss }).description.contextPolicy,
          runtime: createDurableRuntime({ installationSurface: openInstallationSurface() }),
          cfg,
          pool,
          boss,
          job: jobs[0],
          type: "description",
          prActorLease: { queue: "agent-work-description" },
          resolveHeadSha: async () => ({ headSha: "h" }),
          execute: async (_item, env) => {
            entered = true;
            epoch = env.leaseEpoch;
            await gate;
            const first = env.beginAttempt();
            expect(env.beginAttempt()).toBe(first);
            await first;
            await descriptionRun.runFullPrDescription({
              cfg,
              prSurface: env.prSurface,
              owner: OWNER,
              repo: "r",
              prNumber: 1,
              headSha: "h",
              workspace: mockLocalPrWorkspace(),
            });
            return { kind: "completed" };
          },
        });
        const settled = held.then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await expect.poll(() => entered).toBe(true);
          if (outcome === "cancel_before_start") {
            await workRepository.markWorkCancelled(pool, workItemId, epoch);
          } else if (outcome === "takeover_before_start") {
            await pool.query(
              "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
              [resourceKey],
            );
            const takeover = await acquireFor(resourceKey, "description", workItemId);
            if (!takeover.acquired) throw new Error("missing takeover");
            release();
            expect(await settled).toBeUndefined();
            expect(await isPrActorLeaseHeld(pool, workItemId, takeover.leaseEpoch)).toBe(true);
            await pool.query(
              "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
              [resourceKey],
            );
          }
          release();
          expect(await settled).toBe(outcome === "memoized" ? failure : undefined);
          if (outcome === "cancel_before_start") {
            expect(await getWorkItem(pool, workItemId)).toMatchObject({
              status: "cancelled",
              attemptCount: 0,
            });
            expect(run).not.toHaveBeenCalled();
            expect(fake.controls.replies).toHaveLength(0);
            console.info(
              "budget-survival-evidence",
              JSON.stringify({
                scenario: outcome,
                substantiveInvocations: 0,
                status: "cancelled",
                cancellationWon: true,
              }),
            );
            return;
          }
          firstLaterJob = outcome === "memoized" ? 1 : 0;
        } finally {
          release();
          await settled;
        }
      }
      if (outcome === "running_resume" || outcome === "admission_gap") {
        const releases: Array<() => void> = [];
        const pending: Promise<void>[] = [];
        const blocked = outcome === "running_resume" ? 3 : 1;
        if (outcome === "running_resume") {
          run.mockImplementation(
            () => new Promise((_, reject) => releases.push(() => reject(failure))),
          );
        } else {
          vi.mocked(prWorkspaceModule.withPrRepositoryView).mockImplementation(
            (_params, _run) => new Promise((_, reject) => releases.push(() => reject(failure))),
          );
        }
        try {
          for (let attempt = 0; attempt < blocked; attempt++) {
            pending.push(
              createWorkDefinitions({
                cfg: cfg,
                pool: pool,
                boss: boss,
                installationSurface: openInstallationSurface(),
              }).description.dispatch(jobs[attempt]),
            );
            await expect.poll(() => releases.length).toBe(attempt + 1);
            await pool.query(
              `UPDATE pr_actor_leases SET expires_at = now() - interval '1 second'
                 WHERE resource_key = $1 AND work_type = 'description'`,
              [resourceKey],
            );
          }
          if (outcome === "admission_gap") {
            vi.mocked(prWorkspaceModule.withPrRepositoryView).mockImplementation(
              async (_params, work) =>
                work({
                  agentCwd: "/tmp/pr-agent",
                  workspace: mockLocalPrWorkspace(),
                  preflight: { files: [], truncated: false, fileCount: 0, totalChanges: 0 },
                }),
            );
            await expect(
              createWorkDefinitions({
                cfg: cfg,
                pool: pool,
                boss: boss,
                installationSurface: openInstallationSurface(),
              }).description.dispatch(jobs[1]),
            ).rejects.toBe(failure);
          }
          const terminal = createWorkDefinitions({
            cfg: cfg,
            pool: pool,
            boss: boss,
            installationSurface: openInstallationSurface(),
          }).description.dispatch(jobs[3]);
          pending.push(terminal);
          await expect
            .poll(async () => (await getWorkItem(pool, workItemId))?.status)
            .toBe("failed");
          await terminal;
          expect(run).toHaveBeenCalledTimes(outcome === "running_resume" ? 3 : 2);
          expect(fake.controls.replies).toHaveLength(1);
        } finally {
          for (const release of releases) release();
          await Promise.allSettled(pending);
        }
        await createWorkDefinitions({
          cfg: cfg,
          pool: pool,
          boss: boss,
          installationSurface: openInstallationSurface(),
        }).description.dispatch(jobs[4]);
        expect(run).toHaveBeenCalledTimes(outcome === "running_resume" ? 3 : 2);
        expect(fake.controls.replies).toHaveLength(1);
        expect((await getWorkItem(pool, workItemId))?.attemptCount).toBe(3);
        console.info(
          "budget-survival-evidence",
          JSON.stringify({
            scenario: outcome,
            substantiveInvocations: run.mock.calls.length,
            status: "failed",
            notices: fake.controls.replies.length,
            takeoverWon: true,
          }),
        );
        return;
      }
      if (outcome === "published") {
        run
          .mockRejectedValueOnce(failure)
          .mockRejectedValueOnce(failure)
          .mockImplementationOnce(async (params) => {
            await params.prSurface.updatePullRequest({
              title: "Synthetic retry success",
              body: "Synthetic acceptance output",
            });
            await params.recordPublishStep?.({ syntheticAcceptance: true });
            return {
              published: true,
              publishSuperseded: false,
              lastAssistant: assistantFromText(cfg, "", cfg.models.provider),
            };
          });
      }
      const attempts = outcome === "deterministic" ? 2 : 3;
      const invocations = outcome === "admission_ack_lost" ? 2 : attempts;
      for (let attempt = firstLaterJob; attempt < attempts; attempt++) {
        const dispatch = createWorkDefinitions({
          cfg: cfg,
          pool: pool,
          boss: boss,
          installationSurface: openInstallationSurface(),
        }).description.dispatch(jobs[attempt]);
        const result = await dispatch.then(
          () => undefined,
          (error: unknown) => error,
        );
        if (run.mock.calls.length === 0) {
          const item = await getWorkItem(pool, workItemId);
          console.info(
            `budget-survival-evidence outcome=${outcome} substantiveInvocations=0 status=${item?.status}`,
          );
        }
        if (attempt < attempts - 1) expect(result).toBe(failure);
        else expect(result).toBeUndefined();
        if (outcome === "deterministic" && attempt === 0) {
          await expect(
            acquireAndClaimWorkItem({
              pool,
              boss,
              core,
              queue: "agent-work-description",
              leaseKey: { resourceKey, workType: "description" },
              ttlSeconds: TTL_SECONDS,
              seededLiveHop: true,
            }),
          ).resolves.toMatchObject({ acquired: true });
          await pool.query(
            "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
            [resourceKey],
          );
        }
      }
      expect(run).toHaveBeenCalledTimes(invocations);
      expect((await getWorkItem(pool, workItemId))?.status).toBe(
        outcome === "published" ? "completed" : "failed",
      );
      expect(fake.controls.replies).toHaveLength(outcome === "published" ? 0 : 1);
      const publications = fake.controls.events.filter(
        (event) => event.kind === "updatePullRequest",
      ).length;
      expect(publications).toBe(outcome === "published" ? 1 : 0);
      console.info(
        "budget-survival-evidence",
        JSON.stringify({
          scenario: outcome,
          neutralCycles: neutralCycles + (outcome === "deterministic" ? 1 : 0),
          substantiveInvocations: run.mock.calls.length,
          publications,
          status: outcome === "published" ? "completed" : "failed",
          takeoverWon: outcome === "takeover_before_start",
        }),
      );
      await createWorkDefinitions({
        cfg: cfg,
        pool: pool,
        boss: boss,
        installationSurface: openInstallationSurface(),
      }).description.dispatch(jobs[4]);
      expect(run).toHaveBeenCalledTimes(invocations);
      expect(fake.controls.replies).toHaveLength(outcome === "published" ? 0 : 1);
    },
  );

  it.each(["live", "child_result", "local_gate", "unknown"] as const)(
    "own verdict real leased boundary preserves %s on a constrained pool",
    async (mode) => {
      const scopedPool = new Pool({ ...pool.options, max: 2, connectionTimeoutMillis: 1500 });
      const resourceKey = `${OWNER}/own-verdict-${randomUUID()}#1`;
      const workItemId = await insertAutoQueued(resourceKey, "review");
      const boss = new PgBoss(makeTestConfig().runtime.databaseUrl);
      const fake = prSurfaceModule.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      const finish = vi.spyOn(fake.surface, "finishReviewCheck");
      if (mode === "unknown") finish.mockRejectedValueOnce(new Error("synthetic unknown response"));
      vi.spyOn(boss, "send").mockResolvedValue(randomUUID());
      vi.spyOn(boss, "findJobs").mockResolvedValue([]);
      vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
        type: "token",
        tokenType: "installation",
        token: "synthetic-installation-token",
        installationId: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(),
        permissions: {},
        repositorySelection: "all",
      });
      vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation((params) =>
        params.mutationBoundary == null
          ? fake.surface
          : prSurfaceModule.withPrSurfaceMutationBoundary(fake.surface, params.mutationBoundary),
      );
      const merge = intentRepository.mergeOperationIntentDetail;
      let armed = false;
      let injected = false;
      vi.spyOn(intentRepository, "mergeOperationIntentDetail").mockImplementation(
        async (...args) => {
          if (
            mode === "child_result" &&
            !injected &&
            args[1].operationKey.startsWith("review:check_run_close:") &&
            !args[1].operationKey.includes(":surface:") &&
            Object.hasOwn(args[1].detail, "__result")
          ) {
            injected = true;
            throw new Error("synthetic parent result stash failure");
          }
          const result = await merge(...args);
          if (
            args[1].operationKey.includes(":surface:finishReviewCheck:") &&
            args[1].detail.__mutating === true
          )
            armed = true;
          return result;
        },
      );
      const skip = workRepository.shouldSkipWork;
      vi.spyOn(workRepository, "shouldSkipWork").mockImplementation(async (...args) => {
        if (mode === "local_gate" && armed && !injected) {
          injected = true;
          throw new Error("synthetic final local gate failure");
        }
        return skip(...args);
      });
      const now = new Date();
      const job: DurableJobSpec<"review">["job"] = {
        id: randomUUID(),
        name: "review",
        data: { workItemId },
        signal: new AbortController().signal,
        expireInSeconds: 600,
        heartbeatSeconds: null,
        priority: 0,
        state: "active",
        retryLimit: 2,
        retryCount: 0,
        retryDelay: 0,
        retryBackoff: false,
        startAfter: now,
        startedOn: now,
        singletonKey: null,
        singletonOn: null,
        deleteAfterSeconds: 600,
        createdOn: now,
        completedOn: null,
        keepUntil: now,
        policy: "standard",
        heartbeatOn: null,
        blocked: false,
        blocking: false,
        pendingDependencies: 0,
        deadLetter: "",
        output: {},
        sourceName: null,
        sourceId: null,
        sourceCreatedOn: null,
        sourceRetryCount: null,
        sourceOutput: null,
        sourceRootId: null,
      };
      try {
        await recordReviewCheckRun(scopedPool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          githubId: 111,
          detail: { status: "in_progress" },
        });
        await runDurableWorkItem({
          contextPolicy: createWorkDefinitions({ cfg: makeTestConfig(), pool: scopedPool, boss })
            .review.contextPolicy,
          runtime: createDurableRuntime({ installationSurface: openInstallationSurface() }),
          cfg: makeTestConfig(),
          pool: scopedPool,
          boss,
          type: "review",
          prActorLease: { queue: "review" },
          job,
          resolveHeadSha: async () => ({ headSha: "h" }),
          execute: async (_item, env) => {
            await reviewVerdict({
              pool: scopedPool,
              prSurface: env.prSurface,
              owner: OWNER,
              repo: "r",
              prNumber: 1,
              workItemId,
              resourceKey,
              reviewLens: "review",
              headSha: "h",
              leaseEpoch: env.leaseEpoch,
              commitStatusEnabled: false,
            }).close({ kind: "published", findings: [{ severity: "P1" }], summary: "winner" });
            return { kind: "completed" };
          },
        });
        if (mode === "local_gate") expect(finish).not.toHaveBeenCalled();
        else expect(finish).toHaveBeenCalledOnce();
        await reviewVerdict({
          pool: scopedPool,
          prSurface: fake.surface,
          owner: OWNER,
          repo: "r",
          prNumber: 1,
          workItemId,
          resourceKey,
          reviewLens: "review",
          headSha: "h",
          leaseEpoch: null,
          commitStatusEnabled: false,
        }).close({ kind: "cancelled" });
        expect(finish).toHaveBeenCalledOnce();
        expect(finish).toHaveBeenCalledWith(
          expect.objectContaining({ conclusion: "failure", summary: "winner" }),
        );
        const result = await scopedPool.query(
          "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
          [workItemId],
        );
        expect(result.rows[0].detail.status).toBe(mode === "unknown" ? "in_progress" : "completed");
        if (mode === "local_gate" || mode === "child_result") expect(injected).toBe(true);
      } finally {
        await scopedPool.end();
      }
    },
  );

  it.each([
    "late_cancel",
    "legacy_cancel",
    "request_cancel",
    "live",
    "read_failure",
    "remote_failure",
    "takeover",
    "replacement_claim_cancel",
    "replacement_running_cancel",
    "replacement_send_cancel_662",
    "replacement_running_send_cancel_662",
    "replacement_late_hop_cancel_662",
  ])("fences durable publication during %s (#640, #661)", async (mode) => {
    const realQueue = mode.endsWith("_662");
    const runningSend = mode === "replacement_running_send_cancel_662";
    const lateHop = mode === "replacement_late_hop_cancel_662";
    const resourceKey = `${OWNER}/cancel-publish-${randomUUID()}#1`;
    let workItemId = await insertAutoQueued(resourceKey, "review");
    let replacementParent: ReviewWorkItem | undefined;
    const replacementError = new Error("parent failed before enqueue");
    if (mode.startsWith("replacement_")) {
      const parentId = workItemId;
      const parentLease = await acquire(resourceKey, parentId);
      if (!parentLease.acquired) throw new Error("expected parent lease");
      await claimWorkForExecution(pool, parentId, parentLease.leaseEpoch);
      const parent = await getWorkItem(pool, parentId);
      if (parent?.type !== "review") throw new Error("expected parent review");
      workItemId = (await createReviewRescheduleWorkItem(pool, parent, parentLease.leaseEpoch))
        .replacementWorkItemId;
      const persisted = await getWorkItem(pool, parentId);
      if (persisted?.type !== "review") throw new Error("expected persisted parent review");
      replacementParent = persisted;
      await markWorkFailed(pool, parentId, replacementError, parentLease.leaseEpoch);
      await releasePrActorLease(pool, {
        resourceKey,
        workType: "review",
        leaseEpoch: parentLease.leaseEpoch,
      });
    }
    const controller = new AbortController();
    const cfg = makeTestConfig();
    const boss = realQueue
      ? await createStartedBoss(
          makeTestConfig({ runtime: { databaseUrl: process.env.DATABASE_URL!, role: "web" } }),
        )
      : new PgBoss(cfg.runtime.databaseUrl);
    if (realQueue) await ensureAgentQueues(boss, cfg);
    const surfaces: ReturnType<typeof prSurfaceModule.createFakePrSurface>[] = [];
    let executing = false;
    let checkpointArmed = false;
    let checkpointUsed = false;
    let finalRead = false;
    let successorId: string | undefined;
    let releaseObserver: (() => void) | undefined;
    const held = leaseRepository.isPrActorLeaseHeld;
    const assertHeld = leaseRepository.assertPrActorLeaseHeld;
    const mergeDetail = intentRepository.mergeOperationIntentDetail;
    const skipWork = workRepository.shouldSkipWork;
    const claimWork = workRepository.claimWorkForExecution;
    let releaseClaim: (() => void) | undefined;
    const claimCommit = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimedReady: (() => void) | undefined;
    const claimReady = new Promise<void>((resolve) => {
      claimedReady = resolve;
    });
    let claimantPid: number | undefined;
    let cancellation: Promise<unknown> | undefined;
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendCommitted!: () => void;
    const committedSend = new Promise<void>((resolve) => {
      sendCommitted = resolve;
    });
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let publicationReady!: () => void;
    const beforePublication = new Promise<void>((resolve) => {
      publicationReady = resolve;
    });
    let pendingSend: Promise<string | null> | undefined;
    if (mode === "replacement_claim_cancel") {
      vi.spyOn(workRepository, "claimWorkForExecution").mockImplementation(async (...args) => {
        const result = await claimWork(...args);
        if (args[1] === workItemId) {
          const { rows } = await args[0].query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          claimantPid = rows[0]?.pid;
          claimedReady?.();
          await claimCommit;
        }
        return result;
      });
    }
    const observerReady = new Promise<void>((resolve) => {
      releaseObserver = resolve;
      vi.spyOn(leaseRepository, "isPrActorLeaseHeld").mockImplementation(async (...args) => {
        const result = await held(...args);
        if (executing) resolve();
        return result;
      });
    });

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(evlog, "logInfo").mockImplementation(() => {});
    vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
    vi.spyOn(evlog, "logError").mockImplementation(() => {});
    if (!realQueue) {
      vi.spyOn(boss, "send").mockResolvedValue(randomUUID());
      vi.spyOn(boss, "findJobs").mockResolvedValue([]);
    } else if (!lateHop) {
      const send = boss.send.bind(boss);
      vi.spyOn(boss, "send").mockImplementation(async (...args) => {
        const id = await send(...args);
        if (args[2]?.id === workItemId) {
          sendCommitted();
          await sendGate;
        }
        return id;
      });
    }
    vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
      type: "token",
      tokenType: "installation",
      token: "synthetic-installation-token",
      installationId: 1,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
      permissions: {},
      repositorySelection: "all",
    });
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation((params) => {
      if (mode === "remote_failure") {
        const fake = prSurfaceModule.createFakePrSurface(params, { headSha: "h" });
        vi.spyOn(fake.surface, "publishThreadBatch").mockRejectedValueOnce(
          new Error("Synthetic ambiguous remote failure"),
        );
        surfaces.push(fake);
        return params.mutationBoundary == null
          ? fake.surface
          : prSurfaceModule.withPrSurfaceMutationBoundary(fake.surface, params.mutationBoundary);
      }
      const fake = prSurfaceModule.createFakePrSurface(params, {
        headSha: "h",
        mutationBoundary: params.mutationBoundary,
      });
      surfaces.push(fake);
      return fake.surface;
    });
    vi.spyOn(intentRepository, "mergeOperationIntentDetail").mockImplementation(async (...args) => {
      const result = await mergeDetail(...args);
      if (!checkpointUsed && args[1].detail.__mutating === true) checkpointArmed = true;
      return result;
    });
    vi.spyOn(leaseRepository, "assertPrActorLeaseHeld").mockImplementation(async (...args) => {
      await assertHeld(...args);
      if (!checkpointArmed) return;
      checkpointArmed = false;
      checkpointUsed = true;
      finalRead = true;
      if (mode === "late_cancel" || mode === "legacy_cancel") {
        await inTransaction(pool, (client) =>
          cancelActiveReviews(client, resourceKey, { kind: "user", login: "cancel-test" }),
        );
      } else if (mode === "request_cancel") {
        await inTransaction(pool, (client) =>
          replaceActiveAutoWorkItem({
            client,
            target: { kind: "review", resourceKey },
            createWorkItem: async () => {
              const replacementId = randomUUID();
              await client.query(
                `INSERT INTO agent_work_items
                   (id, type, source, status, owner, repo, pr_number, installation_id,
                    head_sha, review_lens, resource_key, payload)
                   VALUES ($1, 'review', 'auto', 'queued', $2, 'r', 1, 1, 'h', 'review', $3,
                           '{"mode":"review","source":"auto"}'::jsonb)`,
                [replacementId, OWNER, resourceKey],
              );
              return replacementId;
            },
          }),
        );
        const requested = await getWorkItem(pool, workItemId);
        expect(requested?.status).toBe("running");
        expect(requested?.cancelRequestedAt).not.toBeNull();
      }
      if (mode === "legacy_cancel" || mode === "request_cancel") {
        expect((await getLeaseRow(resourceKey)).work_item_id).toBe(workItemId);
      }
    });
    vi.spyOn(workRepository, "shouldSkipWork").mockImplementation(async (...args) => {
      const skipped = await skipWork(...args);
      if (!finalRead) return skipped;
      finalRead = false;
      if (mode === "read_failure") throw new Error("Synthetic final cancellation read failure");
      if (mode === "takeover") {
        expect(skipped).toBe(false);
        await pool.query(
          "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
          [resourceKey],
        );
        successorId = await insertAutoQueued(resourceKey, "review");
        const successor = await acquire(resourceKey, successorId);
        if (!successor.acquired) throw new Error("expected successor acquisition");
        await claimWorkForExecution(pool, successorId, successor.leaseEpoch);
      }
      return skipped;
    });

    const now = new Date();
    let spec: DurableJobSpec<"review"> = {
      contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
      runtime: createDurableRuntime({ installationSurface: openInstallationSurface() }),
      cfg,
      pool,
      boss,
      type: "review",
      prActorLease: { queue: realQueue ? REVIEW_QUEUE : "review" },
      job: {
        id: randomUUID(),
        name: realQueue ? REVIEW_QUEUE : "review",
        data: { workItemId },
        signal: controller.signal,
        expireInSeconds: 600,
        heartbeatSeconds: null,
        priority: 0,
        state: "active",
        retryLimit: 2,
        retryCount: 0,
        retryDelay: 0,
        retryBackoff: false,
        startAfter: now,
        startedOn: now,
        singletonKey: null,
        singletonOn: null,
        deleteAfterSeconds: 600,
        createdOn: now,
        completedOn: null,
        keepUntil: now,
        policy: "standard",
        heartbeatOn: null,
        blocked: false,
        blocking: false,
        pendingDependencies: 0,
        deadLetter: "",
        output: {},
        sourceName: null,
        sourceId: null,
        sourceCreatedOn: null,
        sourceRetryCount: null,
        sourceOutput: null,
        sourceRootId: null,
      },
      resolveHeadSha: async () => ({ headSha: "h" }),
      execute: async (item, env) => {
        executing = true;
        await observerReady;
        if (runningSend) {
          publicationReady();
          await publicationGate;
        }
        if (mode === "replacement_claim_cancel") await cancellation;
        if (mode === "replacement_running_cancel") {
          if (!replacementParent) throw new Error("expected replacement parent");
          await cancelPendingStaleHeadReplacement(pool, replacementParent, replacementError);
        }
        if (mode === "legacy_cancel" || mode === "request_cancel") {
          await pool.query("UPDATE agent_work_items SET execution_epoch = 0 WHERE id = $1", [
            workItemId,
          ]);
        }
        const batch = await env.prSurface.publishThreadBatch({
          body: "Synthetic review output",
          event: "COMMENT",
          commitId: "h",
        });
        await createPublishContext(pool, {
          workItemId,
          resourceKey: item.resourceKey,
          reviewLens: "review",
          step: "inline_review",
          githubId: batch.reviewId,
          leaseEpoch: env.leaseEpoch,
          detail: {
            batchId: "cancel-race-batch",
            workItemId,
            specialist: "correctness",
            reviewId: batch.reviewId,
            fingerprints: [],
            placements: [],
          },
        }).record();
        return { kind: "completed" };
      },
      onCancelled: async (_item, surface) => {
        await surface.finishReviewCheck({
          checkRunId: 1,
          conclusion: "cancelled",
          summary: "Cancelled",
        });
      },
    };
    let settled: Promise<unknown> | undefined;
    try {
      if (realQueue && !runningSend) {
        if (!replacementParent) throw new Error("expected replacement parent");
        if (!lateHop) {
          pendingSend = boss.send(REVIEW_QUEUE, { kind: "review", workItemId }, { id: workItemId });
          await committedSend;
        }
        await cancelPendingStaleHeadReplacement(pool, replacementParent, replacementError);
        if (lateHop) {
          await armLeaseWatchdogHop(boss, {
            queue: REVIEW_QUEUE,
            data: { workItemId },
            singletonKey: workItemId,
            groupId: installationGroupId(1),
            workItemId,
            onSendFailure: "throw",
          });
        } else {
          releaseSend();
          await pendingSend;
        }
        const [delivery] = await boss.findJobs<{ workItemId: string }>(REVIEW_QUEUE, {
          data: { workItemId },
        });
        if (!delivery) throw new Error("expected real replacement delivery");
        spec = { ...spec, job: { ...delivery, signal: controller.signal } };
      }
      const runner = runDurableWorkItem(spec);
      settled = runner.then(
        () => null,
        (error: unknown) => error,
      );
      if (runningSend) {
        await beforePublication;
        if (!replacementParent) throw new Error("expected replacement parent");
        pendingSend = boss.send(REVIEW_QUEUE, { kind: "review", workItemId }, { id: workItemId });
        await committedSend;
        await cancelPendingStaleHeadReplacement(pool, replacementParent, replacementError);
        releaseSend();
        await pendingSend;
        releasePublication();
      }
      if (mode === "replacement_claim_cancel") {
        await claimReady;
        if (!replacementParent || claimantPid == null)
          throw new Error("expected claimed replacement");
        cancellation = cancelPendingStaleHeadReplacement(
          pool,
          replacementParent,
          replacementError,
        ).then(
          () => null,
          (error: unknown) => error,
        );
        await expect
          .poll(async () => {
            const { rows } = await pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database()
                  AND $1::int = ANY(pg_blocking_pids(pid))
             ) AS blocked`,
              [claimantPid],
            );
            return rows[0]?.blocked;
          })
          .toBe(true);
        releaseClaim?.();
        await cancellation;
      }
      const error = await settled;
      if (mode === "read_failure") {
        expect(error).toMatchObject({ message: "Synthetic final cancellation read failure" });
      } else if (mode === "remote_failure") {
        expect(error).toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });
      } else {
        expect(error).toBeNull();
      }
      const row = await getWorkItem(pool, workItemId);
      const terminal = await pool.query<{ completed_at: Date | null; last_error: string | null }>(
        "SELECT completed_at, last_error FROM agent_work_items WHERE id = $1",
        [workItemId],
      );
      const events = surfaces.flatMap(({ controls }) => controls.events);
      const batches = surfaces.flatMap(({ controls }) => controls.threadBatches);
      const records = await pool.query(
        "SELECT github_id FROM publish_records WHERE work_item_id = $1 AND step = 'inline_review' AND status = 'completed'",
        [workItemId],
      );
      if (mode.startsWith("replacement_")) {
        console.info(
          "replacement-cancel-evidence",
          JSON.stringify({
            scenario: mode,
            status: row?.status,
            featureBatches: batches.length,
            completedPublications: records.rows.length,
            cancelRequested: row?.cancelRequestedAt != null,
          }),
        );
      }
      if (mode === "live") {
        expect(batches).toHaveLength(1);
        expect(records.rows).toHaveLength(1);
        expect(row?.status).toBe("completed");
      } else {
        expect(batches).toHaveLength(0);
        expect(events.some((event) => event.kind === "publishThreadBatch")).toBe(false);
        expect(records.rows).toHaveLength(0);
        expect(
          events.some(
            (event) => event.kind === "setAcknowledgementReaction" && event.reaction === "+1",
          ),
        ).toBe(false);
        if (mode === "takeover") {
          expect((await getLeaseRow(resourceKey)).work_item_id).toBe(successorId);
          expect((await getWorkItem(pool, successorId ?? ""))?.status).toBe("running");
          expect(row?.status).toBe("running");
        } else if (mode === "read_failure" || mode === "remote_failure") {
          expect(row?.status).toBe("queued");
        } else {
          expect(row?.status).toBe("cancelled");
          expect(row?.cancelRequestedAt).not.toBeNull();
          expect(terminal.rows[0]?.completed_at).not.toBeNull();
          if (mode.startsWith("replacement_")) {
            if (cancellation) expect(await cancellation).toBeNull();
            expect(terminal.rows[0]?.last_error).toBe(replacementError.message);
            expect(evlog.logError).not.toHaveBeenCalledWith(
              "agent_work_replacement_cancel_failed",
              expect.anything(),
              expect.anything(),
            );
          } else if (mode !== "request_cancel") {
            expect(terminal.rows[0]?.last_error).toBe("Cancelled by slash /cancel");
            if (row?.type === "review") {
              expect(row.payload.cancelAttribution).toEqual({
                kind: "user",
                login: "cancel-test",
              });
            }
          }
          if (mode !== "late_cancel" && mode !== "replacement_claim_cancel" && !realQueue) {
            expect(events.some((event) => event.kind === "finishReviewCheck")).toBe(true);
          }
        }
      }
      if (mode === "read_failure" || mode === "remote_failure") {
        const retried = runDurableWorkItem(spec);
        await expect(retried).resolves.toBeUndefined();
        const retryBatches = surfaces.flatMap(({ controls }) => controls.threadBatches);
        const retryRecords = await pool.query(
          "SELECT id FROM publish_records WHERE work_item_id = $1 AND step = 'inline_review' AND status = 'completed'",
          [workItemId],
        );
        if (mode === "read_failure") {
          expect((await getWorkItem(pool, workItemId))?.status).toBe("completed");
          expect(retryBatches).toHaveLength(1);
          expect(retryRecords.rows).toHaveLength(1);
        } else {
          expect((await getWorkItem(pool, workItemId))?.status).toBe("failed");
          expect(retryBatches).toHaveLength(0);
          expect(retryRecords.rows).toHaveLength(0);
          expect(
            surfaces.flatMap(({ surface }) => vi.mocked(surface.publishThreadBatch).mock.calls),
          ).toHaveLength(1);
        }
        console.info(
          "cancel-publication-retry-evidence",
          JSON.stringify({
            scenario: mode,
            status: (await getWorkItem(pool, workItemId))?.status,
            featureBatches: retryBatches.length,
            completedPublications: retryRecords.rows.length,
          }),
        );
      }
      if (mode === "live" || mode.endsWith("cancel") || realQueue) {
        const count = events.length;
        await runDurableWorkItem(spec);
        expect(surfaces.flatMap(({ controls }) => controls.events)).toHaveLength(count);
        expect((await getWorkItem(pool, workItemId))?.status).toBe(row?.status);
        const replayRecords = await pool.query(
          "SELECT id FROM publish_records WHERE work_item_id = $1 AND step = 'inline_review' AND status = 'completed'",
          [workItemId],
        );
        expect(replayRecords.rows).toHaveLength(records.rows.length);
      }
      console.info(
        "cancel-publication-evidence",
        JSON.stringify({
          scenario: mode,
          status: row?.status,
          completed: terminal.rows[0]?.completed_at != null,
          cancelRequested: row?.cancelRequestedAt != null,
          featureBatches: batches.length,
          completedPublications: records.rows.length,
          cancelledCheck: events.some((event) => event.kind === "finishReviewCheck"),
        }),
      );
    } finally {
      releaseClaim?.();
      releaseObserver?.();
      releaseSend();
      releasePublication();
      controller.abort();
      await cancellation;
      await pendingSend;
      await settled;
      vi.restoreAllMocks();
      vi.useRealTimers();
      if (realQueue) {
        const jobs = await boss.findJobs(REVIEW_QUEUE, { data: { workItemId } });
        if (jobs.length)
          await boss.deleteJob(
            REVIEW_QUEUE,
            jobs.map(({ id }) => id),
          );
        await stopBoss(boss, cfg.queue.shutdownDrainTimeoutSeconds * 1000);
      }
    }
  });

  it.each(["missing", "completed", "failed", "superseded"])(
    "signals a genuine replacement cancellation miss for %s (#661)",
    async (status) => {
      const resourceKey = `${OWNER}/cancel-miss-${randomUUID()}#1`;
      const parentId = await insertAutoQueued(resourceKey, "review");
      const parent = await getWorkItem(pool, parentId);
      if (parent?.type !== "review") throw new Error("expected review parent");
      const targetId =
        status === "missing" ? randomUUID() : await insertAutoQueued(resourceKey, "review");
      if (status !== "missing") {
        await pool.query("UPDATE agent_work_items SET status = $2 WHERE id = $1", [
          targetId,
          status,
        ]);
      }
      await pool.query("UPDATE agent_work_items SET payload = payload || $2::jsonb WHERE id = $1", [
        parentId,
        JSON.stringify({
          staleHeadReplacement: { replacementWorkItemId: targetId, state: "pending-enqueue" },
        }),
      ]);
      const signal = vi.spyOn(evlog, "logError").mockImplementation(() => {});
      await expect(
        cancelPendingStaleHeadReplacement(pool, parent, new Error("parent terminal")),
      ).rejects.toMatchObject({ code: "agent_work.replacement_cancel_rejected" });
      expect(signal).toHaveBeenCalledWith(
        "agent_work_replacement_cancel_failed",
        expect.objectContaining({ workItemId: parentId, replacementWorkItemId: targetId }),
        expect.objectContaining({ code: "agent_work.replacement_cancel_rejected" }),
      );
      expect((await getWorkItem(pool, targetId))?.status).toBe(
        status === "missing" ? undefined : status,
      );
      console.info(
        "replacement-cancel-miss-evidence",
        JSON.stringify({
          scenario: status,
          errorLevel: "error",
          code: "agent_work.replacement_cancel_rejected",
        }),
      );
    },
  );
  describe("worker shutdown terminal marks (#643)", () => {
    let diagnosticsBoss: PgBoss;
    let databaseUrl: string;

    beforeAll(async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is required for integration tests");
      databaseUrl = url;
      // pg-boss schema/queues are not app migrations: a real started boss must
      // install them before the lost-running diagnostics can read pgboss.job.
      diagnosticsBoss = await bossModule.createStartedBoss(
        makeTestConfig({ runtime: { databaseUrl, role: "web" } }),
      );
      await bossModule.ensureAgentQueues(diagnosticsBoss, makeTestConfig());
    });

    afterAll(async () => {
      await bossModule.stopBoss(diagnosticsBoss, 1_000);
    });

    type ShutdownScenario = {
      readonly workItemId: string;
      readonly resourceKey: string;
      readonly cfg: ReturnType<typeof makeTestConfig>;
      readonly releaseReason: "durableReserve" | "poolEnd";
      readonly events: readonly string[];
      readonly warnings: readonly string[];
      readonly markError: unknown;
      readonly dispatchError: unknown;
    };

    async function runShutdownMarkScenario(options: {
      readonly releaseMarkOn: "durableReserve" | "poolEnd";
    }): Promise<ShutdownScenario> {
      const resourceKey = `${OWNER}/shutdown-${randomUUID()}#1`;
      const workItemId = await insertAutoQueued(resourceKey, "review");
      const cfg = makeTestConfig({ runtime: { role: "worker", databaseUrl } });

      const handlers = new Map<string, (jobs: readonly unknown[]) => Promise<void>>();
      const controlledBoss = {
        work: vi.fn(
          async (
            queue: string,
            _options: unknown,
            handler: (jobs: readonly unknown[]) => Promise<void>,
          ) => {
            handlers.set(queue, handler);
            return "worker-id";
          },
        ),
        offWork: vi.fn(async () => undefined),
        send: vi.fn(async () => randomUUID()),
        findJobs: vi.fn(async () => []),
      };

      const events: string[] = [];
      const warnings: string[] = [];
      let reserveStartedResolve: () => void = () => undefined;
      const reserveStarted = new Promise<void>((resolve) => {
        reserveStartedResolve = resolve;
      });
      let poolEndedResolve: () => void = () => undefined;
      const poolEnded = new Promise<void>((resolve) => {
        poolEndedResolve = resolve;
      });

      // Observation only: every wrapper below calls through to the real
      // implementation without delaying it, changing membership, or reordering
      // the production finalizers.
      const realCreateExecutionTracker = executionTrackerModule.createExecutionTracker;
      vi.spyOn(executionTrackerModule, "createExecutionTracker").mockImplementation(() => {
        const tracker = realCreateExecutionTracker();
        return {
          track: tracker.track,
          settle: (timeoutMs: number, settleOptions?: { durableOnly?: boolean }) => {
            if (settleOptions?.durableOnly) {
              events.push("settle:durable");
              reserveStartedResolve();
            }
            return tracker.settle(timeoutMs, settleOptions);
          },
        };
      });
      const realCreatePgPool = postgres.createPgPool;
      vi.spyOn(postgres, "createPgPool").mockImplementation((poolCfg) => {
        const executionPool = realCreatePgPool(poolCfg);
        const realEnd = executionPool.end.bind(executionPool);
        executionPool.end = async () => {
          await realEnd();
          events.push("pool.end");
          poolEndedResolve();
        };
        return executionPool;
      });
      vi.spyOn(bossModule, "createStartedBoss").mockResolvedValue(
        controlledBoss as unknown as PgBoss,
      );
      vi.spyOn(bossModule, "ensureAgentQueues").mockResolvedValue(undefined);
      vi.spyOn(bossModule, "stopBoss").mockImplementation(async () => {
        events.push("boss.stop");
      });

      // Startup-only stubs: no unrelated diagnostics, retention, workspace, or
      // health work may run beside the scenario. The diagnostics and lost-running
      // spies are restored after disposal so the recovery proof below runs the
      // real functions.
      const diagnosticsSpy = vi
        .spyOn(workerHealthModule, "collectQueueDiagnostics")
        .mockResolvedValue({
          at: new Date().toISOString(),
          queues: [],
          deadLetters: [],
          oldestRunningWorkItemAgeMs: null,
          staleQueuedWorkItems: [],
          lostRunningWorkItems: [],
        });
      vi.spyOn(workerHealthModule, "logQueueDiagnosticsReport").mockImplementation(() => undefined);
      vi.spyOn(workerHealthModule, "startPeriodicQueueDiagnostics").mockReturnValue({
        stop: () => undefined,
      });
      vi.spyOn(workerHealthModule, "startWorkerHealthServer").mockReturnValue({
        close: async () => undefined,
      } as never);
      const reconcileSpy = vi
        .spyOn(lostRunningModule, "reconcileLostRunningWork")
        .mockResolvedValue(undefined);
      vi.spyOn(projectionRepairModule, "scanProjectionRepairPending").mockResolvedValue({
        pendingScanned: 0,
        enqueued: 0,
        unreachable: 0,
        skippedNoInstallation: 0,
      });
      vi.spyOn(retentionModule, "ensureRetentionSchedule").mockResolvedValue(undefined);
      vi.spyOn(localPrWorkspaceModule, "cleanupStaleLocalPrWorkspaces").mockResolvedValue(
        undefined,
      );

      vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
        type: "token",
        tokenType: "installation",
        token: "synthetic-installation-token",
        installationId: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(),
        permissions: {},
        repositorySelection: "all",
      });
      vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(
        (params) =>
          prSurfaceModule.createFakePrSurface(params, {
            headSha: "h",
            mutationBoundary: params.mutationBoundary,
          }).surface,
      );
      vi.spyOn(evlog, "logWarn").mockImplementation((event: string) => {
        warnings.push(event);
      });

      // Gate the genuine terminal mark after its real ownership/cancellation
      // prechecks, then invoke the unchanged original SQL on release.
      let markEnteredResolve: () => void = () => undefined;
      const markEntered = new Promise<void>((resolve) => {
        markEnteredResolve = resolve;
      });
      let releaseMark: () => void = () => undefined;
      const markGate = new Promise<void>((resolve) => {
        releaseMark = resolve;
      });
      let markError: unknown;
      const realMarkCompleted = workRepository.markWorkCompleted;
      vi.spyOn(workRepository, "markWorkCompleted").mockImplementation(async (...args) => {
        if (args[1] !== workItemId) return realMarkCompleted(...args);
        markEnteredResolve();
        await markGate;
        try {
          const marked = await realMarkCompleted(...args);
          events.push("mark.completed");
          return marked;
        } catch (error) {
          markError = error;
          events.push("mark.failed");
          throw error;
        }
      });

      vi.spyOn(reviewExecutorModule, "createReviewWorkExecution").mockReturnValue({
        execute: async () => ({ kind: "completed" }),
      });

      const controller = new AbortController();
      const fiber = Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.launch(agentWorkWorkerLive(cfg));
            yield* Effect.never;
          }),
        ),
      );
      type DispatchOutcome = { ok: true } | { ok: false; error: unknown };
      let dispatchOutcome: Promise<DispatchOutcome> | undefined;
      let disposed: Promise<void> | undefined;
      let dispatchError: unknown;
      let releaseReason: "durableReserve" | "poolEnd" = "poolEnd";
      try {
        await vi.waitFor(
          () => {
            expect(handlers.has(REVIEW_QUEUE)).toBe(true);
          },
          { timeout: 10_000 },
        );

        const now = new Date();
        const job = {
          id: randomUUID(),
          name: REVIEW_QUEUE,
          data: { kind: "review", workItemId },
          signal: controller.signal,
          expireInSeconds: 600,
          heartbeatSeconds: null,
          priority: 0,
          state: "active",
          retryLimit: 2,
          retryCount: 0,
          retryDelay: 0,
          retryBackoff: false,
          startAfter: now,
          startedOn: now,
          singletonKey: null,
          singletonOn: null,
          deleteAfterSeconds: 600,
          createdOn: now,
          completedOn: null,
          keepUntil: now,
          policy: "standard",
          heartbeatOn: null,
          blocked: false,
          blocking: false,
          pendingDependencies: 0,
          deadLetter: "",
          output: {},
          sourceName: null,
          sourceId: null,
          sourceCreatedOn: null,
          sourceRetryCount: null,
          sourceOutput: null,
          sourceRootId: null,
        };
        const handler = handlers.get(REVIEW_QUEUE);
        if (!handler) throw new Error("review queue handler was not registered");
        dispatchOutcome = handler([job]).then(
          (): DispatchOutcome => ({ ok: true }),
          (error: unknown): DispatchOutcome => ({ ok: false, error }),
        );

        await markEntered;
        disposed = Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined);

        if (options.releaseMarkOn === "poolEnd") {
          await poolEnded;
        } else {
          releaseReason = await Promise.race([
            reserveStarted.then(() => "durableReserve" as const),
            poolEnded.then(() => "poolEnd" as const),
          ]);
        }
        releaseMark();
        const outcome = await dispatchOutcome;
        await disposed;
        dispatchError = outcome.ok ? undefined : outcome.error;
      } finally {
        releaseMark();
        controller.abort();
        diagnosticsSpy.mockRestore();
        reconcileSpy.mockRestore();
        await dispatchOutcome;
        await disposed;
      }
      return {
        workItemId,
        resourceKey,
        cfg,
        releaseReason,
        events,
        warnings,
        markError,
        dispatchError,
      };
    }

    it("marks a past-settle review completed inside the durable shutdown reserve (#643)", async () => {
      const scenario = await runShutdownMarkScenario({ releaseMarkOn: "durableReserve" });

      const row = await getWorkItem(pool, scenario.workItemId);
      const terminal = await pool.query<{ completed_at: Date | null }>(
        "SELECT completed_at FROM agent_work_items WHERE id = $1",
        [scenario.workItemId],
      );
      const markBeforePoolEnd =
        scenario.events.includes("mark.completed") &&
        scenario.events.indexOf("mark.completed") < scenario.events.indexOf("pool.end");
      console.info(
        "shutdown-reserve-evidence",
        JSON.stringify({
          releaseReason: scenario.releaseReason,
          markFailed: scenario.markError != null,
          dispatchFailed: scenario.dispatchError != null,
          markBeforePoolEnd,
          warnings: scenario.warnings,
          status: row?.status,
          completed: terminal.rows[0]?.completed_at != null,
        }),
      );

      expect(scenario.releaseReason).toBe("durableReserve");
      expect(scenario.markError).toBeUndefined();
      expect(scenario.dispatchError).toBeUndefined();
      expect(markBeforePoolEnd).toBe(true);
      expect(scenario.warnings).not.toContain("agent_worker_shutdown_incomplete");
      expect(row?.status).toBe("completed");
      expect(terminal.rows[0]?.completed_at).not.toBeNull();

      // The released lease admits a successor immediately.
      const successorId = await insertAutoQueued(scenario.resourceKey, "review");
      await expect(acquireFor(scenario.resourceKey, "review", successorId)).resolves.toMatchObject({
        acquired: true,
      });
    }, 60_000);

    it("recovers a terminal mark dropped after the shutdown reserve (#643)", async () => {
      const scenario = await runShutdownMarkScenario({ releaseMarkOn: "poolEnd" });

      expect(scenario.releaseReason).toBe("poolEnd");
      expect(scenario.warnings).toContain("agent_worker_shutdown_incomplete");
      expect(scenario.markError).toBeInstanceOf(Error);
      expect(scenario.dispatchError).toBeInstanceOf(Error);
      const running = await getWorkItem(pool, scenario.workItemId);
      expect(running?.status).toBe("running");

      // Make only this scenario's data recovery-eligible: age the item, lapse
      // its lease, and keep every matching delivery/watchdog terminal (the
      // controlled boss wrote no pg-boss rows).
      const minAgeSeconds =
        scenario.cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
      await pool.query(
        `UPDATE agent_work_items
            SET started_at = now() - (($2 + 60) * interval '1 second')
          WHERE id = $1`,
        [scenario.workItemId, minAgeSeconds],
      );
      await pool.query(
        `UPDATE pr_actor_leases SET expires_at = now() - interval '1 second'
          WHERE work_item_id = $1`,
        [scenario.workItemId],
      );

      // reconcileLostRunningWork also scans the separate terminal-review repair
      // lane. A reused database may hold another suite's terminal review with an
      // open check; only this scenario's own row must stay out of that lane.
      // The count stays in the evidence line so foreign leftovers remain visible.
      const openCheckRepair = await lostRunningModule.listTerminalReviewsWithOpenOwnChecks(pool);
      expect(openCheckRepair.map((item) => item.workItemId)).not.toContain(scenario.workItemId);

      const report = await workerHealthModule.collectQueueDiagnostics({
        boss: diagnosticsBoss,
        pool,
        now: new Date(),
        diagnosticQueues: [REVIEW_QUEUE],
        dlqQueues: [REVIEW_DEAD_LETTER_QUEUE],
        lostRunningMinAgeSeconds: minAgeSeconds,
      });
      const candidates = report.lostRunningWorkItems.filter(
        (item) => item.workItemId === scenario.workItemId,
      );
      expect(candidates).toHaveLength(1);
      await lostRunningModule.reconcileLostRunningWork({
        cfg: scenario.cfg,
        pool,
        items: candidates,
      });

      const recovered = await getWorkItem(pool, scenario.workItemId);
      const terminal = await pool.query<{ completed_at: Date | null; last_error: string | null }>(
        "SELECT completed_at, last_error FROM agent_work_items WHERE id = $1",
        [scenario.workItemId],
      );
      console.info(
        "shutdown-recovery-evidence",
        JSON.stringify({
          releaseReason: scenario.releaseReason,
          markFailed: scenario.markError instanceof Error,
          diagnosed: candidates.length,
          openCheckRepair: openCheckRepair.length,
          status: recovered?.status,
          lastError: terminal.rows[0]?.last_error,
          completed: terminal.rows[0]?.completed_at != null,
        }),
      );
      expect(recovered?.status).toBe("failed");
      expect(terminal.rows[0]?.last_error).toBe("worker_lost");
      expect(terminal.rows[0]?.completed_at).not.toBeNull();
    }, 60_000);
  });

  it("admits exactly one holder per (resource key, work type) under concurrency", async () => {
    const resourceKey = `${OWNER}/race-${randomUUID().slice(0, 8)}#1`;
    const contenders = Array.from({ length: 8 }, () => randomUUID());

    const outcomes = await Promise.all(contenders.map((id) => acquire(resourceKey, id)));

    const winners = outcomes.filter((outcome) => outcome.acquired);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.leaseEpoch).toBe(1);

    const row = await getLeaseRow(resourceKey);
    expect(Number(row.lease_epoch)).toBe(1);
    expect(contenders).toContain(row.work_item_id);
  });

  it("hands the lease to the next work item only after release, bumping the epoch", async () => {
    const resourceKey = `${OWNER}/handoff-${randomUUID().slice(0, 8)}#1`;
    const first = randomUUID();
    const second = randomUUID();

    await expect(acquire(resourceKey, first)).resolves.toEqual({ acquired: true, leaseEpoch: 1 });

    const blocked = await acquire(resourceKey, second);
    expect(blocked).toEqual({ acquired: false, heldByWorkItemId: first, leaseEpoch: 1 });

    await releasePrActorLease(pool, {
      resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });

    await expect(acquire(resourceKey, second)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });
    await expect(isPrActorLeaseHeld(pool, first, 1)).resolves.toBe(false);
    await expect(isPrActorLeaseHeld(pool, second, 2)).resolves.toBe(true);
  });

  it("steals a lapsed lease and fences the dead holder out of durable writes", async () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
    const resourceKey = `${OWNER}/lapse-${randomUUID().slice(0, 8)}#1`;
    const deadWorkerItem = await insertRunningWorkItem(resourceKey);
    const successorItem = await insertRunningWorkItem(resourceKey);

    const dead = await acquire(resourceKey, deadWorkerItem);
    if (!dead.acquired) throw new Error("expected first acquisition to succeed");
    await pool.query(
      `UPDATE pr_actor_leases SET expires_at = now() - interval '1 second'
        WHERE resource_key = $1 AND work_type = 'review'`,
      [resourceKey],
    );

    await expect(acquire(resourceKey, successorItem)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });

    await expect(markWorkCompleted(pool, deadWorkerItem, dead.leaseEpoch)).resolves.toBe(false);
    await expect(
      updateRunningWorkHeadSha(pool, deadWorkerItem, "newhead", dead.leaseEpoch),
    ).resolves.toBe(false);
    await expect(
      assertPrActorLeaseHeld(pool, deadWorkerItem, dead.leaseEpoch),
    ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });

    await markWorkPublishDegraded(pool, deadWorkerItem, dead.leaseEpoch);
    expect(logWarn).toHaveBeenCalledExactlyOnceWith("agent_work_publish_degraded_mark_rejected", {
      workItemId: deadWorkerItem,
      leaseEpoch: dead.leaseEpoch,
      rowCount: 0,
    });
    const { rows: deadPayload } = await pool.query<{ payload: { publishDegraded?: boolean } }>(
      `SELECT payload FROM agent_work_items WHERE id = $1`,
      [deadWorkerItem],
    );
    expect(deadPayload[0]?.payload.publishDegraded).toBeUndefined();

    await markWorkPublishDegraded(pool, successorItem, 2);
    expect(logWarn).toHaveBeenCalledTimes(1);
    const { rows: livePayload } = await pool.query<{ payload: { publishDegraded?: boolean } }>(
      `SELECT payload FROM agent_work_items WHERE id = $1`,
      [successorItem],
    );
    expect(livePayload[0]?.payload.publishDegraded).toBe(true);

    await expect(markWorkCompleted(pool, successorItem, 2)).resolves.toBe(true);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM agent_work_items WHERE id = $1`,
      [successorItem],
    );
    expect(rows[0]?.status).toBe("completed");
  });

  it("renews only while the caller's epoch still owns the lease", async () => {
    const resourceKey = `${OWNER}/renew-${randomUUID().slice(0, 8)}#1`;
    const holder = randomUUID();

    await acquire(resourceKey, holder);
    const before = (await getLeaseRow(resourceKey)).expires_at;

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: holder,
        leaseEpoch: 99,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(false);

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: holder,
        leaseEpoch: 1,
        ttlSeconds: TTL_SECONDS * 2,
      }),
    ).resolves.toBe(true);
    expect((await getLeaseRow(resourceKey)).expires_at.getTime()).toBeGreaterThan(before.getTime());
  });

  it("does not renew after the holder is cleared for the same epoch", async () => {
    const resourceKey = `${OWNER}/renew-cleared-${randomUUID().slice(0, 8)}#1`;
    const workItemId = randomUUID();

    await acquire(resourceKey, workItemId);
    await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId,
        leaseEpoch: 1,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(false);
    expect((await getLeaseRow(resourceKey)).work_item_id).toBeNull();
    expect(Number((await getLeaseRow(resourceKey)).lease_epoch)).toBe(1);
  });

  it("keeps epochs monotonic across release so a stale holder cannot clear a live lease", async () => {
    const resourceKey = `${OWNER}/monotonic-${randomUUID().slice(0, 8)}#1`;
    const first = randomUUID();
    const second = randomUUID();

    await acquire(resourceKey, first);
    await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });
    await acquire(resourceKey, second);

    await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });

    const row = await getLeaseRow(resourceKey);
    expect(row.work_item_id).toBe(second);
    expect(Number(row.lease_epoch)).toBe(2);
  });

  it("holds the lease-row lock until the stale-head handoff transaction commits", async () => {
    const resourceKey = `${OWNER}/locked-handoff-${randomUUID().slice(0, 8)}#1`;
    const parentId = await insertRunningWorkItem(resourceKey);
    const successorId = await insertRunningWorkItem(resourceKey);
    const acquisition = await acquire(resourceKey, parentId);
    if (!acquisition.acquired) throw new Error("expected parent lease acquisition to succeed");
    await pool.query(
      `UPDATE pr_actor_leases
          SET expires_at = now() - interval '1 second'
        WHERE resource_key = $1 AND work_type = 'review'`,
      [resourceKey],
    );
    const parent = await getWorkItem(pool, parentId);
    if (parent?.type !== "review") throw new Error("expected review parent");

    const blocker = await pool.connect();
    const contender = await pool.connect();
    const observer = await pool.connect();
    let blockerOpen = false;
    let handoff: ReturnType<typeof createReviewRescheduleWorkItem> | undefined;
    let takeover: ReturnType<typeof acquirePrActorLease> | undefined;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query("SELECT id FROM agent_work_items WHERE id = $1 FOR UPDATE", [parentId]);

      handoff = createReviewRescheduleWorkItem(pool, parent, acquisition.leaseEpoch);
      await expect
        .poll(async () => {
          const { rows } = await observer.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%SELECT id FROM agent_work_items%'`,
          );
          return rows[0]?.count ?? 0;
        })
        .toBeGreaterThan(0);

      const { rows: contenderRows } = await contender.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const contenderPid = contenderRows[0]?.pid;
      if (contenderPid == null) throw new Error("missing contender backend pid");
      takeover = acquirePrActorLease(contender, {
        resourceKey,
        workType: "review",
        workItemId: successorId,
        holderId: "lease-it-successor",
        ttlSeconds: TTL_SECONDS,
      });

      await expect
        .poll(async () => {
          const { rows } = await observer.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [contenderPid],
          );
          return rows[0]?.wait_event_type;
        })
        .toBe("Lock");

      await blocker.query("COMMIT");
      blockerOpen = false;
      await expect(handoff).resolves.toMatchObject({
        replacementWorkItemId: expect.any(String),
      });
      await expect(takeover).resolves.toEqual({ acquired: true, leaseEpoch: 2 });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      await handoff?.catch(() => undefined);
      await takeover?.catch(() => undefined);
      blocker.release();
      contender.release();
      observer.release();
    }
  });

  it.each([
    ["auto", "committed"],
    ["auto", "blocked"],
    ["slash", "committed"],
    ["slash", "blocked"],
  ] as const)(
    "preserves replacement payload across %s %s retries (#642)",
    async (source, schedule) => {
      const resourceKey = `${OWNER}/replacement-payload-${randomUUID()}#1`;
      const parentId = randomUUID();
      const initialPayload = {
        mode: "review",
        source,
        userSupplement: "initial supplement",
        ackTargets: [{ kind: "issueComment", commentId: 642 }],
      };
      await pool.query(
        `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES ($1, 'review', $2, 'queued', $3, 'r', 1, 1, 'h', 'review', $4, $5::jsonb)`,
        [parentId, source, OWNER, resourceKey, JSON.stringify(initialPayload)],
      );
      const firstLease = await acquire(resourceKey, parentId);
      if (!firstLease.acquired) throw new Error("expected initial parent lease");
      await expect(
        claimWorkForExecution(pool, parentId, firstLease.leaseEpoch),
      ).resolves.toMatchObject({
        resumed: false,
      });
      const parent = await getWorkItem(pool, parentId);
      if (parent?.type !== "review") throw new Error("expected parent review");
      const first = await createReviewRescheduleWorkItem(pool, parent, firstLease.leaseEpoch);
      const child = await getWorkItem(pool, first.replacementWorkItemId);
      if (child?.type !== "review") throw new Error("expected replacement review");
      expect(child.payload).toEqual({ ...initialPayload, staleHeadRescheduled: true });
      expect(child.status).toBe("queued");
      expect(child.headSha).toBe(DEFERRED_HEAD_SHA);

      await releasePrActorLease(pool, {
        resourceKey,
        workType: "review",
        leaseEpoch: firstLease.leaseEpoch,
      });
      const retryLease = await acquire(resourceKey, parentId);
      if (!retryLease.acquired) throw new Error("expected resumed parent lease");
      expect(retryLease.leaseEpoch).not.toBe(firstLease.leaseEpoch);
      await expect(
        claimWorkForExecution(pool, parentId, retryLease.leaseEpoch),
      ).resolves.toMatchObject({
        resumed: true,
      });
      await pool.query(
        `UPDATE agent_work_items SET payload = payload || '{"repositorySizeKb":642}'::jsonb
        WHERE id = $1`,
        [parentId],
      );
      const resumed = await getWorkItem(pool, parentId);
      if (resumed?.type !== "review") throw new Error("expected resumed parent review");
      expect(resumed.payload.staleHeadReplacement?.replacementWorkItemId).toBe(child.id);

      const patch = {
        publishDegraded: true,
        userSupplement: "saved replacement supplement",
        ackTargets: [{ kind: "reviewComment", commentId: 643 }],
      };
      const mutator = await pool.connect();
      const observer = await pool.connect();
      let mutatorOpen = false;
      let retry: ReturnType<typeof createReviewRescheduleWorkItem> | undefined;
      try {
        await mutator.query("BEGIN");
        mutatorOpen = true;
        await mutator.query(
          "UPDATE agent_work_items SET payload = payload || $2::jsonb WHERE id = $1",
          [child.id, JSON.stringify(patch)],
        );
        if (schedule === "committed") {
          await mutator.query("COMMIT");
          mutatorOpen = false;
        }
        retry = createReviewRescheduleWorkItem(pool, resumed, retryLease.leaseEpoch);
        if (schedule === "blocked") {
          const { rows } = await mutator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const mutatorPid = rows[0]?.pid;
          if (mutatorPid == null) throw new Error("missing mutator backend pid");
          await expect
            .poll(async () => {
              const waiting = await observer.query<{ count: number }>(
                `SELECT COUNT(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock'
                  AND query LIKE '%INSERT INTO agent_work_items%'
                  AND $1::int = ANY(pg_blocking_pids(pid))`,
                [mutatorPid],
              );
              return waiting.rows[0]?.count ?? 0;
            })
            .toBeGreaterThan(0);
          await mutator.query("COMMIT");
          mutatorOpen = false;
        }
        await expect(retry).resolves.toEqual(first);
        const merged = await getWorkItem(pool, child.id);
        if (merged?.type !== "review") throw new Error("expected merged replacement review");
        expect(merged.payload).toEqual({
          ...child.payload,
          ...patch,
          repositorySizeKb: 642,
        });
        expect({ ...merged, payload: child.payload }).toEqual(child);
        await expect(
          createReviewRescheduleWorkItem(pool, resumed, retryLease.leaseEpoch),
        ).resolves.toEqual(first);
        expect(await getWorkItem(pool, child.id)).toEqual(merged);
        const siblings = await pool.query<{ id: string }>(
          "SELECT id FROM agent_work_items WHERE resource_key = $1 AND id <> $2",
          [resourceKey, parentId],
        );
        expect(siblings.rows).toEqual([{ id: child.id }]);
        console.info(
          "replacement-payload-retry-evidence",
          JSON.stringify({
            source,
            schedule,
            mutationPreserved: true,
            incomingFieldAdded: true,
            identityReused: true,
            payloadIdempotent: true,
            epochChanged: true,
            blockingObserved: schedule === "blocked",
          }),
        );
      } finally {
        if (mutatorOpen) await mutator.query("ROLLBACK");
        await retry?.catch(() => undefined);
        mutator.release();
        observer.release();
      }
    },
  );

  it("records the acquired epoch on the work item row at claim time", async () => {
    const resourceKey = `${OWNER}/record-${randomUUID().slice(0, 8)}#1`;
    const workItemId = await insertRunningWorkItem(resourceKey);
    const acquisition = await acquire(resourceKey, workItemId);
    if (!acquisition.acquired) throw new Error("expected acquisition to succeed");

    await expect(
      claimWorkForExecution(pool, workItemId, acquisition.leaseEpoch),
    ).resolves.toMatchObject({ attemptCount: 0 });
    const { rows } = await pool.query<{ execution_epoch: string | number }>(
      `SELECT execution_epoch FROM agent_work_items WHERE id = $1`,
      [workItemId],
    );
    expect(Number(rows[0]?.execution_epoch)).toBe(acquisition.leaseEpoch);

    // Unleased callers omit the epoch and leave the record untouched.
    await pool.query(`UPDATE agent_work_items SET execution_epoch = 9 WHERE id = $1`, [workItemId]);
    await claimWorkForExecution(pool, workItemId);
    const { rows: kept } = await pool.query<{ execution_epoch: string | number }>(
      `SELECT execution_epoch FROM agent_work_items WHERE id = $1`,
      [workItemId],
    );
    expect(Number(kept[0]?.execution_epoch)).toBe(9);
  });

  it("refuses a stale predecessor release when the replacement reused its identifier (#660)", async () => {
    // The TLC id-reuse kill trace, replayed against real Postgres:
    // Cancel(dead ids) snapshots pairs [(D,5)]; the replacement reuses D's id
    // and acquires epoch 6; the late release with the stale pairs must leave
    // the live epoch held with renewal and fencing intact.
    const resourceKey = `${OWNER}/reuse-${randomUUID().slice(0, 8)}#1`;
    const workItemId = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload, execution_epoch
       )
       VALUES (
         $1, 'review', 'auto', 'running', $2, 'r', 1, 1, 'h', 'review', $3,
         '{"mode":"review","source":"auto"}'::jsonb, 5
       )`,
      [workItemId, OWNER, resourceKey],
    );

    await expect(acquire(resourceKey, workItemId)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 1,
    });
    // Predecessor epoch on the cancelled row is 5 in the model; drive the
    // lease to a matching shape: release the initial holder, then let the
    // same identifier acquire the newer epoch the stale cancel must not clear.
    await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });
    await pool.query(`UPDATE agent_work_items SET execution_epoch = 5 WHERE id = $1`, [workItemId]);
    // A stale cancel snapshot taken before the replacement acquires.
    const stalePairs = [{ workItemId, leaseEpoch: 5 }];

    await expect(acquire(resourceKey, workItemId)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });
    await pool.query(`UPDATE agent_work_items SET execution_epoch = 2 WHERE id = $1`, [workItemId]);

    // The exact-pairs release with the stale predecessor epoch refuses the kill.
    await releasePrActorLeaseHeldByWorkItems(pool, {
      resourceKey,
      workType: "review",
      holders: stalePairs,
    });
    const row = await getLeaseRow(resourceKey);
    expect(row.work_item_id).toBe(workItemId);
    expect(Number(row.lease_epoch)).toBe(2);
    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId,
        leaseEpoch: 2,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(true);
    await expect(assertPrActorLeaseHeld(pool, workItemId, 2)).resolves.toBeUndefined();
    await expect(isPrActorLeaseHeld(pool, workItemId, 2)).resolves.toBe(true);
  });

  describe("catch-path operation intent (#656)", () => {
    const OPERATION_KEY = "review:summary:lease-it";

    type IntentSnapshot = {
      readonly status: string;
      readonly detail: Record<string, unknown>;
      readonly lease_epoch: string | number | null;
      readonly updated_at: string;
    };

    async function snapshotIntent(workItemId: string): Promise<IntentSnapshot> {
      // updated_at::text keeps microsecond precision; a Date would round to ms.
      const { rows } = await pool.query<IntentSnapshot>(
        `SELECT status, detail, lease_epoch, updated_at::text AS updated_at
           FROM operation_intents
          WHERE work_item_id = $1 AND operation_key = $2`,
        [workItemId, OPERATION_KEY],
      );
      const row = rows[0];
      if (!row) throw new Error("missing operation_intents row");
      return row;
    }

    function gatewayError(): Error {
      return Object.assign(new Error("bad gateway"), { status: 503 });
    }

    async function acquireLive(resourceKey: string) {
      const workItemId = await insertRunningWorkItem(resourceKey);
      const acquisition = await acquire(resourceKey, workItemId);
      if (!acquisition.acquired) throw new Error("expected acquisition to succeed");
      return { workItemId, epoch: acquisition.leaseEpoch };
    }

    it("refuses the recovery persist after a watchdog steal, with no write and no recover", async () => {
      const resourceKey = `${OWNER}/catch-stale-${randomUUID().slice(0, 8)}#1`;
      const { workItemId, epoch } = await acquireLive(resourceKey);
      const recover = vi.fn(async () => ({ kind: "absent" as const }));
      let beforeCatch: IntentSnapshot | undefined;

      await expect(
        publishOnce({
          client: pool,
          workItemId,
          operationKey: OPERATION_KEY,
          mutationKind: "review_summary",
          leaseEpoch: epoch,
          recover,
          mutate: async () => {
            await pool.query(
              `UPDATE pr_actor_leases SET expires_at = now() - interval '1 second'
                WHERE resource_key = $1 AND work_type = 'review'`,
              [resourceKey],
            );
            await expect(acquire(resourceKey, workItemId)).resolves.toEqual({
              acquired: true,
              leaseEpoch: epoch + 1,
            });
            beforeCatch = await snapshotIntent(workItemId);
            throw gatewayError();
          },
        }),
      ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });

      expect(recover).not.toHaveBeenCalled();
      expect(beforeCatch).toMatchObject({
        status: "pending",
        detail: { __mutating: true },
        lease_epoch: String(epoch),
      });
      expect(await snapshotIntent(workItemId)).toEqual(beforeCatch);
    });

    it("still recovers by exact evidence while the lease is held", async () => {
      const resourceKey = `${OWNER}/catch-live-${randomUUID().slice(0, 8)}#1`;
      const { workItemId, epoch } = await acquireLive(resourceKey);
      const recover = vi.fn(async (_intent: OperationIntentRow) => ({ kind: "absent" as const }));

      await expect(
        publishOnce({
          client: pool,
          workItemId,
          operationKey: OPERATION_KEY,
          mutationKind: "review_summary",
          leaseEpoch: epoch,
          recover,
          mutate: async () => {
            throw gatewayError();
          },
        }),
      ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });

      expect(recover).toHaveBeenCalledTimes(1);
      expect(recover.mock.calls[0]?.[0].detail.__mutating).toBe(true);
      expect((await snapshotIntent(workItemId)).status).toBe("outcome_unknown");
    });
  });

  it.each(["after recovery", "SQL boundary", "null with ownership", "cancellation"] as const)(
    "fences terminal unknown resolution at %s",
    async (window) => {
      const resourceKey = `${OWNER}/terminal-${randomUUID()}#1`;
      const workItemId = await insertRunningWorkItem(resourceKey);
      const nextItemId = await insertRunningWorkItem(resourceKey);
      await acquire(resourceKey, workItemId);
      await claimWorkForExecution(pool, workItemId, 1);
      const operationKey = "review:terminal-resolution";
      await intentRepository.persistOperationIntent(pool, {
        workItemId,
        operationKey,
        mutationKind: "github.pr_surface.setLabels",
        leaseEpoch: 1,
        detail: { __mutating: true },
      });
      const abort = new AbortController();
      const queryOne = postgres.queryOne;
      const reconcile = intentRepository.reconcileOperationIntent;
      let intercepted = false;
      if (window === "SQL boundary") {
        vi.spyOn(postgres, "queryOne").mockImplementation(
          async <T extends QueryResultRow>(
            client: Pool | PoolClient,
            text: string,
            values: unknown[] = [],
          ) => {
            if (
              !intercepted &&
              text.includes("UPDATE operation_intents") &&
              values[0] === workItemId
            ) {
              intercepted = true;
              await pool.query(
                "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
                [resourceKey],
              );
              expect(await acquire(resourceKey, nextItemId)).toEqual({
                acquired: true,
                leaseEpoch: 2,
              });
              const row = await queryOne<T>(client, text, values);
              expect(row).toBeNull();
              return row;
            }
            return queryOne<T>(client, text, values);
          },
        );
      }
      if (window === "null with ownership") {
        vi.spyOn(intentRepository, "reconcileOperationIntent").mockImplementation(
          async (client, params) => {
            if (params.workItemId === workItemId) {
              intercepted = true;
              return null;
            }
            return reconcile(client, params);
          },
        );
      }
      const mutate = vi.fn(async () => undefined);
      const error = await publishOnce({
        client: pool,
        workItemId,
        operationKey,
        mutationKind: "github.pr_surface.setLabels",
        leaseEpoch: 1,
        signal: abort.signal,
        mutate,
        recover: async () => {
          if (window === "after recovery") {
            await pool.query(
              "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
              [resourceKey],
            );
            expect(await acquire(resourceKey, nextItemId)).toEqual({
              acquired: true,
              leaseEpoch: 2,
            });
          }
          if (window === "cancellation") abort.abort();
          return { kind: "absent" };
        },
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code:
          window === "null with ownership"
            ? "operation_intent.reconcile_no_row"
            : window === "cancellation"
              ? "agent_work.execution_aborted"
              : "agent_work.pr_actor_lease_lost",
      });
      if (window === "null with ownership") expect(retryDispositionFor(error)).toBe("transient");
      if (window === "SQL boundary" || window === "null with ownership")
        expect(intercepted).toBe(true);
      const intent = await intentRepository.getOperationIntent(pool, workItemId, operationKey);
      expect(intent).toMatchObject({ status: "pending", detail: { __mutating: true } });
      expect(intent?.detail.unknownResolution).toBeUndefined();
      expect(mutate).not.toHaveBeenCalled();
      expect(await getWorkItem(pool, workItemId)).toMatchObject({ status: "running" });
      expect(await getWorkItem(pool, nextItemId)).toMatchObject({ status: "running" });
      expect((await getLeaseRow(resourceKey)).work_item_id).toBe(
        window === "after recovery" || window === "SQL boundary" ? nextItemId : workItemId,
      );
    },
  );

  it("clears the holder on an exact (id, epoch) match and skips unknown epochs", async () => {
    const resourceKey = `${OWNER}/pairs-${randomUUID().slice(0, 8)}#1`;
    const holder = randomUUID();
    const other = randomUUID();

    await expect(acquire(resourceKey, holder)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 1,
    });

    // A non-matching epoch for the same id never clears (newer survives).
    await releasePrActorLeaseHeldByWorkItems(pool, {
      resourceKey,
      workType: "review",
      holders: [{ workItemId: holder, leaseEpoch: 99 }],
    });
    expect((await getLeaseRow(resourceKey)).work_item_id).toBe(holder);

    // A matching pair clears (genuine holder cleanup never waits out the TTL).
    await releasePrActorLeaseHeldByWorkItems(pool, {
      resourceKey,
      workType: "review",
      holders: [
        { workItemId: other, leaseEpoch: 7 },
        { workItemId: holder, leaseEpoch: 1 },
      ],
    });
    expect((await getLeaseRow(resourceKey)).work_item_id).toBeNull();

    // Empty holders skip the UPDATE entirely (fail closed to TTL/watchdog).
    await expect(acquire(resourceKey, other)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });
    await releasePrActorLeaseHeldByWorkItems(pool, {
      resourceKey,
      workType: "review",
      holders: [],
    });
    const row = await getLeaseRow(resourceKey);
    expect(row.work_item_id).toBe(other);
    expect(Number(row.lease_epoch)).toBe(2);
  });

  it("cancelActiveReviews clears on exact pairs and fails closed on unknown epochs", async () => {
    const resourceKey = `${OWNER}/cancel-${randomUUID().slice(0, 8)}#1`;
    const known = await insertRunningWorkItem(resourceKey);

    const acquisition = await acquire(resourceKey, known);
    if (!acquisition.acquired) throw new Error("expected acquisition to succeed");
    await claimWorkForExecution(pool, known, acquisition.leaseEpoch);

    const client = await pool.connect();
    try {
      const cancelled = await cancelActiveReviews(client, resourceKey, { kind: "closed" as const });
      expect(cancelled.map((row) => row.id)).toEqual([known]);
    } finally {
      client.release();
    }

    // The known holder's exact pair cleared the lease (handoff intact).
    expect((await getLeaseRow(resourceKey)).work_item_id).toBeNull();
  });

  it("cancelActiveReviews fails closed when the holder predates epoch recording", async () => {
    // Pre-fix row: acquired before the claim path recorded execution_epoch,
    // so the row still carries 0 (unknown). The cancel must skip the lease
    // UPDATE rather than clear blindly; expiry plus the watchdog recover it.
    const resourceKey = `${OWNER}/cancel-legacy-${randomUUID().slice(0, 8)}#1`;
    const legacy = await insertRunningWorkItem(resourceKey);
    await expect(acquire(resourceKey, legacy)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 1,
    });
    // No claim-with-epoch: execution_epoch stays 0 as on pre-fix rows.

    const client = await pool.connect();
    try {
      const cancelled = await cancelActiveReviews(client, resourceKey, { kind: "closed" as const });
      expect(cancelled.map((row) => row.id)).toEqual([legacy]);
    } finally {
      client.release();
    }

    const row = await getLeaseRow(resourceKey);
    expect(row.work_item_id).toBe(legacy);
    expect(Number(row.lease_epoch)).toBe(1);
  });

  async function getLeaseRowFor(resourceKey: string, workType: string): Promise<LeaseRow | null> {
    const { rows } = await pool.query<LeaseRow>(
      `SELECT lease_epoch, work_item_id, holder_id, expires_at
         FROM pr_actor_leases
        WHERE resource_key = $1 AND work_type = $2`,
      [resourceKey, workType],
    );
    return rows[0] ?? null;
  }

  async function insertTriageQueued(resourceKey: string, prNumber = 1): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES (
         $1, 'triage', 'slash', 'queued', $2, 'r', $3, 1, 'h', NULL, $4,
         '{"source":"slash","commentId":1,"scope":"all","replyTarget":{"kind":"prConversation","prNumber":1}}'::jsonb
       )`,
      [id, OWNER, prNumber, resourceKey],
    );
    return id;
  }

  async function insertAutoQueued(
    resourceKey: string,
    type: "review" | "description" | "verification",
  ): Promise<string> {
    const id = randomUUID();
    if (type === "review") {
      await pool.query(
        `INSERT INTO agent_work_items (
           id, type, source, status, owner, repo, pr_number, installation_id,
           head_sha, review_lens, resource_key, payload
         )
         VALUES (
           $1, 'review', 'auto', 'queued', $2, 'r', 1, 1, 'h', 'review', $3,
           '{"mode":"review","source":"auto"}'::jsonb
         )`,
        [id, OWNER, resourceKey],
      );
      return id;
    }
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES ($1, $2, 'auto', 'queued', $3, 'r', 1, 1, 'h', NULL, $4, '{"source":"auto"}'::jsonb)`,
      [id, type, OWNER, resourceKey],
    );
    return id;
  }

  async function insertAutoRunning(
    resourceKey: string,
    type: "review" | "description" | "verification",
  ): Promise<string> {
    const id = await insertAutoQueued(resourceKey, type);
    await claimWorkForExecution(pool, id);
    return id;
  }

  function acquireFor(
    resourceKey: string,
    workType: "review" | "description" | "verification" | "triage",
    workItemId: string,
  ) {
    return acquirePrActorLease(pool, {
      resourceKey,
      workType,
      workItemId,
      holderId: "lease-it-holder",
      ttlSeconds: TTL_SECONDS,
    });
  }

  it("cancelActiveTriage clears the triage holder so the next triage acquires immediately (#663)", async () => {
    const resourceKey = `${OWNER}/triage-cancel-${randomUUID().slice(0, 8)}#1`;
    const oldId = await insertTriageQueued(resourceKey);
    await claimWorkForExecution(pool, oldId);
    const acquisition = await acquireFor(resourceKey, "triage", oldId);
    if (!acquisition.acquired) throw new Error("expected triage acquisition to succeed");
    await claimWorkForExecution(pool, oldId, acquisition.leaseEpoch);

    const client = await pool.connect();
    try {
      const cancelled = await cancelActiveTriage(
        client,
        resourceKey,
        { kind: "closed" as const },
        1,
      );
      expect(cancelled.map((row) => row.id)).toEqual([oldId]);
    } finally {
      client.release();
    }

    expect((await getLeaseRowFor(resourceKey, "triage"))?.work_item_id).toBeNull();

    const nextId = await insertTriageQueued(resourceKey);
    await expect(acquireFor(resourceKey, "triage", nextId)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });
    await expect(claimWorkForExecution(pool, nextId, 2)).resolves.toMatchObject({
      attemptCount: expect.any(Number),
    });
    await expect(markWorkCompleted(pool, nextId, 2)).resolves.toBe(true);

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "triage",
        workItemId: oldId,
        leaseEpoch: acquisition.leaseEpoch,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(false);
    await expect(markWorkCompleted(pool, oldId, acquisition.leaseEpoch)).resolves.toBe(false);
    await expect(assertPrActorLeaseHeld(pool, oldId, acquisition.leaseEpoch)).rejects.toMatchObject(
      {
        code: "agent_work.pr_actor_lease_lost",
      },
    );
  });

  it("cancelActiveTriage fails closed when the holder predates epoch recording", async () => {
    const resourceKey = `${OWNER}/triage-cancel-legacy-${randomUUID().slice(0, 8)}#1`;
    const legacy = await insertTriageQueued(resourceKey);
    await claimWorkForExecution(pool, legacy);
    await expect(acquireFor(resourceKey, "triage", legacy)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 1,
    });

    const client = await pool.connect();
    try {
      const cancelled = await cancelActiveTriage(
        client,
        resourceKey,
        { kind: "closed" as const },
        1,
      );
      expect(cancelled.map((row) => row.id)).toEqual([legacy]);
    } finally {
      client.release();
    }

    const row = await getLeaseRowFor(resourceKey, "triage");
    expect(row?.work_item_id).toBe(legacy);
    expect(Number(row?.lease_epoch)).toBe(1);
  });

  it("auto supersede hands the review lease to the replacement immediately (#663)", async () => {
    const resourceKey = `${OWNER}/supersede-review-${randomUUID().slice(0, 8)}#1`;
    const runningId = await insertAutoRunning(resourceKey, "review");
    const runningAcquisition = await acquireFor(resourceKey, "review", runningId);
    if (!runningAcquisition.acquired) throw new Error("expected running acquisition to succeed");
    await claimWorkForExecution(pool, runningId, runningAcquisition.leaseEpoch);
    const queuedId = await insertAutoQueued(resourceKey, "review");

    const client = await pool.connect();
    let replacementId: string | null;
    let supersededIds: readonly string[];
    try {
      const result = await replaceActiveAutoWorkItem({
        client,
        target: { kind: "review", resourceKey },
        createWorkItem: async () => insertAutoQueued(resourceKey, "review"),
      });
      replacementId = result.workItemId;
      supersededIds = result.supersededIds;
    } finally {
      client.release();
    }

    expect(new Set(supersededIds)).toEqual(new Set([queuedId, runningId]));
    expect(replacementId).toEqual(expect.any(String));
    if (replacementId == null) throw new Error("expected replacement");

    const { rows: queuedRow } = await pool.query<{ status: string }>(
      `SELECT status FROM agent_work_items WHERE id = $1`,
      [queuedId],
    );
    expect(queuedRow[0]?.status).toBe("superseded");
    const { rows: runningRow } = await pool.query<{
      status: string;
      cancel_requested_at: Date | null;
    }>(`SELECT status, cancel_requested_at FROM agent_work_items WHERE id = $1`, [runningId]);
    expect(runningRow[0]?.status).toBe("running");
    expect(runningRow[0]?.cancel_requested_at).not.toBeNull();

    expect((await getLeaseRowFor(resourceKey, "review"))?.work_item_id).toBeNull();

    await expect(acquireFor(resourceKey, "review", replacementId)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });
    await expect(claimWorkForExecution(pool, replacementId, 2)).resolves.toMatchObject({
      attemptCount: expect.any(Number),
    });
    await expect(markWorkCompleted(pool, replacementId, 2)).resolves.toBe(true);

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: runningId,
        leaseEpoch: runningAcquisition.leaseEpoch,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(false);
    await expect(
      assertPrActorLeaseHeld(pool, runningId, runningAcquisition.leaseEpoch),
    ).rejects.toMatchObject({
      code: "agent_work.pr_actor_lease_lost",
    });
  });

  it("auto supersede hands description and verification leases over via replaceAuto (#663)", async () => {
    for (const type of ["description", "verification"] as const) {
      const resourceKey = `${OWNER}/supersede-${type}-${randomUUID().slice(0, 8)}#1`;
      const runningId = await insertAutoRunning(resourceKey, type);
      const acquisition = await acquireFor(resourceKey, type, runningId);
      if (!acquisition.acquired) throw new Error(`expected ${type} acquisition to succeed`);
      await claimWorkForExecution(pool, runningId, acquisition.leaseEpoch);

      const client = await pool.connect();
      let replacementId: string;
      try {
        const result = await replaceAutoWorkItem({
          client,
          target: { kind: type, resourceKey },
          createWorkItem: async () => insertAutoQueued(resourceKey, type),
        });
        replacementId = result.workItemId;
        expect(result.supersededIds).toContain(runningId);
      } finally {
        client.release();
      }

      expect((await getLeaseRowFor(resourceKey, type))?.work_item_id).toBeNull();
      await expect(acquireFor(resourceKey, type, replacementId)).resolves.toEqual({
        acquired: true,
        leaseEpoch: 2,
      });
      await expect(claimWorkForExecution(pool, replacementId, 2)).resolves.toMatchObject({
        attemptCount: expect.any(Number),
      });
    }
  });

  it("auto supersede fails closed on queued-only and legacy rows and matches zero triage rows", async () => {
    const queuedOnlyKey = `${OWNER}/supersede-queued-only-${randomUUID().slice(0, 8)}#1`;
    await insertAutoQueued(queuedOnlyKey, "review");
    await insertAutoQueued(queuedOnlyKey, "review");
    const queuedClient = await pool.connect();
    try {
      const result = await replaceActiveAutoWorkItem({
        client: queuedClient,
        target: { kind: "review", resourceKey: queuedOnlyKey },
        createWorkItem: async () => insertAutoQueued(queuedOnlyKey, "review"),
      });
      expect(result.supersededIds).toHaveLength(2);
      expect(result.workItemId).toEqual(expect.any(String));
    } finally {
      queuedClient.release();
    }
    expect(await getLeaseRowFor(queuedOnlyKey, "review")).toBeNull();

    const legacyKey = `${OWNER}/supersede-legacy-${randomUUID().slice(0, 8)}#1`;
    const legacy = await insertAutoRunning(legacyKey, "review");
    await expect(acquireFor(legacyKey, "review", legacy)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 1,
    });
    const legacyClient = await pool.connect();
    try {
      const result = await replaceActiveAutoWorkItem({
        client: legacyClient,
        target: { kind: "review", resourceKey: legacyKey },
        createWorkItem: async () => insertAutoQueued(legacyKey, "review"),
      });
      expect(result.supersededIds).toContain(legacy);
    } finally {
      legacyClient.release();
    }
    const legacyRow = await getLeaseRowFor(legacyKey, "review");
    expect(legacyRow?.work_item_id).toBe(legacy);
    expect(Number(legacyRow?.lease_epoch)).toBe(1);

    const triageKey = `${OWNER}/supersede-triage-zero-${randomUUID().slice(0, 8)}#1`;
    const triageClient = await pool.connect();
    try {
      const result = await replaceActiveAutoWorkItem({
        client: triageClient,
        target: { kind: "triage", resourceKey: triageKey },
        createWorkItem: async () => insertAutoQueued(triageKey, "review"),
      });
      expect(result).toEqual({ workItemId: null, supersededIds: [] });
    } finally {
      triageClient.release();
    }
    expect(await getLeaseRowFor(triageKey, "triage")).toBeNull();
  });

  it("auto supersede never steals a live slash holder (review + description)", async () => {
    const reviewKey = `${OWNER}/supersede-mixed-review-${randomUUID().slice(0, 8)}#1`;
    const slashReviewId = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES (
         $1, 'review', 'slash', 'queued', $2, 'r', 1, 1, 'h', 'review', $3,
         '{"mode":"review","source":"slash"}'::jsonb
       )`,
      [slashReviewId, OWNER, reviewKey],
    );
    await claimWorkForExecution(pool, slashReviewId);
    const slashAcquisition = await acquireFor(reviewKey, "review", slashReviewId);
    if (!slashAcquisition.acquired) throw new Error("expected slash acquisition to succeed");
    await claimWorkForExecution(pool, slashReviewId, slashAcquisition.leaseEpoch);
    const autoQueued = await insertAutoQueued(reviewKey, "review");

    const reviewClient = await pool.connect();
    try {
      const result = await replaceActiveAutoWorkItem({
        client: reviewClient,
        target: { kind: "review", resourceKey: reviewKey },
        createWorkItem: async () => insertAutoQueued(reviewKey, "review"),
      });
      expect(result.supersededIds).toEqual([autoQueued]);
    } finally {
      reviewClient.release();
    }
    expect((await getLeaseRowFor(reviewKey, "review"))?.work_item_id).toBe(slashReviewId);
    const blocked = await acquireFor(reviewKey, "review", randomUUID());
    expect(blocked).toEqual({
      acquired: false,
      heldByWorkItemId: slashReviewId,
      leaseEpoch: slashAcquisition.leaseEpoch,
    });

    const descKey = `${OWNER}/supersede-mixed-desc-${randomUUID().slice(0, 8)}#1`;
    const slashDescId = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES ($1, 'description', 'slash', 'queued', $2, 'r', 1, 1, 'h', NULL, $3, '{"source":"slash"}'::jsonb)`,
      [slashDescId, OWNER, descKey],
    );
    await claimWorkForExecution(pool, slashDescId);
    const slashDescAcquisition = await acquireFor(descKey, "description", slashDescId);
    if (!slashDescAcquisition.acquired) throw new Error("expected slash desc acquisition");
    await claimWorkForExecution(pool, slashDescId, slashDescAcquisition.leaseEpoch);
    await insertAutoQueued(descKey, "description");

    const descClient = await pool.connect();
    try {
      await replaceAutoWorkItem({
        client: descClient,
        target: { kind: "description", resourceKey: descKey },
        createWorkItem: async () => insertAutoQueued(descKey, "description"),
      });
    } finally {
      descClient.release();
    }
    expect((await getLeaseRowFor(descKey, "description"))?.work_item_id).toBe(slashDescId);
  });
});
