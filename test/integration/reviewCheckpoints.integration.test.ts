import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import {
  claimReviewCriticAttempt,
  createReviewCheckpointStores,
  loadReviewCriticCheckpoints,
  loadReviewPayloadCheckpoint,
  markReviewCriticExhausted,
  saveReviewCriticReport,
  saveReviewPayloadCheckpointOnce,
} from "../../src/agentWork/repository.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "checkpoint-it";
const HEAD_SHA = "a".repeat(40);
const EVIDENCE_HASH = "e".repeat(64);

describe.skipIf(!hasDatabase)("review checkpoints (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
  });

  async function insertWorkItem(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES ($1, 'review', 'auto', 'running', $2, 'r', 1, 1, $3, 'review', $4, '{}'::jsonb)`,
      [id, OWNER, HEAD_SHA, `checkpoint-it-${id}`],
    );
    return id;
  }

  function scopeFor(workItemId: string) {
    return {
      workItemId,
      headSha: HEAD_SHA,
      evidenceHash: EVIDENCE_HASH,
      promptContractVersion: 1,
    };
  }

  it("reuses completed reports across retries and enforces the attempt budget", async () => {
    const workItemId = await insertWorkItem();
    const key = { ...scopeFor(workItemId), criticId: "correctness" };

    expect(await claimReviewCriticAttempt(pool, key)).toEqual({ attemptCount: 1, claimed: true });
    await saveReviewCriticReport(pool, key, { coverage: "done", findings: [] });

    const loaded = await loadReviewCriticCheckpoints(pool, scopeFor(workItemId));
    expect(loaded.get("correctness")).toMatchObject({
      status: "completed",
      attemptCount: 1,
      report: { coverage: "done", findings: [] },
    });

    // A durable retry must not run the completed critic again.
    expect(await claimReviewCriticAttempt(pool, key)).toEqual({ attemptCount: 1, claimed: false });
  });

  it("ignores checkpoints when any identity field differs", async () => {
    const workItemId = await insertWorkItem();
    const key = { ...scopeFor(workItemId), criticId: "security" };
    await claimReviewCriticAttempt(pool, key);
    await saveReviewCriticReport(pool, key, { coverage: "done" });

    for (const scope of [
      { ...scopeFor(workItemId), headSha: "b".repeat(40) },
      { ...scopeFor(workItemId), evidenceHash: "f".repeat(64) },
      { ...scopeFor(workItemId), promptContractVersion: 2 },
      { ...scopeFor(await insertWorkItem()) },
    ]) {
      expect((await loadReviewCriticCheckpoints(pool, scope)).size).toBe(0);
    }
  });

  it("keeps completed reports immutable under repeated or failed writes", async () => {
    const workItemId = await insertWorkItem();
    const key = { ...scopeFor(workItemId), criticId: "reliability" };
    await claimReviewCriticAttempt(pool, key);
    await saveReviewCriticReport(pool, key, { coverage: "first" });
    await markReviewCriticExhausted(pool, key);
    await saveReviewCriticReport(pool, key, { coverage: "second" });

    const loaded = await loadReviewCriticCheckpoints(pool, scopeFor(workItemId));
    expect(loaded.get("reliability")).toMatchObject({
      status: "completed",
      report: { coverage: "first" },
    });
  });

  it("persists attempt counts across claims for the retry budget", async () => {
    const workItemId = await insertWorkItem();
    const key = { ...scopeFor(workItemId), criticId: "change-safety" };
    expect((await claimReviewCriticAttempt(pool, key)).attemptCount).toBe(1);
    expect((await claimReviewCriticAttempt(pool, key)).attemptCount).toBe(2);
    await markReviewCriticExhausted(pool, key);
    const loaded = await loadReviewCriticCheckpoints(pool, scopeFor(workItemId));
    expect(loaded.get("change-safety")).toMatchObject({ status: "exhausted", attemptCount: 2 });
  });

  it("writes the validated payload once and keeps the first capture", async () => {
    const workItemId = await insertWorkItem();
    const stored = await saveReviewPayloadCheckpointOnce(pool, {
      ...scopeFor(workItemId),
      payload: { prCharacter: "first" },
    });
    expect(stored.payload).toEqual({ prCharacter: "first" });

    const replay = await saveReviewPayloadCheckpointOnce(pool, {
      ...scopeFor(workItemId),
      payload: { prCharacter: "second" },
    });
    expect(replay.payload).toEqual({ prCharacter: "first" });
    expect((await loadReviewPayloadCheckpoint(pool, workItemId))?.payload).toEqual({
      prCharacter: "first",
    });
  });

  it("cascades checkpoint deletion when the work item is deleted", async () => {
    const workItemId = await insertWorkItem();
    const key = { ...scopeFor(workItemId), criticId: "correctness" };
    await claimReviewCriticAttempt(pool, key);
    await saveReviewCriticReport(pool, key, { coverage: "done" });
    await saveReviewPayloadCheckpointOnce(pool, {
      ...scopeFor(workItemId),
      payload: { prCharacter: "x" },
    });

    await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);

    const critics = await pool.query(
      "SELECT 1 FROM review_critic_checkpoints WHERE work_item_id = $1",
      [workItemId],
    );
    expect(critics.rowCount).toBe(0);
    expect(await loadReviewPayloadCheckpoint(pool, workItemId)).toBeNull();
  });

  it("exposes the pg-backed store interface", async () => {
    const workItemId = await insertWorkItem();
    const { criticStore, payloadStore } = createReviewCheckpointStores(pool);
    const key = { ...scopeFor(workItemId), criticId: "security" };
    await criticStore.claimAttempt(key);
    await criticStore.saveCompletedReport(key, { coverage: "done" });
    expect((await criticStore.loadCheckpoints(scopeFor(workItemId))).get("security")?.status).toBe(
      "completed",
    );
    await payloadStore.saveOnce({ ...scopeFor(workItemId), payload: { prCharacter: "x" } });
    expect((await payloadStore.load(workItemId))?.payload).toEqual({ prCharacter: "x" });
  });

  it("creates the expected constraints and indexes", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'review_critic_checkpoints'",
    );
    const names = rows.map((row) => row.indexname);
    expect(names).toContain("review_critic_checkpoints_work_item_idx");
    expect(
      names.some((name) =>
        name.includes("review_critic_checkpoints_work_item_id_head_sha_evidence"),
      ),
    ).toBe(true);

    await expect(
      pool.query(
        `INSERT INTO review_critic_checkpoints
           (id, work_item_id, head_sha, evidence_hash, critic_id, prompt_contract_version, status)
         VALUES ($1, $2, $3, $4, 'x', 1, 'bogus')`,
        [randomUUID(), await insertWorkItem(), HEAD_SHA, EVIDENCE_HASH],
      ),
    ).rejects.toThrow(/check/i);
  });
});
