import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runRetention } from "../src/agentWork/retention.js";
import { RETENTION_DELETE_BATCH_SIZE } from "../src/settings/index.js";

const RETENTION = {
  agentWorkRetentionSeconds: 30 * 86_400,
  webhookEventsRetentionSeconds: 30 * 86_400,
  agentEventsRetentionSeconds: 0,
  codeIndexRetentionSeconds: 30 * 86_400,
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
          const batch = workBatches[workCalls++];
          if (batch === undefined) {
            throw new Error("unexpected extra agent_work_items query");
          }
          return { rowCount: batch };
        }
        if (text.includes("webhook_events")) {
          const batch = webhookBatches[webhookCalls++];
          if (batch === undefined) {
            throw new Error("unexpected extra webhook_events query");
          }
          return { rowCount: batch };
        }
        if (text.includes("agent_resume_snapshots")) {
          return { rowCount: 4 };
        }
        if (text.includes("agent_events")) {
          return { rowCount: 0 };
        }
        if (text.includes("code_index_snapshots")) {
          return { rowCount: 0 };
        }
        throw new Error(`unexpected query: ${text}`);
      }),
    } as unknown as Pool;

    const result = await runRetention(pool, RETENTION);

    expect(result.workItemsDeleted).toBe(RETENTION_DELETE_BATCH_SIZE + 2);
    expect(result.webhookEventsDeleted).toBe(RETENTION_DELETE_BATCH_SIZE);
    expect(result.resumeSnapshotsDeleted).toBe(4);
    expect(result.agentEventsDeleted).toBe(0);
    expect(result.codeIndexSnapshotsDeleted).toBe(0);
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
        if (text.includes("webhook_events")) {
          webhookCalls += 1;
          return { rowCount: 0 };
        }
        if (text.includes("agent_resume_snapshots")) {
          return { rowCount: 0 };
        }
        if (text.includes("code_index_snapshots")) {
          return { rowCount: 0 };
        }
        throw new Error(`unexpected query: ${text}`);
      }),
    } as unknown as Pool;

    const result = await runRetention(pool, RETENTION);

    expect(result.workItemsDeleted).toBe(3);
    expect(result.webhookEventsDeleted).toBe(0);
    expect(result.resumeSnapshotsDeleted).toBe(0);
    expect(result.agentEventsDeleted).toBe(0);
    expect(workCalls).toBe(1);
    expect(webhookCalls).toBe(1);
  });
});
