import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { memoryOperationIntentStore } from "./setup/operationIntent-memory.js";
import { withOperationIntent } from "../src/agentWork/withOperationIntent.js";

const pool = {} as Pool;

describe("memoryOperationIntentStore + real withOperationIntent", () => {
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

  it("retries after post-mutate / pre-reconcile crash without remutating", async () => {
    const mutate = vi.fn(async () => ({ reviewId: 101 }));
    memoryOperationIntentStore.failNextReconcile(new Error("crash before reconcile"), 1);

    await expect(
      withOperationIntent({
        client: pool,
        workItemId: "wi-9",
        operationKey: "review:inline:batch-stable",
        mutationKind: "github.inline_review",
        detail: { batchId: "batch-stable" },
        mutate,
      }),
    ).rejects.toThrow();

    const pending = memoryOperationIntentStore.get("wi-9", "review:inline:batch-stable");
    expect(pending?.status).toBe("pending");
    expect(pending?.detail.__result).toEqual({ reviewId: 101 });
    expect(mutate).toHaveBeenCalledTimes(1);

    const result = await withOperationIntent({
      client: pool,
      workItemId: "wi-9",
      operationKey: "review:inline:batch-stable",
      mutationKind: "github.inline_review",
      detail: { batchId: "batch-stable" },
      mutate,
    });

    expect(result).toEqual({ reviewId: 101 });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(memoryOperationIntentStore.get("wi-9", "review:inline:batch-stable")?.status).toBe(
      "reconciled",
    );
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
