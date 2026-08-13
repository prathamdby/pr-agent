import { describe, expect, it, vi } from "vitest";
import { replaceAutoWorkItem } from "../src/agentWork/autoWorkEnqueue.js";
import type { JsonValue } from "../src/util/jsonValue.js";
import { createQueryClient } from "./helpers/fakePool.js";

function mockClient() {
  const lockKeys: JsonValue[] = [];
  const query = vi.fn(async (sql: string, params?: readonly JsonValue[]) => {
    if (sql.includes("pg_advisory_xact_lock")) {
      lockKeys.push(params?.[0] ?? null);
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { client: createQueryClient(query), query, lockKeys };
}

describe("replaceAutoWorkItem", () => {
  it("acquires a transaction-scoped advisory lock before supersede RMW", async () => {
    const { client, query } = mockClient();
    const createWorkItem = vi.fn(async () => "work-item-id");

    await replaceAutoWorkItem({
      client,
      target: { kind: "review", resourceKey: "owner/repo#42" },
      createWorkItem,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.any(Array),
    );
    expect(createWorkItem).toHaveBeenCalledTimes(1);
  });

  it("uses distinct lock keys per resource kind", async () => {
    const review = mockClient();
    const description = mockClient();

    await replaceAutoWorkItem({
      client: review.client,
      target: { kind: "review", resourceKey: "owner/repo#42" },
      createWorkItem: async () => "review-id",
    });
    await replaceAutoWorkItem({
      client: description.client,
      target: { kind: "description", resourceKey: "owner/repo#42" },
      createWorkItem: async () => "description-id",
    });

    expect(review.lockKeys[0]).not.toEqual(description.lockKeys[0]);
  });
});
