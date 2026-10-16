import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import { openReviewArtifactStore } from "../../src/agentWork/reviewArtifactRepository.js";
import { getOperationIntent } from "../../src/agentWork/operationIntentRepository.js";
import {
  deterministicInlineBatchId,
  reviewInlineBatchOperationKey,
} from "../../src/agentWork/publishOnce.js";
import { createFakePrSurface, type PrSurface } from "../../src/github/prSurface.js";
import { publishVerification } from "../../src/agent/verification/publishVerification.js";
import {
  loadFindingInventory,
  loadFindingInventoryFromThreads,
} from "../../src/review/findingIdentity/findingInventory.js";
import { parseOwnedFindingMarker } from "../../src/review/findingIdentity/findingMarker.js";
import { fetchBotFindingThreads } from "../../src/review/run/reviewPriorFeedback.js";
import { recordDeliveredFileRead } from "../../src/review/findings/evidenceLedger.js";
import { createFindingLedger } from "../../src/review/orchestrator/orchestratorTypes.js";
import { publishFindingBatch } from "../../src/review/publish/publishFindingBatch.js";
import { createReviewPublishSession } from "../../src/review/publish/reviewPublishSession.js";
import { createReviewArtifactBinding } from "../../src/review/recovery/reviewArtifacts.js";
import { openReviewRecovery } from "../../src/review/recovery/reviewRecovery.js";
import type { ReviewFinding } from "../../src/review/reviewSchema.js";
import { makeTestConfig } from "../helpers/config.js";
import {
  createTestEvidenceLedger,
  seedEvidenceForFindings,
} from "../helpers/evidenceTestHelpers.js";
import { cachedDiffForLines } from "../helpers/reviewPublishTestHelpers.js";
import { hasDatabase, integrationPool } from "./db.js";

const HEAD_SHA = "abc1234";
const LEASE_EPOCH = 7;

const findings: readonly ReviewFinding[] = [10, 11].map((line) => ({
  severity: "P1",
  file: "src/a.ts",
  startLine: line,
  endLine: line,
  title: `Null dereference at line ${line}`,
  detail: `The payload read at line ${line} can be null on this path.`,
  fixPrompt: "Guard the payload before dereferencing it.",
}));

describe.skipIf(!hasDatabase)("finding identity (integration)", () => {
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
  });

  async function seedReviewPublication() {
    const workItemId = randomUUID();
    const repo = `r-${workItemId}`;
    const resourceKey = `finding-identity-it/${repo}#1`;
    await pool.query(
      `INSERT INTO agent_work_items
        (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload, execution_epoch)
       VALUES ($1, 'review', 'auto', 'running', 'finding-identity-it', $2, 1, 42, $3, 'review', $4, '{}', $5)`,
      [workItemId, repo, HEAD_SHA, resourceKey, LEASE_EPOCH],
    );
    await pool.query(
      `INSERT INTO pr_actor_leases (resource_key, work_type, lease_epoch, work_item_id, holder_id, expires_at)
       VALUES ($1, 'review', $2, $3, 'finding-identity-it', now() + interval '5 minutes')`,
      [resourceKey, LEASE_EPOCH, workItemId],
    );
    const binding = createReviewArtifactBinding(
      {
        workItemId,
        resourceKey,
        owner: "finding-identity-it",
        repo,
        prNumber: 1,
        installationId: 42,
        baseSha: "base",
        headSha: HEAD_SHA,
        mode: "review",
      },
      "a".repeat(64),
    );
    const { surface, controls } = createFakePrSurface({
      owner: "finding-identity-it",
      repo,
      prNumber: 1,
    });

    const attempt = (client: Pool, prSurface: PrSurface) => {
      const evidenceLedger = createTestEvidenceLedger(HEAD_SHA);
      seedEvidenceForFindings(evidenceLedger, findings);
      recordDeliveredFileRead(evidenceLedger, {
        path: "src/a.ts",
        headSha: HEAD_SHA,
        tool: "readWorkspaceFile",
        startLine: 10,
        endLine: 11,
        content: "line ten\nline eleven",
      });
      const recovery = openReviewRecovery(
        binding,
        openReviewArtifactStore(client, binding, LEASE_EPOCH),
      );
      const session = createReviewPublishSession({
        cfg: makeTestConfig(),
        ctx: {
          owner: "finding-identity-it",
          repo,
          prNumber: 1,
          headSha: HEAD_SHA,
          hasDescriptionReviewMap: false,
        },
        workItemId,
        recovery,
        prSurface,
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 11]),
        resolveProgressCommentUrl: async () =>
          `https://github.com/finding-identity-it/${repo}/pull/1#issuecomment-99`,
        operationIntent: { client, workItemId, resourceKey, leaseEpoch: LEASE_EPOCH },
      });
      return {
        session,
        recovery,
        input: { source: "correctness" as const, ledger: createFindingLedger(), evidenceLedger },
      };
    };

    const cleanup = async () => {
      await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    };

    return { workItemId, resourceKey, surface, controls, attempt, cleanup };
  }

  it("recovers a batch killed after GitHub accepted it by the finding markers GitHub returns", async () => {
    const { workItemId, surface, controls, attempt, cleanup } = await seedReviewPublication();

    try {
      const killedPool = integrationPool();
      const acceptPublish = surface.publishThreadBatch.bind(surface);
      let markAccepted: () => void = () => undefined;
      const accepted = new Promise<void>((resolve) => {
        markAccepted = resolve;
      });
      vi.spyOn(surface, "publishThreadBatch").mockImplementationOnce(async (review) => {
        await acceptPublish(review);
        markAccepted();
        return new Promise<never>(() => undefined);
      });
      const killed = attempt(killedPool, surface);
      void publishFindingBatch(findings, killed.session, killed.input);
      await accepted;
      await killedPool.end();
      vi.restoreAllMocks();

      const reviewsBefore = await surface.listPullRequestReviews();
      const threadsBefore = await surface.listInlineReviewThreads();
      expect(controls.threadBatches).toHaveLength(1);
      expect(reviewsBefore).toHaveLength(1);
      const acceptedReviewId = reviewsBefore[0]?.id;

      const retry = attempt(pool, surface);
      const decisions = await retry.recovery.decisions();
      expect(decisions).toHaveLength(1);
      const [decision] = decisions;
      const journaled =
        decision?.prepared.artifact.canonical.kind === "threads"
          ? decision.prepared.artifact.canonical.inline.map((placement) => placement.findingId)
          : [];
      expect(journaled).toHaveLength(2);
      const operationKey = reviewInlineBatchOperationKey(
        deterministicInlineBatchId({ workItemId, headSha: HEAD_SHA, findingIds: journaled }),
      );
      expect(decision?.prepared.artifact.operationKey).toBe(operationKey);
      const pending = await getOperationIntent(pool, workItemId, operationKey);
      expect(pending?.status).toBe("pending");

      const recovered = await publishFindingBatch([], retry.session, {
        ...retry.input,
        recoveryDecision: decision,
      });

      expect(controls.threadBatches).toHaveLength(1);
      expect(await surface.listPullRequestReviews()).toEqual(reviewsBefore);
      expect((await surface.listInlineReviewThreads()).threads).toHaveLength(
        threadsBefore.threads.length,
      );
      expect(recovered.kind).toBe("published");
      if (recovered.kind !== "published") return;
      const posted = recovered.delta.accepted.flatMap((entry) =>
        entry.kind === "posted" ? [entry] : [],
      );
      expect(posted.map((entry) => entry.reviewId)).toEqual([acceptedReviewId, acceptedReviewId]);
      expect(recovered.delta.inlineReviewIds).toEqual([acceptedReviewId]);

      const botLogin = await surface.getBotLogin();
      const markerIds = (await surface.listReviewComments()).comments
        .filter((comment) => comment.pullRequestReviewId === acceptedReviewId)
        .map(
          (comment) =>
            parseOwnedFindingMarker(
              { body: comment.body, authorLogin: comment.authorLogin, isRoot: true },
              botLogin,
            )?.id,
        );
      expect(markerIds).toHaveLength(journaled.length);
      expect(new Set(markerIds)).toEqual(new Set(journaled));
      expect(posted.map((entry) => entry.findingId)).toHaveLength(markerIds.length);
      expect(new Set(posted.map((entry) => entry.findingId))).toEqual(new Set(markerIds));
      expect((await getOperationIntent(pool, workItemId, operationKey))?.status).toBe("reconciled");
    } finally {
      await cleanup();
    }
  });

  it("rebuilds the same finding ids from GitHub after database loss", async () => {
    const { workItemId, surface, attempt, cleanup } = await seedReviewPublication();

    try {
      const first = attempt(pool, surface);
      const published = await publishFindingBatch(findings, first.session, first.input);
      expect(published.kind).toBe("published");
      if (published.kind !== "published") return;
      const recordedIds = published.delta.accepted.flatMap((entry) =>
        entry.kind === "posted" ? [entry.findingId] : [],
      );
      expect(recordedIds).toHaveLength(findings.length);
      const durableRows = async () =>
        (
          await pool.query<{ count: string }>(
            `SELECT (SELECT count(*) FROM publish_records WHERE work_item_id = $1)
                  + (SELECT count(*) FROM operation_intents WHERE work_item_id = $1)
                  + (SELECT count(*) FROM review_run_artifacts WHERE work_item_id = $1) AS count`,
            [workItemId],
          )
        ).rows[0]?.count;
      expect(Number(await durableRows())).toBeGreaterThan(0);

      await cleanup();
      expect(Number(await durableRows())).toBe(0);

      const inventory = await loadFindingInventory(surface, {
        renames: new Map(),
        deletedPaths: new Set(),
      });
      expect(inventory.completeness).toBe("complete");
      const open = [...inventory.findings.values()].filter((finding) => finding.state === "open");
      expect(open.every((finding) => !finding.legacy)).toBe(true);
      expect(new Set(open.map((finding) => finding.id))).toEqual(new Set(recordedIds));
      expect(new Set(open.map((finding) => finding.line))).toEqual(new Set([10, 11]));
    } finally {
      await cleanup();
    }
  });

  it("reports a partial inventory and blocks resolution receipts", async () => {
    const { workItemId, resourceKey, surface, controls, attempt, cleanup } =
      await seedReviewPublication();
    const botUserId = 4242;

    try {
      const first = attempt(pool, surface);
      const published = await publishFindingBatch(findings, first.session, first.input);
      expect(published.kind).toBe("published");
      if (published.kind !== "published") return;
      const [reviewId] = published.delta.inlineReviewIds;
      if (reviewId == null) throw new Error("expected an inline review");
      controls.setReviewComments(
        (await surface.listReviewComments()).comments.map((comment) => ({
          ...comment,
          userId: botUserId,
        })),
      );
      controls.setPullRequestReviews(
        (await surface.listPullRequestReviews()).map((review) => ({
          ...review,
          userId: botUserId,
        })),
      );
      const botLogin = await surface.getBotLogin();
      const candidates = async () => {
        const threads = await surface.listInlineReviewThreads();
        const inventory = await loadFindingInventoryFromThreads(surface, {
          threads,
          botLogin,
          renames: new Map(),
          deletedPaths: new Set(),
        });
        const found = await fetchBotFindingThreads(surface, {
          botUserId,
          inventory,
          publishRecordLenses: new Map([[reviewId, "review" as const]]),
        });
        return { inventory, threads, found };
      };

      const complete = await candidates();
      expect(complete.inventory.completeness).toBe("complete");
      expect(complete.found).toHaveLength(findings.length);
      expect(new Set(complete.found.map((thread) => thread.findingId))).toEqual(
        new Set(complete.inventory.findings.keys()),
      );

      controls.setThreadResolutionStatus("partial", "thread page missing");
      const partial = await candidates();
      expect(partial.inventory.completeness).toBe("partial");
      expect(partial.found).toHaveLength(findings.length);
      expect(partial.found.every((thread) => thread.findingId == null)).toBe(true);

      const [fixedThread, dismissedThread] = partial.found;
      if (fixedThread == null || dismissedThread == null) throw new Error("expected two threads");
      const eventsBefore = controls.events.length;
      const result = await publishVerification({
        pool,
        workItemId,
        resourceKey,
        leaseEpoch: LEASE_EPOCH,
        installationId: 42,
        owner: "finding-identity-it",
        repo: surface.repo,
        prNumber: 1,
        headSha: HEAD_SHA,
        prSurface: surface,
        inventory: partial.found,
        resolutionByRootCommentId: partial.threads.byRootCommentId,
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: fixedThread.rootCommentId,
              evidence: "guarded",
              commitSha: "abcdef1",
            },
            {
              verdict: "dismissed",
              threadRootCommentId: dismissedThread.rootCommentId,
              evidence: "intentional",
            },
          ],
        },
        changedFilePaths: ["src/a.ts"],
        policyResult: { kind: "absent" },
      });

      expect(result.degradation).toEqual(["verdict_mapping_incomplete"]);
      const writes = controls.events
        .slice(eventsBefore)
        .filter(
          (event) =>
            event.kind === "resolveInlineReviewThread" ||
            event.kind === "replyAt" ||
            event.kind === "editReviewComment",
        );
      expect(writes).toEqual([]);
      expect(controls.replies).toHaveLength(0);
      expect(
        (await surface.listInlineReviewThreads()).threads.every((thread) => !thread.isResolved),
      ).toBe(true);

      controls.setThreadResolutionStatus("ok");
      const restored = await candidates();
      const silentlyFixed = restored.found.find(
        (thread) => thread.rootCommentId === fixedThread.rootCommentId,
      );
      if (silentlyFixed?.findingId == null) throw new Error("expected a complete candidate");
      const fixedResult = await publishVerification({
        pool,
        workItemId,
        resourceKey,
        leaseEpoch: LEASE_EPOCH,
        installationId: 42,
        owner: "finding-identity-it",
        repo: surface.repo,
        prNumber: 1,
        headSha: HEAD_SHA,
        prSurface: surface,
        inventory: restored.found,
        resolutionByRootCommentId: restored.threads.byRootCommentId,
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: silentlyFixed.rootCommentId,
              evidence: "guarded",
              commitSha: "abcdef1",
            },
          ],
        },
        changedFilePaths: ["src/a.ts"],
        policyResult: { kind: "absent" },
      });
      expect(fixedResult.degradation).toEqual([]);
      expect(controls.replies).toHaveLength(0);
      const fixedRoot = (await surface.listInlineReviewThreads()).threads.find(
        (thread) => thread.rootCommentId === silentlyFixed.rootCommentId,
      );
      expect(fixedRoot?.isResolved).toBe(true);
      expect(fixedRoot?.comments).toHaveLength(1);
      expect(
        fixedRoot?.comments[0]?.body.split(`kind=fixed id=${silentlyFixed.findingId}`),
      ).toHaveLength(2);
      const rebuilt = await loadFindingInventory(surface, {
        renames: new Map(),
        deletedPaths: new Set(),
      });
      expect(rebuilt.findings.get(silentlyFixed.findingId)).toMatchObject({
        state: "resolved",
        resolution: "fixed",
      });
    } finally {
      await cleanup();
    }
  });
});
