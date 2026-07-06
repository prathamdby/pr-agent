import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runRetention } from "../src/agentWork/retention.js";
import { RETENTION_DELETE_BATCH_SIZE } from "../src/settings/index.js";

const RETENTION = {
  agentWorkRetentionSeconds: 30 * 86_400,
  webhookEventsRetentionSeconds: 30 * 86_400,
};

describe("runRetention batched delete loop", () => {
  it("keeps deleting until a short batch is returned, accumulating row counts", async () => {
    // Work items: one full batch then a short remainder; webhook events: one full
    // batch then an empty short batch. Each loop must issue exactly two queries.
    const workBatches = [RETENTION_DELETE_BATCH_SIZE, 2];
    const webhookBatches = [RETENTION_DELETE_BATCH_SIZE, 0];
    let workCalls = 0;
    let webhookCalls = 0;

    const pool = {
      query: vi.fn(async (text: string) => {
        if (text.includes("agent_work_items")) {
          return { rowCount: workBatches[workCalls++] ?? 0 };
        }
        return { rowCount: webhookBatches[webhookCalls++] ?? 0 };
      }),
    } as unknown as Pool;

    const result = await runRetention(pool, RETENTION);

    expect(result.workItemsDeleted).toBe(RETENTION_DELETE_BATCH_SIZE + 2);
    expect(result.webhookEventsDeleted).toBe(RETENTION_DELETE_BATCH_SIZE);
    expect(workCalls).toBe(2);
    expect(webhookCalls).toBe(2);
  });

  it("stops after a single short batch when the table is already small", async () => {
    let workCalls = 0;
    let webhookCalls = 0;

    const pool = {
      query: vi.fn(async (text: string) => {
        if (text.includes("agent_work_items")) {
          workCalls += 1;
          return { rowCount: 3 };
        }
        webhookCalls += 1;
        return { rowCount: 0 };
      }),
    } as unknown as Pool;

    const result = await runRetention(pool, RETENTION);

    expect(result.workItemsDeleted).toBe(3);
    expect(result.webhookEventsDeleted).toBe(0);
    expect(workCalls).toBe(1);
    expect(webhookCalls).toBe(1);
  });
});
