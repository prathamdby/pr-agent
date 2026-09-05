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

vi.mock("../src/agentWork/prActorLease.js", () => ({
  assertPrActorLeaseHeld: vi.fn(async () => undefined),
}));

import {
  mergeOperationIntentDetail,
  persistOperationIntent,
  reconcileOperationIntent,
} from "../src/agentWork/operationIntentRepository.js";
import { findCompletedPublishRecordId } from "../src/agentWork/reconcilePendingIntents.js";
import {
  operationIntentMarker,
  withOperationIntent,
} from "../src/agentWork/withOperationIntent.js";
import { assertPrActorLeaseHeld } from "../src/agentWork/prActorLease.js";

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

  it("scopes remote markers to the work-item instance while keeping retries stable", () => {
    const operationKey = "review:summary:correctness:o/r#1";

    expect(operationIntentMarker(operationKey, "wi-1")).toBe(
      operationIntentMarker(operationKey, "wi-1"),
    );
    expect(operationIntentMarker(operationKey, "wi-1")).not.toBe(
      operationIntentMarker(operationKey, "wi-2"),
    );
  });

  it("does not reuse a marker from another work item for the same resource operation", () => {
    const operationKey = "review:summary:correctness:o/r#1";
    const oldWorkItemMarker = operationIntentMarker(operationKey, "wi-old");
    const retryWorkItemMarker = operationIntentMarker(operationKey, "wi-retry");

    expect(oldWorkItemMarker).not.toBe(retryWorkItemMarker);
    expect(retryWorkItemMarker).not.toContain(oldWorkItemMarker);
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
        detail: expect.objectContaining({ __mutating: true }),
      }),
    );
    expect(vi.mocked(mergeOperationIntentDetail).mock.calls[0]?.[1]?.detail).not.toHaveProperty(
      "__mutateAttempt",
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

  it("marks an unclassified mutation failure outcome-unknown and throws AppError", async () => {
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
      status: "outcome_unknown",
      detail: {
        __mutating: false,
        errorCode: "operation_intent.mutation_outcome_unknown",
        errorMessage: "github down",
      },
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
      detail: { __mutating: true, step: "ask_reply" },
    });
    vi.mocked(mergeOperationIntentDetail).mockClear();
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue(null);

    await expect(
      withOperationIntent({
        ...baseParams,
        mutate,
      }),
    ).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
      message:
        "Mutation outcome unknown after crash between mutate() and __result; remutate forbidden",
    });

    expect(mutate).not.toHaveBeenCalled();
    expect(firstMutateCalls + mutate.mock.calls.length).toBe(1);
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "outcome_unknown",
        detail: expect.objectContaining({
          errorCode: "operation_intent.mutation_outcome_unknown",
        }),
      }),
    );
  });

  it("never remutates after status outcome_unknown", async () => {
    const mutate = vi.fn(async () => "second");
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "outcome_unknown",
      publishRecordId: null,
      detail: {
        __mutating: false,
        errorCode: "operation_intent.mutation_outcome_unknown",
      },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue(null);

    await expect(
      withOperationIntent({
        ...baseParams,
        mutate,
      }),
    ).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
      message:
        "Mutation outcome unknown after crash between mutate() and __result; remutate forbidden",
    });

    expect(mutate).not.toHaveBeenCalled();
    expect(findCompletedPublishRecordId).toHaveBeenCalled();
  });

  it("returns recovered value without remutating when __mutating and recover reconciles", async () => {
    const mutate = vi.fn(async () => ({ commentId: 99 }));
    const recover = vi.fn(async () => ({
      kind: "reconciled" as const,
      value: { commentId: 42 },
    }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __mutating: true, step: "ask_reply" },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue(null);

    const result = await withOperationIntent({
      ...baseParams,
      recover,
      mutate,
    });

    expect(result).toEqual({ commentId: 42 });
    expect(recover).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        detail: { __result: { commentId: 42 } },
      }),
    );
  });

  it("reconciles exact remote evidence for a void mutation without remutating", async () => {
    const mutate = vi.fn(async () => undefined);
    const recover = vi.fn(async () => ({ kind: "reconciled" as const, value: undefined }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "outcome_unknown",
      publishRecordId: null,
      detail: { __mutating: false },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue(null);

    await expect(
      withOperationIntent({
        ...baseParams,
        recover,
        mutate,
      }),
    ).resolves.toBeUndefined();

    expect(recover).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        detail: { __result: null },
      }),
    );
  });

  it("records a remote 503 as outcome-unknown when exact recovery is absent", async () => {
    const mutate = vi.fn(async () => {
      throw Object.assign(new Error("upstream timeout"), { status: 503 });
    });
    const recover = vi.fn(async () => ({ kind: "absent" as const }));

    await expect(
      withOperationIntent({
        ...baseParams,
        recover,
        mutate,
      }),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });

    expect(mutate).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ status: "outcome_unknown" }),
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
    ).resolves.toBeUndefined();

    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        publishRecordId: "pub-recovered",
        detail: expect.objectContaining({
          recoveredAfterMutating: true,
          reconciledFromPublishRecord: true,
          __result: null,
        }),
      }),
    );
  });

  it("returns recover value when publish_records and recover both prove the mutation", async () => {
    const mutate = vi.fn(async () => ({ commentId: 99 }));
    const recover = vi.fn(async () => ({
      kind: "reconciled" as const,
      value: { commentId: 7 },
    }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __mutating: true, step: "ask_reply" },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue("pub-recovered");

    const result = await withOperationIntent({
      ...baseParams,
      recover,
      mutate,
    });

    expect(result).toEqual({ commentId: 7 });
    expect(mutate).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        publishRecordId: "pub-recovered",
        detail: { __result: { commentId: 7 } },
      }),
    );
  });

  it("returns undefined on redelivery of reconciled intent without __result", async () => {
    const mutate = vi.fn(async () => "fresh");
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: "pub-1",
      detail: { recoveredAfterMutating: true },
    });

    await expect(withOperationIntent({ ...baseParams, mutate })).resolves.toBeUndefined();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("stashes exact-evidence recovery so a later retry returns the recovered value", async () => {
    const mutate = vi.fn(async () => ({ id: 99, updated: true }));
    const recoveredValue = { id: 42, updated: false };
    const recover = vi.fn(async () => ({
      kind: "reconciled" as const,
      value: recoveredValue,
    }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "outcome_unknown",
      publishRecordId: null,
      detail: { __mutating: false },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue(null);

    const first = await withOperationIntent({
      ...baseParams,
      recover,
      mutate,
    });

    expect(first).toEqual(recoveredValue);
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        detail: { __result: recoveredValue },
      }),
    );

    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: null,
      detail: { __result: recoveredValue },
    });
    recover.mockClear();

    const second = await withOperationIntent({
      ...baseParams,
      recover,
      mutate,
    });

    expect(second).toEqual(recoveredValue);
    expect(recover).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("returns recovered value when retrying an intent reconciled without stashed result but with recover hook", async () => {
    const mutate = vi.fn(async () => ({ id: 99, updated: true }));
    const recoveredValue = { id: 7, updated: false };
    const recover = vi.fn(async () => ({
      kind: "reconciled" as const,
      value: recoveredValue,
    }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: "pub-1",
      detail: { recoveredAfterMutating: true },
    });

    const result = await withOperationIntent({
      ...baseParams,
      recover,
      mutate,
    });

    expect(result).toEqual(recoveredValue);
    expect(mutate).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        detail: { __result: recoveredValue },
      }),
    );
  });

  it("throws outcome_unknown when typed recover finds no evidence on a reconciled intent without __result", async () => {
    const mutate = vi.fn(async () => ({ id: 99 }));
    const recover = vi.fn(async () => ({ kind: "absent" as const }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: null,
      detail: { recoveredAfterMutating: true },
    });

    await expect(withOperationIntent({ ...baseParams, recover, mutate })).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
    });
    expect(recover).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).not.toHaveBeenCalled();
  });

  it("returns undefined when a void reconciled intent has recover but no rebuilt value", async () => {
    const mutate = vi.fn(async () => undefined);
    const recover = vi.fn(async () => ({ kind: "absent" as const }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: "pub-1",
      detail: { recoveredAfterMutating: true },
    });

    await expect(
      withOperationIntent({
        ...baseParams,
        allowsUndefinedResult: true,
        recover,
        mutate,
      }),
    ).resolves.toBeUndefined();
    expect(recover).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        publishRecordId: "pub-1",
        detail: expect.objectContaining({ __result: null }),
      }),
    );
  });

  it("skips recover on redelivery after a void success stashes __result", async () => {
    const mutate = vi.fn(async () => undefined);
    const recover = vi.fn(async () => {
      throw new Error("github read failed");
    });
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: "pub-1",
      detail: { __result: null, reconciledFromPublishRecord: true },
    });

    await expect(
      withOperationIntent({
        ...baseParams,
        allowsUndefinedResult: true,
        recover,
        mutate,
      }),
    ).resolves.toBeUndefined();
    expect(recover).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("wraps a recover-hook failure on a reconciled intent without __result", async () => {
    const mutate = vi.fn(async () => ({ id: 99 }));
    const recover = vi.fn(async () => {
      throw new Error("evidence lookup failed");
    });
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: null,
      detail: { recoveredAfterMutating: true },
    });

    await expect(withOperationIntent({ ...baseParams, recover, mutate })).rejects.toMatchObject({
      code: "operation_intent.recovery_failed",
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("propagates leaseEpoch when reconciling exact-evidence recovery", async () => {
    const mutate = vi.fn(async () => ({ id: 99 }));
    const recoveredValue = { id: 7, updated: false };
    const recover = vi.fn(async () => ({
      kind: "reconciled" as const,
      value: recoveredValue,
    }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: null,
      detail: { recoveredAfterMutating: true },
    });

    const result = await withOperationIntent({
      ...baseParams,
      leaseEpoch: 7,
      recover,
      mutate,
    });

    expect(result).toEqual(recoveredValue);
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        status: "reconciled",
        leaseEpoch: 7,
      }),
    );
  });

  it("remutates after status failed even if __mutating residue remains", async () => {
    const mutate = vi.fn(async () => ({ commentId: 3 }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "failed",
      publishRecordId: null,
      detail: { __mutating: true, errorMessage: "502" },
    });

    const result = await withOperationIntent({ ...baseParams, mutate });
    expect(result).toEqual({ commentId: 3 });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(findCompletedPublishRecordId).not.toHaveBeenCalled();
  });

  it("wraps publish-record lookup failures without remutating", async () => {
    const mutate = vi.fn(async () => "fresh");
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __mutating: true },
    });
    vi.mocked(findCompletedPublishRecordId).mockRejectedValue(new Error("db timeout"));

    await expect(withOperationIntent({ ...baseParams, mutate })).rejects.toMatchObject({
      code: "operation_intent.publish_record_lookup_failed",
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("blocks an already-aborted mutation before persisting and normalizes string reasons", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const mutate = vi.fn(async () => "fresh");

    await expect(
      withOperationIntent({ ...baseParams, signal: controller.signal, mutate }),
    ).rejects.toMatchObject({ code: "agent_work.execution_aborted" });

    expect(persistOperationIntent).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("blocks cancelled recovery before reconciling a stashed result", async () => {
    const controller = new AbortController();
    vi.mocked(persistOperationIntent).mockImplementation(async () => {
      controller.abort("cancelled");
      return {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: "ask:reply:o/r#1",
        mutationKind: "github.ask_reply",
        status: "pending",
        publishRecordId: null,
        detail: { __result: "done" },
      };
    });
    const mutate = vi.fn(async () => "fresh");

    await expect(
      withOperationIntent({ ...baseParams, signal: controller.signal, mutate }),
    ).rejects.toMatchObject({ code: "agent_work.execution_aborted" });

    expect(reconcileOperationIntent).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("blocks cancelled recovery before reconciling an unknown mutation", async () => {
    const controller = new AbortController();
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __mutating: true },
    });
    vi.mocked(findCompletedPublishRecordId).mockImplementation(async () => {
      controller.abort("cancelled");
      return null;
    });
    const mutate = vi.fn(async () => "fresh");

    await expect(
      withOperationIntent({ ...baseParams, signal: controller.signal, mutate }),
    ).rejects.toMatchObject({ code: "agent_work.execution_aborted" });

    expect(reconcileOperationIntent).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("blocks stale durable completion when cancellation arrives during the remote call", async () => {
    const controller = new AbortController();
    const mutate = vi.fn(async () => {
      controller.abort(new AppError({ code: "agent_work.pr_actor_lease_lost", message: "lost" }));
      return { reviewId: 7 };
    });

    await expect(
      withOperationIntent({
        ...baseParams,
        signal: controller.signal,
        mutate,
      }),
    ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });

    expect(mutate).toHaveBeenCalledOnce();
    expect(reconcileOperationIntent).not.toHaveBeenCalled();
  });

  it("keeps publish-record proof when recover throws and stays outcome_unknown for typed T", async () => {
    const mutate = vi.fn(async () => ({ commentId: 9 }));
    const recover = vi.fn(async () => {
      throw new Error("github timeout");
    });
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __mutating: true },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue("pub-recovered");

    await expect(withOperationIntent({ ...baseParams, recover, mutate })).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ status: "outcome_unknown" }),
    );
  });

  it("stays outcome_unknown when recover is absent and publish_records cannot rebuild T", async () => {
    const mutate = vi.fn(async () => ({ commentId: 9 }));
    const recover = vi.fn(async () => ({ kind: "absent" as const }));
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __mutating: true },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValue("pub-recovered");

    await expect(withOperationIntent({ ...baseParams, recover, mutate })).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ status: "outcome_unknown" }),
    );
  });

  it("rechecks cancellation after recover finds evidence and before reconcile", async () => {
    const controller = new AbortController();
    const recover = vi.fn(async () => {
      controller.abort("cancelled");
      return { kind: "reconciled" as const, value: { commentId: 4 } };
    });
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "pending",
      publishRecordId: null,
      detail: { __mutating: true },
    });
    const mutate = vi.fn(async () => ({ commentId: 9 }));

    await expect(
      withOperationIntent({
        ...baseParams,
        signal: controller.signal,
        recover,
        mutate,
      }),
    ).rejects.toMatchObject({ code: "agent_work.execution_aborted" });

    expect(recover).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).not.toHaveBeenCalled();
  });

  it("reasserts the lease epoch immediately before and after the mutation", async () => {
    await withOperationIntent({
      ...baseParams,
      leaseEpoch: 9,
      mutate: async () => "ok",
    });

    expect(assertPrActorLeaseHeld).toHaveBeenCalledTimes(4);
    expect(assertPrActorLeaseHeld).toHaveBeenCalledWith(pool, "wi-1", 9);
    expect(persistOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ leaseEpoch: 9 }),
    );
  });
});
