import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { AppError, isAppError } from "../../src/errors/appError.js";
import { isJsonString, type JsonValue } from "../../src/util/jsonValue.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  claimWorkForExecution,
  markWorkCompleted,
  recordPublishStep,
} from "../../src/agentWork/repository.js";
import {
  OPERATION_INTENT_MUTATING_KEY,
  withOperationIntent,
} from "../../src/agentWork/withOperationIntent.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "epoch-fence-it";

describe.skipIf(!hasDatabase)("execution epoch fencing (integration)", () => {
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

  async function insertRunningWorkItem(): Promise<{ id: string; resourceKey: string }> {
    const id = randomUUID();
    const resourceKey = `${OWNER}-${id}`;
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, attempt_count, execution_epoch, payload
       )
       VALUES ($1, 'review', 'auto', 'running', $2, 'r', 1, 1, 'h', 'review', $3, 1, 0, '{}'::jsonb)`,
      [id, OWNER, resourceKey],
    );
    return { id, resourceKey };
  }

  it("rejects publish and completion from a superseded claim", async () => {
    const { id, resourceKey } = await insertRunningWorkItem();
    const first = await claimWorkForExecution(pool, id);
    const second = await claimWorkForExecution(pool, id);
    expect(first?.executionEpoch).toBe(1);
    expect(second?.executionEpoch).toBe(2);

    await expect(
      recordPublishStep(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        step: "summary_comment",
        githubId: 1,
        executionEpoch: 1,
      }),
    ).rejects.toSatisfy(
      (error: Error) => isAppError(error) && error.code === "agent_work.stale_execution_epoch",
    );

    await expect(markWorkCompleted(pool, id, 1)).resolves.toBe(false);
    await expect(markWorkCompleted(pool, id, 2)).resolves.toBe(true);
  });

  it("lets only the winning epoch publish when two claims race", async () => {
    const { id, resourceKey } = await insertRunningWorkItem();
    const [a, b] = await Promise.all([
      claimWorkForExecution(pool, id),
      claimWorkForExecution(pool, id),
    ]);
    const epochs = [a?.executionEpoch, b?.executionEpoch].filter(
      (value): value is number => value != null,
    );
    expect(epochs).toHaveLength(2);
    const winner = Math.max(...epochs);

    const results = await Promise.allSettled(
      epochs.map((executionEpoch) =>
        recordPublishStep(pool, {
          workItemId: id,
          resourceKey,
          reviewLens: "review",
          step: "summary_comment",
          githubId: executionEpoch,
          executionEpoch,
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toBeInstanceOf(AppError);
      expect(
        rejection.reason instanceof Error &&
          isAppError(rejection.reason) &&
          rejection.reason.code === "agent_work.stale_execution_epoch",
      ).toBe(true);
    }

    const { rows } = await pool.query<{ github_id: string | null }>(
      `SELECT github_id FROM publish_records
        WHERE work_item_id = $1 AND step = 'summary_comment'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.github_id).toBe(String(winner));
  });

  it("does not remutate after crash between mutate success and __result persist", async () => {
    const { id, resourceKey } = await insertRunningWorkItem();
    await claimWorkForExecution(pool, id);
    const operationKey = `review:summary:review:${resourceKey}`;
    let mutateCalls = 0;

    // SAFETY: withOperationIntent only calls client.query; this double forwards to the real pool except the injected crash.
    const client = {
      query: async (text: string, values?: readonly JsonValue[]) => {
        if (
          text.includes("operation_intents") &&
          text.includes("detail") &&
          Array.isArray(values) &&
          values.some(
            (value) =>
              isJsonString(value) &&
              value.includes('"__result"') &&
              !value.includes(`"${OPERATION_INTENT_MUTATING_KEY}":true`),
          )
        ) {
          throw new Error("crash after mutate before persist __result");
        }
        if (values === undefined) return pool.query(text);
        return pool.query(text, [...values]);
      },
    } as Pool;

    await expect(
      withOperationIntent({
        client,
        workItemId: id,
        operationKey,
        mutationKind: "github.summary_comment",
        executionEpoch: 1,
        detail: { step: "summary_comment", resourceKey, reviewLens: "review" },
        mutate: async () => {
          mutateCalls += 1;
          return { id: 42 };
        },
      }),
    ).rejects.toThrow(/crash after mutate/);

    await expect(
      withOperationIntent({
        client: pool,
        workItemId: id,
        operationKey,
        mutationKind: "github.summary_comment",
        executionEpoch: 1,
        detail: { step: "summary_comment", resourceKey, reviewLens: "review" },
        mutate: async () => {
          mutateCalls += 1;
          return { id: 99 };
        },
      }),
    ).rejects.toSatisfy(
      (error: Error) =>
        isAppError(error) && error.code === "operation_intent.mutation_outcome_unknown",
    );

    expect(mutateCalls).toBe(1);
  });
});
