import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  admitAsk,
  defaultAskQuotaConfig,
  recordAskProviderUsage,
  type AskQuotaConfig,
} from "../../src/agentWork/askQuota.js";
import { inTransaction } from "../../src/db/postgres.js";
import { runMigrations } from "../../src/db/migrations.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "ask-quota-it";
const INSTALLATION_ID = 9481;
const REPO = "app";
const PR_NUMBER = 481;

const BASE_QUOTA: AskQuotaConfig = {
  ...defaultAskQuotaConfig(),
  askActorMaxOutstanding: 2,
  askRepositoryMaxOutstanding: 20,
  askInstallationMaxOutstanding: 20,
  askActorBurst: 100,
  askRepositoryBurst: 100,
  askInstallationBurst: 100,
  askActorRefillSeconds: 100_000,
  askRepositoryRefillSeconds: 100_000,
  askInstallationRefillSeconds: 100_000,
};

describe.skipIf(!hasDatabase)("ask admission quotas (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(
      `UPDATE agent_work_items
          SET status = 'cancelled', completed_at = now(), updated_at = now()
        WHERE owner = $1 AND status IN ('queued', 'running')`,
      [OWNER],
    );
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query(
      `DELETE FROM ask_quota_buckets
        WHERE scope_key = $1 OR scope_key LIKE $2 OR scope_key LIKE $3`,
      [
        `installation:${INSTALLATION_ID}`,
        `repository:${INSTALLATION_ID}:%`,
        `actor:${INSTALLATION_ID}:%`,
      ],
    );
  });

  async function insertQueuedAsk(
    client: Pick<PoolClient, "query">,
    workItemId: string,
    commenterId: number,
    repo = REPO,
  ): Promise<void> {
    await client.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, resource_key, priority, payload
       ) VALUES ($1, 'ask', 'slash', 'queued', $2, $3, $4, $5, 'deferred', $6, 50, $7::jsonb)`,
      [
        workItemId,
        OWNER,
        repo,
        PR_NUMBER,
        INSTALLATION_ID,
        prResourceKey(OWNER, repo, PR_NUMBER),
        JSON.stringify({
          question: "why?",
          replyTarget: { kind: "prConversation", prNumber: PR_NUMBER },
          commentId: 1,
          commenterId,
        }),
      ],
    );
  }

  async function admitAndInsert(
    workItemId: string,
    commenterId: number,
    config: AskQuotaConfig = BASE_QUOTA,
    repo = REPO,
  ) {
    return inTransaction(pool, async (client) => {
      const admission = await admitAsk(
        client,
        {
          workItemId,
          installationId: INSTALLATION_ID,
          owner: OWNER,
          repo,
          commenterId,
        },
        config,
      );
      if (admission.kind === "admitted") {
        await insertQueuedAsk(client, workItemId, commenterId, repo);
      }
      return admission;
    });
  }

  it("serializes concurrent admissions and releases outstanding capacity on completion", async () => {
    const workItemIds = Array.from({ length: 5 }, () => randomUUID());
    const admissions = await Promise.all(workItemIds.map((id) => admitAndInsert(id, 7)));

    expect(admissions.filter((result) => result.kind === "admitted")).toHaveLength(2);
    expect(admissions.filter((result) => result.kind === "throttled")).toHaveLength(3);
    const throttled = admissions.filter((result) => result.kind === "throttled");
    expect(throttled.every((result) => result.reason === "actor_outstanding")).toBe(true);

    const { rows } = await pool.query<{ outstanding_count: number }>(
      `SELECT outstanding_count
         FROM ask_quota_buckets
        WHERE scope = 'actor' AND scope_key = $1`,
      [`actor:${INSTALLATION_ID}:7`],
    );
    expect(rows[0]?.outstanding_count).toBe(2);

    const admittedId = workItemIds.find((id, index) => admissions[index]?.kind === "admitted");
    expect(admittedId).toBeDefined();
    await pool.query(
      `UPDATE agent_work_items
          SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [admittedId],
    );

    const retry = await admitAndInsert(randomUUID(), 7);
    expect(retry.kind).toBe("admitted");
  });

  it("keeps provider reservations safe for exact and unknown usage", async () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      askProviderBudgetTokens: 10,
      askProviderReservationTokens: 6,
    };
    const firstId = randomUUID();
    const first = await admitAndInsert(firstId, 7, config);
    expect(first).toEqual({ kind: "admitted", providerReservationTokens: 6 });

    const blockedByReservation = await admitAndInsert(randomUUID(), 8, config);
    expect(blockedByReservation).toEqual({ kind: "throttled", reason: "provider_budget" });

    await recordAskProviderUsage(pool, {
      workItemId: firstId,
      usage: { estimated: false, totalTokens: 4 },
    });
    const afterExactUsage = await admitAndInsert(randomUUID(), 8, config);
    expect(afterExactUsage.kind).toBe("admitted");

    await pool.query(
      `UPDATE agent_work_items
          SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [firstId],
    );

    const unknownId = randomUUID();
    await pool.query(
      `UPDATE agent_work_items
          SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE id = (SELECT id FROM agent_work_items WHERE owner = $1 AND status = 'queued' ORDER BY created_at LIMIT 1)`,
      [OWNER],
    );
    const unknown = await admitAndInsert(unknownId, 9, config);
    expect(unknown).toEqual({ kind: "throttled", reason: "provider_budget" });
  });
});
