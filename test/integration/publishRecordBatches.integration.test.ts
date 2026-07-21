import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  loadReviewExecutorPublishContext,
  recordPublishStep,
} from "../../src/agentWork/repository.js";
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

  it("appends each batch once in the shared inline review row", async () => {
    const workItemId = randomUUID();
    const resourceKey = `integration/publish-batches#${randomUUID()}`;
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, $3::jsonb)`,
      [workItemId, resourceKey, JSON.stringify({ mode: "review", source: "slash" })],
    );

    try {
      const firstBatch = {
        batchId: "batch-1",
        workItemId,
        reviewId: 41,
        fingerprints: ["fp-1"],
      };
      const secondBatch = {
        batchId: "batch-2",
        workItemId,
        reviewId: 42,
        fingerprints: ["fp-2"],
      };
      const write = (detail: typeof firstBatch) =>
        recordPublishStep(pool, {
          workItemId,
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
          github_id: "42",
          detail: { batches: [firstBatch, secondBatch] },
        },
      ]);
      const context = await loadReviewExecutorPublishContext(
        pool,
        workItemId,
        resourceKey,
        "review",
      );
      expect(context.publishState.inlineReviewIds).toEqual([41, 42]);
      expect(context.storedInlineFingerprints.toSorted()).toEqual(["fp-1", "fp-2", "fp-legacy"]);
    } finally {
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });
});
