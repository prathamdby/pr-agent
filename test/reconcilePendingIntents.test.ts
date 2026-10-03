import { createFakePublishStore } from "../src/agentWork/fakePublishStore.js";
const publishStoreState = vi.hoisted(() => {
  let store: import("../src/agentWork/publishOnce.js").PublishIntentStore;
  return {
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
  };
});
vi.mock("../src/agentWork/operationIntentRepository.js", () => ({
  persistOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.persistOperationIntent>) =>
      publishStoreState.store.persistOperationIntent(...args),
  ),
  mergeOperationIntentDetail: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.mergeOperationIntentDetail>) =>
      publishStoreState.store.mergeOperationIntentDetail(...args),
  ),
  reconcileOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.reconcileOperationIntent>) =>
      publishStoreState.store.reconcileOperationIntent(...args),
  ),
  getOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.getOperationIntent>) =>
      publishStoreState.store.getOperationIntent(...args),
  ),
  listPendingOperationIntents: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.listPendingOperationIntents>) =>
      publishStoreState.store.listPendingOperationIntents(...args),
  ),
}));
beforeEach(() => {
  publishStoreState.store = createFakePublishStore();
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.mock("../src/db/postgres.js", () => ({
  queryOne: vi.fn(),
}));

vi.unmock("../src/agentWork/reconcilePendingIntents.js");

const { queryOne } = await import("../src/db/postgres.js");
const { reconcilePendingIntents, findCompletedPublishRecordId } =
  await import("../src/agentWork/reconcilePendingIntents.js");

const pool = {} as Pool;

describe("reconcilePendingIntents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishStoreState.store = createFakePublishStore();
  });

  it("reconciles a pending intent when a matching completed publish_record exists", async () => {
    await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-1",
      operationKey: "review:summary:o/r#1",
      mutationKind: "github.review_summary",
      detail: { step: "review_summary", resourceKey: "o/r#1" },
    });
    vi.mocked(queryOne).mockResolvedValue({ id: "pub-42" });

    const result = await reconcilePendingIntents(pool, "wi-1");

    expect(result).toEqual({ reconciled: 1, stillPending: 0 });
    expect(
      await publishStoreState.store.getOperationIntent(pool, "wi-1", "review:summary:o/r#1"),
    ).toMatchObject({
      status: "reconciled",
      publishRecordId: "pub-42",
      detail: expect.objectContaining({
        step: "review_summary",
        reconciledFromPublishRecord: true,
      }),
    });
    expect(queryOne).toHaveBeenCalledWith(pool, expect.stringContaining("FROM publish_records"), [
      "wi-1",
      "review_summary",
      "o/r#1",
    ]);
  });

  it("leaves intents pending when no completed publish_record matches", async () => {
    await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-1",
      operationKey: "review:inline:batch-1",
      mutationKind: "github.review_inline",
      detail: { step: "review_inline", batchId: "batch-1" },
    });
    vi.mocked(queryOne).mockResolvedValue(null);

    const result = await reconcilePendingIntents(pool, "wi-1");

    expect(result).toEqual({ reconciled: 0, stillPending: 1 });
    expect(
      await publishStoreState.store.getOperationIntent(pool, "wi-1", "review:inline:batch-1"),
    ).toMatchObject({
      status: "pending",
      publishRecordId: null,
    });
  });

  it("skips intents whose detail has no string step", async () => {
    await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-1",
      operationKey: "broken:key",
      mutationKind: "github.review_summary",
      detail: { step: 12 },
    });

    const result = await reconcilePendingIntents(pool, "wi-1");

    expect(result).toEqual({ reconciled: 0, stillPending: 1 });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("matches triage reply intents by actedThreadIds from the operation key", async () => {
    await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-2",
      operationKey: "triage:thread:55",
      mutationKind: "github.triage_thread",
      detail: {
        step: "triage_thread_actions",
        reviewLens: "triage",
        resourceKey: "o/r#1",
        threadRootCommentId: 55,
      },
    });
    vi.mocked(queryOne).mockResolvedValue({ id: "pub-reply" });

    await reconcilePendingIntents(pool, "wi-2");

    expect(queryOne).toHaveBeenCalledWith(pool, expect.stringMatching(/actedThreadIds/), [
      "wi-2",
      "triage_thread_actions",
      "triage",
      "o/r#1",
      "55",
    ]);
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).not.toMatch(/threadRootCommentId/);
  });

  it("does not reconcile triage :resolve from the reply publish record", async () => {
    const intent = await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-2",
      operationKey: "triage:thread:55:resolve",
      mutationKind: "github.triage_thread_resolve",
      detail: {
        step: "triage_thread_actions",
        reviewLens: "triage",
        resourceKey: "o/r#1",
        threadRootCommentId: 55,
      },
    });

    await expect(findCompletedPublishRecordId(pool, "wi-2", intent)).resolves.toBeNull();
    expect(queryOne).not.toHaveBeenCalled();

    const result = await reconcilePendingIntents(pool, "wi-2");
    expect(result).toEqual({ reconciled: 0, stillPending: 1 });
    expect(
      await publishStoreState.store.getOperationIntent(pool, "wi-2", "triage:thread:55:resolve"),
    ).toMatchObject({
      status: "pending",
    });
  });

  it("matches verification thread intents against the ADR-0023 threads ledger", async () => {
    await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-3",
      operationKey: "verification:thread:99",
      mutationKind: "github.verification_thread",
      detail: {
        step: "verification_thread_actions",
        reviewLens: "verification",
        resourceKey: "o/r#1",
        threadRootCommentId: 99,
      },
    });
    vi.mocked(queryOne).mockResolvedValue({ id: "pub-v" });

    await reconcilePendingIntents(pool, "wi-3");

    expect(queryOne).toHaveBeenCalledWith(pool, expect.stringMatching(/detail -> 'threads' \?/), [
      "wi-3",
      "verification_thread_actions",
      "verification",
      "o/r#1",
      "99",
    ]);
  });

  it("includes batchId filters when present on the intent", async () => {
    await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-2",
      operationKey: "review:inline:t-9",
      mutationKind: "github.review_inline",
      detail: {
        step: "review_inline",
        reviewLens: "correctness",
        batchId: "b-9",
      },
    });
    vi.mocked(queryOne).mockResolvedValue({ id: "pub-9" });

    await reconcilePendingIntents(pool, "wi-2");

    expect(queryOne).toHaveBeenCalledWith(
      pool,
      expect.stringMatching(/review_lens[\s\S]*batches/),
      ["wi-2", "review_inline", "correctness", "b-9"],
    );
  });

  it("does not double-count already-reconciled intents", async () => {
    await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-1",
      operationKey: "review:summary:o/r#1",
      mutationKind: "github.review_summary",
      detail: { step: "review_summary" },
    });
    await publishStoreState.store.reconcileOperationIntent(pool, {
      workItemId: "wi-1",
      operationKey: "review:summary:o/r#1",
      status: "reconciled",
      publishRecordId: "pub-old",
    });
    await publishStoreState.store.persistOperationIntent(pool, {
      workItemId: "wi-1",
      operationKey: "review:inline:batch-2",
      mutationKind: "github.review_inline",
      detail: { step: "review_inline", batchId: "batch-2" },
    });
    vi.mocked(queryOne).mockResolvedValue({ id: "pub-new" });

    const result = await reconcilePendingIntents(pool, "wi-1");

    expect(result).toEqual({ reconciled: 1, stillPending: 0 });
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(
      await publishStoreState.store.getOperationIntent(pool, "wi-1", "review:summary:o/r#1"),
    ).toMatchObject({
      status: "reconciled",
      publishRecordId: "pub-old",
    });
    expect(
      await publishStoreState.store.getOperationIntent(pool, "wi-1", "review:inline:batch-2"),
    ).toMatchObject({
      status: "reconciled",
      publishRecordId: "pub-new",
    });
  });
});
