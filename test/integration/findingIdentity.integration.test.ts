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
import { parseOwnedFindingMarker } from "../../src/review/findingIdentity/findingMarker.js";
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

  it("recovers a batch killed after GitHub accepted it by the finding markers GitHub returns", async () => {
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
      await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });
});
