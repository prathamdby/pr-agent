import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { AppError } from "../src/errors/appError.js";

// File-local repository stubs: exercise withOperationIntent control flow without
// the shared memory store (see memoryOperationIntentStore.test.ts for that path).
vi.mock("../src/agentWork/operationIntentRepository.js", () => ({
  persistOperationIntent: vi.fn(),
  mergeOperationIntentDetail: vi.fn(),
  reconcileOperationIntent: vi.fn(),
}));

vi.mock("../src/agentWork/reconcilePendingIntents.js", () => ({
  findCompletedPublishRecordId: vi.fn(),
  reconcilePendingIntents: vi.fn(),
  intentDetailMatchesPublishRecord: vi.fn(),
}));

import {
  mergeOperationIntentDetail,
  persistOperationIntent,
  reconcileOperationIntent,
} from "../src/agentWork/operationIntentRepository.js";
import { findCompletedPublishRecordId } from "../src/agentWork/reconcilePendingIntents.js";
import { withOperationIntent } from "../src/agentWork/withOperationIntent.js";

const pool = {} as Pool;
const baseParams = {
  client: pool,
  workItemId: "wi-1",
  operationKey: "ask:reply:o/r#1",
  mutationKind: "github.ask_reply",
  detail: { step: "ask_reply", resourceKey: "o/r#1" },
};

describe("withOperationIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: {},
    });
    vi.mocked(mergeOperationIntentDetail).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: {},
    });
    vi.mocked(reconcileOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: null,
      detail: {},
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue(null);
  });

  it("persists intent and marks __mutating before running the mutation", async () => {
    const calls: string[] = [];
    vi.mocked(persistOperationIntent).mockImplementation(async () => {
      calls.push("persist");
      return {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: "ask:reply:o/r#1",
        mutationKind: "github.ask_reply",
        status: "pending",
        publishRecordId: null,
        detail: {},
      };
    });
    vi.mocked(mergeOperationIntentDetail).mockImplementation(async (_client, params) => {
      if (params.detail.__mutating === true) calls.push("mark_mutating");
      else if ("__result" in params.detail) calls.push("stash_result");
      return {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: "ask:reply:o/r#1",
        mutationKind: "github.ask_reply",
        status: "pending",
        publishRecordId: null,
        detail: params.detail,
      };
    });

    const result = await withOperationIntent({
      ...baseParams,
      mutate: async () => {
        calls.push("mutate");
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(calls).toEqual(["persist", "mark_mutating", "mutate", "stash_result"]);
    expect(mergeOperationIntentDetail).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        detail: expect.objectContaining({ __mutating: true, __mutateAttempt: expect.any(String) }),
      }),
    );
    expect(persistOperationIntent).toHaveBeenCalledBefore(vi.mocked(reconcileOperationIntent));
  });

  it("reconciles to reconciled after a successful mutation", async () => {
    await withOperationIntent({
      ...baseParams,
      publishRecordId: "pub-1",
      mutate: async () => "done",
    });

    expect(mergeOperationIntentDetail).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      detail: { __result: "done" },
    });
    expect(reconcileOperationIntent).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      status: "reconciled",
      publishRecordId: "pub-1",
      detail: { __result: "done" },
    });
  });

  it("finishes reconcile without remutating when pending intent already has __result", async () => {
    const mutate = vi.fn(async () => "fresh");
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __result: { commentId: 55 } },
    });

    const result = await withOperationIntent({
      ...baseParams,
      mutate,
    });

    expect(result).toEqual({ commentId: 55 });
    expect(mutate).not.toHaveBeenCalled();
    expect(mergeOperationIntentDetail).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      status: "reconciled",
      publishRecordId: undefined,
      detail: { __result: { commentId: 55 } },
    });
  });

  it("marks intent failed and throws AppError when mutation fails", async () => {
    const mutate = vi.fn(async () => {
      throw new Error("github down");
    });

    await expect(
      withOperationIntent({
        ...baseParams,
        mutate,
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(reconcileOperationIntent).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      status: "failed",
      detail: { errorMessage: "github down" },
    });
  });

  it("leaves intent pending when crash happens before mutation", async () => {
    vi.mocked(persistOperationIntent).mockImplementation(async () => {
      throw new AppError({
        code: "operation_intent.persist_failed",
        message: "crash before mutation",
      });
    });

    await expect(
      withOperationIntent({
        ...baseParams,
        mutate: async () => "never",
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(reconcileOperationIntent).not.toHaveBeenCalled();
  });

  it("skips mutate when the intent is already reconciled", async () => {
    const mutate = vi.fn(async () => "fresh");
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: null,
      detail: { __result: "prior" },
    });

    const result = await withOperationIntent({
      ...baseParams,
      mutate,
    });

    expect(result).toBe("prior");
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).not.toHaveBeenCalled();
  });

  it("does not remutate on redelivery after post-mutate crash before __result", async () => {
    const mutate = vi.fn(async () => "second");

    let firstMutateCalls = 0;
    vi.mocked(persistOperationIntent).mockResolvedValueOnce({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: {},
    });
    vi.mocked(mergeOperationIntentDetail).mockImplementation(async (_client, params) => {
      if (params.detail.__mutating === true) {
        return {
          id: "intent-1",
          workItemId: "wi-1",
          operationKey: "ask:reply:o/r#1",
          mutationKind: "github.ask_reply",
          status: "pending",
          publishRecordId: null,
          detail: params.detail,
        };
      }
      throw new Error("crash after mutate before persist __result");
    });

    await expect(
      withOperationIntent({
        ...baseParams,
        mutate: async () => {
          firstMutateCalls += 1;
          return "first";
        },
      }),
    ).rejects.toThrow("crash after mutate before persist __result");
    expect(firstMutateCalls).toBe(1);

    vi.mocked(persistOperationIntent).mockResolvedValueOnce({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __mutating: true, __mutateAttempt: "attempt-1", step: "ask_reply" },
    });
    vi.mocked(mergeOperationIntentDetail).mockClear();
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue(null);

    await expect(
      withOperationIntent({
        ...baseParams,
        mutate,
      }),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });

    expect(mutate).not.toHaveBeenCalled();
    expect(firstMutateCalls + mutate.mock.calls.length).toBe(1);
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "failed",
        detail: expect.objectContaining({
          errorCode: "operation_intent.mutation_outcome_unknown",
        }),
      }),
    );
  });

  it("recovers from publish_records without remutating when __mutating and no __result", async () => {
    const mutate = vi.fn(async () => "fresh");
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: {
        __mutating: true,
        step: "ask_reply",
        resourceKey: "o/r#1",
      },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue("pub-recovered");

    await expect(
      withOperationIntent({
        ...baseParams,
        mutate,
      }),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });

    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        publishRecordId: "pub-recovered",
        detail: expect.objectContaining({
          recoveredAfterMutating: true,
          reconciledFromPublishRecord: true,
        }),
      }),
    );
  });
});
