import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { memoryOperationIntentStore } from "./setup/operationIntent-memory.js";
import { withOperationIntent } from "../src/agentWork/withOperationIntent.js";

const pool = {} as Pool;

describe("memoryOperationIntentStore + real withOperationIntent", () => {
  beforeEach(() => {
    memoryOperationIntentStore.reset();
  });

  it("returns the existing row on conflict without resetting status or detail", async () => {
    await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply" },
    });
    await memoryOperationIntentStore.reconcile(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      status: "reconciled",
      detail: { __result: { commentId: 99 } },
    });

    const again = await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply", rewritten: true },
    });

    expect(again.status).toBe("reconciled");
    expect(again.detail).toEqual({
      step: "ask_reply",
      __result: { commentId: 99 },
    });
    expect(again.detail).not.toHaveProperty("rewritten");
  });

  it("skips mutate when a prior attempt already reconciled with __result", async () => {
    const mutate = vi.fn(async () => ({ commentId: 999 }));

    // Simulate: GitHub accepted, process died before reconcile, recovery wrote __result.
    await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply", resourceKey: "o/r#1" },
    });
    await memoryOperationIntentStore.reconcile(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      status: "reconciled",
      detail: { __result: { commentId: 42 } },
    });

    const result = await withOperationIntent({
      client: pool,
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply", resourceKey: "o/r#1" },
      mutate,
    });

    expect(result).toEqual({ commentId: 42 });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps a pending intent after post-mutate / pre-reconcile process death", async () => {
    const mutate = vi.fn(async () => "remote-ok");

    // Process-death model: persist + mutate succeed; reconcile never runs (no catch).
    await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-9",
      operationKey: "review:inline:batch-stable",
      mutationKind: "github.review_inline",
      detail: { batchId: "batch-stable" },
    });
    await mutate();

    const pending = await memoryOperationIntentStore.listPending(pool, "wi-9");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.operationKey).toBe("review:inline:batch-stable");
    expect(pending[0]?.status).toBe("pending");

    // Retry without recovery still remutates — that is the #1/#2 production bug surface.
    // With the same operation key, persist returns the pending row (conflict no-op).
    const persisted = await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-9",
      operationKey: "review:inline:batch-stable",
      mutationKind: "github.review_inline",
      detail: { batchId: "batch-stable" },
    });
    expect(persisted.status).toBe("pending");
    expect(persisted.operationKey).toBe("review:inline:batch-stable");
  });

  it("failNextReconcile throws once then allows a later reconcile", async () => {
    await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-2",
      operationKey: "k",
      mutationKind: "m",
    });
    memoryOperationIntentStore.failNextReconcile(new Error("boom"), 1);
    await expect(
      memoryOperationIntentStore.reconcile(pool, {
        workItemId: "wi-2",
        operationKey: "k",
        status: "reconciled",
      }),
    ).rejects.toThrow("boom");

    const row = await memoryOperationIntentStore.reconcile(pool, {
      workItemId: "wi-2",
      operationKey: "k",
      status: "reconciled",
      detail: { __result: true },
    });
    expect(row?.status).toBe("reconciled");
    expect(row?.detail.__result).toBe(true);
  });
});
