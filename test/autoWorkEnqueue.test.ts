import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { replaceAutoWorkItem } from "../src/agentWork/autoWorkEnqueue.js";

function mockClient(): PoolClient & { lockKeys: unknown[] } {
  const lockKeys: unknown[] = [];
  return {
    lockKeys,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        lockKeys.push(params?.[0]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE agent_work_items") && sql.includes("superseded")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("cancel_requested_at")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as PoolClient & { lockKeys: unknown[] };
}

describe("replaceAutoWorkItem", () => {
  it("acquires a transaction-scoped advisory lock before supersede RMW", async () => {
    const client = mockClient();
    const createWorkItem = vi.fn(async () => "work-item-id");

    await replaceAutoWorkItem({
      client,
      target: { kind: "review", resourceKey: "owner/repo#42" },
      createWorkItem,
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.any(Array),
    );
    expect(createWorkItem).toHaveBeenCalledTimes(1);
  });

  it("uses distinct lock keys per resource kind", async () => {
    const reviewClient = mockClient();
    const descriptionClient = mockClient();

    await replaceAutoWorkItem({
      client: reviewClient,
      target: { kind: "review", resourceKey: "owner/repo#42" },
      createWorkItem: async () => "review-id",
    });
    await replaceAutoWorkItem({
      client: descriptionClient,
      target: { kind: "description", resourceKey: "owner/repo#42" },
      createWorkItem: async () => "description-id",
    });

    expect(reviewClient.lockKeys[0]).not.toEqual(descriptionClient.lockKeys[0]);
  });
});
