import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  loadReviewExecutorPublishContext,
  recordPublishStep,
} from "../../src/agentWork/repository.js";
import {
  runInOperationIntentFrame,
  withOperationIntent,
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
});
