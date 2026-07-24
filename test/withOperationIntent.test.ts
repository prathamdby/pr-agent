import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { AppError } from "../src/errors/appError.js";

vi.unmock("../src/agentWork/withOperationIntent.js");
vi.unmock("../src/agentWork/reconcilePendingIntents.js");

vi.mock("../src/agentWork/operationIntentRepository.js", () => ({
  persistOperationIntent: vi.fn(),
  reconcileOperationIntent: vi.fn(),
}));

import {
  persistOperationIntent,
  reconcileOperationIntent,
} from "../src/agentWork/operationIntentRepository.js";
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
    vi.mocked(reconcileOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      mutationKind: "github.ask_reply",
      status: "reconciled",
      publishRecordId: null,
      detail: {},
    });
  });

  it("persists intent before running the mutation", async () => {
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

    const result = await withOperationIntent({
      ...baseParams,
      mutate: async () => {
        calls.push("mutate");
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(calls).toEqual(["persist", "mutate"]);
    expect(persistOperationIntent).toHaveBeenCalledBefore(vi.mocked(reconcileOperationIntent));
  });

  it("reconciles to reconciled after a successful mutation", async () => {
    await withOperationIntent({
      ...baseParams,
      publishRecordId: "pub-1",
      mutate: async () => "done",
    });

    expect(reconcileOperationIntent).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      operationKey: "ask:reply:o/r#1",
      status: "reconciled",
      publishRecordId: "pub-1",
      detail: { __result: "done" },
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
});
