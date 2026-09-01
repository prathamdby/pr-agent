import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  replaceActiveAutoWorkItem,
  replaceAutoWorkItem,
} from "../src/agentWork/autoWorkEnqueue.js";

function mockClient(options?: {
  readonly queuedIds?: readonly string[];
  readonly runningIds?: readonly string[];
  readonly activeIds?: readonly string[];
}): PoolClient & {
  lockKeys: unknown[];
  linkedIds: readonly string[];
} {
  const lockKeys: unknown[] = [];
  const queuedIds = options?.queuedIds ?? options?.activeIds ?? [];
  const runningIds = options?.runningIds ?? [];
  let linkedIds: readonly string[] = [];
  return {
    lockKeys,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        lockKeys.push(params?.[0]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("superseded_by")) {
        linkedIds = (params?.[1] as readonly string[]) ?? [];
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE agent_work_items") && sql.includes("superseded")) {
        return { rows: queuedIds.map((id) => ({ id })), rowCount: queuedIds.length };
      }
      if (sql.includes("cancel_requested_at")) {
        return { rows: runningIds.map((id) => ({ id })), rowCount: runningIds.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    get linkedIds() {
      return linkedIds;
    },
  } as unknown as PoolClient & { lockKeys: unknown[]; linkedIds: readonly string[] };
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

  it("creates a replacement and links superseded rows when active work exists", async () => {
    const client = mockClient({ activeIds: ["queued-1"] });
    const createWorkItem = vi.fn(async () => "replacement-id");

    const result = await replaceActiveAutoWorkItem({
      client,
      target: { kind: "review", resourceKey: "owner/repo#42" },
      createWorkItem,
    });

    expect(result).toEqual({ workItemId: "replacement-id", supersededIds: ["queued-1"] });
    expect(createWorkItem).toHaveBeenCalledTimes(1);
    expect(client.linkedIds).toEqual(["queued-1"]);
  });

  it("unions queued and running ids when superseding active auto work", async () => {
    const client = mockClient({ queuedIds: ["queued-1", "queued-2"], runningIds: ["running-1"] });
    const createWorkItem = vi.fn(async () => "replacement-id");

    const result = await replaceActiveAutoWorkItem({
      client,
      target: { kind: "review", resourceKey: "owner/repo#42" },
      createWorkItem,
    });

    expect(result).toEqual({
      workItemId: "replacement-id",
      supersededIds: ["queued-1", "queued-2", "running-1"],
    });
    expect(createWorkItem).toHaveBeenCalledTimes(1);
    expect(client.lockKeys).toHaveLength(1);
    expect(client.linkedIds).toEqual(["queued-1", "queued-2", "running-1"]);
  });

  it("creates no replacement when no active auto work exists", async () => {
    const client = mockClient();
    const createWorkItem = vi.fn(async () => "replacement-id");

    const result = await replaceActiveAutoWorkItem({
      client,
      target: { kind: "review", resourceKey: "owner/repo#42" },
      createWorkItem,
    });

    expect(result).toEqual({ workItemId: null, supersededIds: [] });
    expect(createWorkItem).not.toHaveBeenCalled();
    expect(client.linkedIds).toEqual([]);
  });
});
