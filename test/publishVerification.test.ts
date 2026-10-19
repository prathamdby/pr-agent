const publicationWrites = vi.hoisted(() => ({
  write: vi
    .fn<import("../src/agentWork/publishOnce.ts").PublishRecordStore["write"]>()
    .mockResolvedValue(undefined),
}));
vi.mock("../src/agentWork/publishOnce.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/publishOnce.ts")>();
  return {
    ...actual,
    createPublishContext: (
      client: import("pg").Pool | import("pg").PoolClient,
      identity: import("../src/agentWork/publishOnce.ts").PublicationIdentity,
    ) =>
      actual.createPublishContext(client, identity, {
        ...actual.postgresPublishRecords,
        write: publicationWrites.write,
      }),
  };
});
const recordPublishStep = publicationWrites.write;
import { createFakePublishStore } from "../src/agentWork/fakePublishStore.ts";
const publishStoreState = vi.hoisted(() => {
  let store: import("../src/agentWork/publishOnce.ts").PublishIntentStore;
  return {
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
  };
});
vi.mock("../src/agentWork/operationIntentRepository.ts", () => ({
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
vi.mock("../src/review/findingIdentity/threadMutationLock.ts", () => ({
  threadMutationLock:
    (): import("../src/review/findingIdentity/threadMutationLock.ts").ThreadMutationLock =>
    (apply) =>
      apply(),
}));
vi.mock("../src/agentWork/reconcilePendingIntents.ts", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  findCompletedPublishRecordId: vi.fn(async () => null),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.ts";
import { legacyFindingId } from "../src/review/findingIdentity/findingMarker.ts";
import type { ReviewThreadResolution } from "../src/github/reviewThreadResolution.ts";
import type { VerificationPayload } from "../src/review/triageSchema.ts";
import { REVIEW_SUMMARY_SENTINEL, VERIFICATION_STUB_MARKER } from "../src/settings/index.ts";
import { renderCiSummaryCell } from "../src/review/ci/ciSummaryCell.ts";
import {
  publishTestPrSurface,
  resolveThreadIds,
  editReviewCommentEvents,
} from "./helpers/publishPrSurface.ts";

import { isEffectiveVerificationSignalTransition } from "../src/agentWork/prHeadCiState.ts";
import {
  operationIntentMarker,
  verificationObjectionAnswerOperationKey,
} from "../src/agentWork/publishOnce.ts";
import { renderObjectionAnswerMarker } from "../src/review/findingIdentity/findingMarker.ts";
import type { FindingObjection } from "../src/review/run/reviewPriorFeedback.ts";
import { AppError } from "../src/errors/appError.ts";
import { findCompletedPublishRecordId } from "../src/agentWork/reconcilePendingIntents.ts";

vi.mock("../src/agentWork/ciProjection.ts", () => ({
  requestHeadCiProjection: vi.fn().mockResolvedValue("enqueued"),
}));

vi.mock("../src/agentWork/prHeadCiState.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prHeadCiState.ts")>();
  return {
    ...actual,
    advancePrHeadCiRevisionForVerificationSignal: vi
      .fn()
      .mockResolvedValue({ version: 1, bumped: true }),
  };
});

vi.mock("../src/agentWork/prActorLease.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prActorLease.ts")>();
  return {
    ...actual,
    assertPrActorLeaseHeld: vi.fn().mockResolvedValue(undefined),
    isPrActorLeaseHeld: vi.fn().mockResolvedValue(true),
  };
});

import { publishVerification } from "../src/agent/verification/publishVerification.ts";
import {
  clearVerificationFailureSignal,
  publishVerificationFailure,
} from "../src/agent/verification/publishVerificationFailure.ts";

describe("verification failure projection transitions", () => {
  it("does not advance a new head when clearing a failure from an old head", () => {
    expect(
      isEffectiveVerificationSignalTransition(
        { active: true, headSha: "old-head" },
        { active: false, headSha: "new-head" },
      ),
    ).toBe(false);
    expect(
      isEffectiveVerificationSignalTransition(
        { active: true, headSha: "same-head" },
        { active: false, headSha: "same-head" },
      ),
    ).toBe(true);
  });
});

const OBJECTION_UPDATED_AT = "2026-01-01T14:32:47Z";
const ROOT_CREATED_AT = "2026-01-01T14:00:00Z";

function findingObjection(overrides: Partial<FindingObjection> = {}): FindingObjection {
  return {
    commentId: 50,
    createdAt: OBJECTION_UPDATED_AT,
    updatedAt: OBJECTION_UPDATED_AT,
    authorUserId: 10,
    association: "NONE",
    authorized: false,
    body: "The lock is held outside the write.",
    ...overrides,
  };
}

function seedLiveObjection(updatedAt = OBJECTION_UPDATED_AT, body = findingObjection().body): void {
  controls.setReviewComments([
    {
      id: 1,
      inReplyToId: null,
      pullRequestReviewId: null,
      userId: 1,
      authorLogin: "pr-agent[bot]",
      authorAssociation: null,
      authorType: "Bot",
      createdAt: ROOT_CREATED_AT,
      updatedAt: ROOT_CREATED_AT,
      body: "**P1** · **Bug**",
      path: "src/app.ts",
      line: 1,
      originalLine: 1,
      htmlUrl: "",
    },
    {
      id: 50,
      inReplyToId: 1,
      pullRequestReviewId: null,
      userId: 10,
      authorLogin: "alice",
      authorAssociation: "NONE",
      authorType: "User",
      createdAt: updatedAt,
      updatedAt,
      body,
      path: null,
      line: null,
      originalLine: null,
      htmlUrl: "",
    },
  ]);
}

function objectionIntentMarker(updatedAt = OBJECTION_UPDATED_AT): string {
  return operationIntentMarker(verificationObjectionAnswerOperationKey(1, 50, updatedAt), "wi");
}

const thread = {
  rootCommentId: 1,
  findingId: legacyFindingId("PRRT_1"),
  lens: "review" as const,
  path: "src/app.ts",
  line: 1,
  severity: "P1" as const,
  titleSnippet: "P1 · Bug",
  humanReplies: [],
  threadUrl: "https://github.test/thread",
} satisfies BotFindingThread;

const secondThread = {
  ...thread,
  rootCommentId: 2,
  findingId: legacyFindingId("PRRT_2"),
  titleSnippet: "P2 · Other",
} satisfies BotFindingThread;

const thirdThread = {
  ...thread,
  rootCommentId: 3,
  findingId: legacyFindingId("PRRT_3"),
  path: "src/other.ts",
  titleSnippet: "P1 · Unchanged path",
} satisfies BotFindingThread;

function pool(detail?: unknown): Pool {
  const client = {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  };
  return {
    query: vi.fn(async () => ({ rows: detail === undefined ? [] : [{ detail }] })),
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function resolutionMap(
  entries: readonly [number, ReviewThreadResolution][],
): Map<number, ReviewThreadResolution> {
  return new Map(entries);
}

let controls: import("../src/github/fakePrSurface.ts").FakePrSurfaceControls;

function baseParams(overrides: {
  readonly payload: VerificationPayload;
  readonly inventory?: readonly BotFindingThread[];
  readonly resolutionByRootCommentId?: ReadonlyMap<number, ReviewThreadResolution>;
  readonly changedFilePaths?: readonly string[];
  readonly changedFilePathsTruncated?: boolean;
  readonly pool?: Pool;
  readonly workItemId?: string;
  readonly leaseEpoch?: number | null;
  readonly policyResult?: Parameters<typeof publishVerification>[0]["policyResult"];
  readonly threads?: ReadonlyMap<number, ReviewThreadResolution>;
  readonly stubBodies?: Readonly<Record<number, string>>;
}) {
  const fake = publishTestPrSurface(
    overrides.threads ??
      overrides.resolutionByRootCommentId ??
      resolutionMap([
        [1, { threadNodeId: "PRRT_1", isResolved: false }],
        [2, { threadNodeId: "PRRT_2", isResolved: false }],
        [3, { threadNodeId: "PRRT_3", isResolved: false }],
      ]),
  );
  controls = fake.controls;
  for (const inventoryThread of overrides.inventory ?? [thread, secondThread, thirdThread]) {
    const stubId =
      "verificationStubCommentId" in inventoryThread
        ? inventoryThread.verificationStubCommentId
        : undefined;
    if (stubId != null) {
      fake.controls.setReviewCommentBody(stubId, `${VERIFICATION_STUB_MARKER}\nstub`);
    }
  }
  for (const [stubId, body] of Object.entries(overrides.stubBodies ?? {})) {
    fake.controls.setReviewCommentBody(Number(stubId), body);
  }
  return {
    pool: overrides.pool ?? pool(),
    workItemId: overrides.workItemId ?? "wi",
    leaseEpoch: overrides.leaseEpoch ?? 1,
    installationId: 1,
    resourceKey: "o/r#1",
    prSurface: fake.surface,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    inventory: overrides.inventory ?? [thread, secondThread, thirdThread],
    resolutionByRootCommentId:
      overrides.resolutionByRootCommentId ??
      resolutionMap([
        [1, { threadNodeId: "PRRT_1", isResolved: false }],
        [2, { threadNodeId: "PRRT_2", isResolved: false }],
        [3, { threadNodeId: "PRRT_3", isResolved: false }],
      ]),
    payload: overrides.payload,
    changedFilePaths: overrides.changedFilePaths ?? ["src/app.ts"],
    changedFilePathsTruncated: overrides.changedFilePathsTruncated,
    policyResult: overrides.policyResult ?? ({ kind: "absent" } as const),
  };
}

describe("publishVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not reopen a partially accepted dismissal after resolve is denied", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: {
        verdicts: [{ verdict: "dismissed", threadRootCommentId: 1, evidence: "intentional" }],
      },
    });
    const resolve = vi
      .spyOn(params.prSurface, "resolveInlineReviewThread")
      .mockRejectedValue(
        Object.assign(new Error("Forbidden"), { status: 403, mutationAccepted: false }),
      );
    await expect(publishVerification(params)).rejects.toBeDefined();
    expect(
      await publishStoreState.store.getOperationIntent(params.pool, "wi", "verification:thread:1"),
    ).toMatchObject({ status: "outcome_unknown" });
    await expect(publishVerification(params)).rejects.toBeDefined();
    expect(controls.replies).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("does not recover dismissal solely from an externally resolved thread", async () => {
    const params = baseParams({
      inventory: [thread],
      resolutionByRootCommentId: resolutionMap([[1, { threadNodeId: "PRRT_1", isResolved: true }]]),
      payload: {
        verdicts: [{ verdict: "dismissed", threadRootCommentId: 1, evidence: "intentional" }],
      },
    });
    vi.spyOn(params.prSurface, "replyAt").mockRejectedValue(new Error("Connection lost"));
    await expect(publishVerification(params)).rejects.toBeDefined();
    expect(recordPublishStep).not.toHaveBeenCalled();
    await expect(publishVerification(params)).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
    });
    expect(controls.replies).toHaveLength(0);
  });

  it("recovers a silent resolve without fabricating a stub comment id", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "abcdef1", evidence: "fixed" },
        ],
      },
    });
    const original = params.prSurface.resolveInlineReviewThread.bind(params.prSurface);
    vi.spyOn(params.prSurface, "resolveInlineReviewThread").mockImplementation(async (id) => {
      await original(id);
      throw new Error("Lost response after acceptance");
    });
    await expect(publishVerification(params)).resolves.toEqual({ degradation: [] });
    expect(controls.replies).toHaveLength(0);
    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": expect.objectContaining({
              completion: {
                workItemId: "wi",
                operationKey: "verification:thread:1",
                headSha: params.headSha,
                verdict: "fixed",
                stubOutcome: "not_required",
                resolutionOutcome: "resolved",
              },
            }),
          },
        },
      }),
    );
  });

  it("keeps unavailable resolution recovery transient without remutating", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "abcdef1", evidence: "fixed" },
        ],
      },
    });
    vi.spyOn(params.prSurface, "resolveInlineReviewThread").mockRejectedValue(
      new Error("Lost response"),
    );
    vi.spyOn(params.prSurface, "listInlineReviewThreads").mockResolvedValue({
      byRootCommentId: new Map(),
      threads: [],
      status: "partial",
      truncated: true,
    });
    await expect(publishVerification(params)).rejects.toMatchObject({
      code: "operation_intent.recovery_failed",
    });
    await expect(publishVerification(params)).rejects.toMatchObject({
      code: "operation_intent.recovery_failed",
      context: expect.not.objectContaining({ unknownResolution: "terminal" }),
    });
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("does not recover a required prior stub edit from resolved state without its marker", async () => {
    const params = baseParams({
      inventory: [{ ...thread, verificationStubCommentId: 555 }],
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "abcdef1", evidence: "fixed" },
        ],
      },
    });
    vi.spyOn(params.prSurface, "editReviewComment").mockRejectedValue(new Error("Lost response"));
    controls.setThreads(resolutionMap([[1, { threadNodeId: "PRRT_1", isResolved: true }]]));
    await expect(publishVerification(params)).rejects.toBeDefined();
    expect(recordPublishStep).not.toHaveBeenCalled();
    expect(controls.replies).toHaveLength(0);
  });

  it("does not treat a capped child receipt read as absence", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: Array.from({ length: 16 }, () => ({ detail: {} })) })),
    } as unknown as Pool;
    const params = baseParams({
      pool: db,
      inventory: [thread],
      payload: { verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "still open" }] },
    });
    vi.spyOn(params.prSurface, "replyAt").mockRejectedValue(new Error("Lost response"));
    await expect(publishVerification(params)).rejects.toMatchObject({
      code: "operation_intent.recovery_failed",
    });
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("preserves actionable permanent denial even when later evidence reads are unavailable", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: {
        verdicts: [{ verdict: "dismissed", threadRootCommentId: 1, evidence: "intentional" }],
      },
    });
    const denial = new AppError({
      domain: "github",
      kind: "review_thread_resolution_denied",
      message: "Denied",
      context: { threadNodeId: "PRRT_1", mutationAccepted: false },
    });
    vi.spyOn(params.prSurface, "resolveInlineReviewThread").mockRejectedValue(denial);
    vi.spyOn(params.prSurface, "listInlineReviewThreads").mockRejectedValue(
      new Error("Read unavailable"),
    );
    await expect(publishVerification(params)).rejects.toBe(denial);
    expect(
      await publishStoreState.store.getOperationIntent(params.pool, "wi", "verification:thread:1"),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(controls.replies).toHaveLength(1);
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("does not reopen a cached terminal legacy intent even if its marker later appears", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: { verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "still open" }] },
    });
    await publishStoreState.store.persistOperationIntent(params.pool, {
      workItemId: "wi",
      operationKey: "verification:thread:1",
      mutationKind: "github.verification_thread",
      detail: { verdict: "skipped" },
    });
    await publishStoreState.store.reconcileOperationIntent(params.pool, {
      workItemId: "wi",
      operationKey: "verification:thread:1",
      status: "outcome_unknown",
      detail: { unknownResolution: "terminal" },
    });
    controls.setReviewCommentBody(555, operationIntentMarker("verification:thread:1", "wi"));
    await expect(publishVerification(params)).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
      context: { unknownResolution: "terminal" },
    });
    expect(controls.replies).toHaveLength(0);
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("recovers a completed parent from its exact receipt when provider evidence is no longer readable", async () => {
    const completion = {
      workItemId: "wi",
      operationKey: "verification:thread:1",
      headSha: "a".repeat(40),
      verdict: "dismissed",
      stubOutcome: "written",
      stubCommentId: 555,
      resolutionOutcome: "resolved",
    };
    const params = baseParams({
      pool: pool({ threads: { "1": { lastVerdict: "dismissed", completion } } }),
      inventory: [thread],
      payload: {
        verdicts: [{ verdict: "dismissed", threadRootCommentId: 1, evidence: "intentional" }],
      },
    });
    await publishStoreState.store.persistOperationIntent(params.pool, {
      workItemId: "wi",
      operationKey: completion.operationKey,
      mutationKind: "github.verification_thread",
      detail: {
        step: "verification_thread_actions",
        headSha: params.headSha,
        verdict: "dismissed",
        requiresStub: true,
        __mutating: true,
      },
    });
    vi.mocked(findCompletedPublishRecordId).mockResolvedValueOnce("pub-exact");
    vi.spyOn(params.prSurface, "listReviewComments").mockRejectedValue(
      new Error("Read unavailable"),
    );
    vi.spyOn(params.prSurface, "listInlineReviewThreads").mockRejectedValue(
      new Error("Read unavailable"),
    );
    await expect(publishVerification(params)).resolves.toEqual({ degradation: [] });
    expect(controls.replies).toHaveLength(0);
    expect(
      await publishStoreState.store.getOperationIntent(params.pool, "wi", completion.operationKey),
    ).toMatchObject({ status: "reconciled", detail: { __result: 555 } });
  });

  it("does not guess resolve-only requirements for an interrupted legacy fixed parent", async () => {
    const params = baseParams({
      inventory: [thread],
      resolutionByRootCommentId: resolutionMap([[1, { threadNodeId: "PRRT_1", isResolved: true }]]),
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "abcdef1", evidence: "fixed" },
        ],
      },
    });
    await publishStoreState.store.persistOperationIntent(params.pool, {
      workItemId: "wi",
      operationKey: "verification:thread:1",
      mutationKind: "github.verification_thread",
      detail: { verdict: "fixed", __mutating: true },
    });
    await expect(publishVerification(params)).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
    });
    expect(recordPublishStep).not.toHaveBeenCalled();
    expect(controls.replies).toHaveLength(0);
  });

  it("silently resolves fixed and already-resolved threads without replying", async () => {
    const result = await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "null check added",
            },
            {
              verdict: "already-resolved",
              threadRootCommentId: 2,
              evidence: "code already guards this path",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degradation: [] });
    expect(controls.replies).toHaveLength(0);
    expect(controls.events.filter((e) => e.kind === "editReviewComment")).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(2);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_thread_actions",
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
              completion: expect.any(Object),
            },
          },
        },
      }),
    );
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_thread_actions",
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
              completion: expect.any(Object),
            },
            "2": {
              lastVerdict: "already-resolved",
              lastHeadSha: "a".repeat(40),
              terminal: true,
              completion: expect.any(Object),
            },
          },
        },
      }),
    );
  });

  it("skips resolve when the thread is already resolved", async () => {
    await publishVerification(
      baseParams({
        resolutionByRootCommentId: resolutionMap([
          [1, { threadNodeId: "PRRT_1", isResolved: true }],
        ]),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
              completion: expect.any(Object),
            },
          },
        },
      }),
    );
  });

  it("edits a prior still-open stub when later marking fixed", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped", lastHeadSha: "b".repeat(40) },
          },
        }),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "tests cover the case",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    const edit = editReviewCommentEvents(controls)[0];
    expect(edit?.commentId).toBe(555);
    expect(edit?.body).toContain("**Verification**: Fixed");
    expect(edit?.body).toContain(VERIFICATION_STUB_MARKER);
    expect(edit?.body).not.toContain("Still open");
    expect(resolveThreadIds(controls)).toContain("PRRT_1");
  });

  it("creates a marked still-open stub only for findings on changed files", async () => {
    await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "guard still missing",
            },
            {
              verdict: "skipped",
              threadRootCommentId: 3,
              reason: "still open but file unchanged",
            },
          ],
        },
      }),
    );

    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.target).toEqual(
      expect.objectContaining({ kind: "inlineReviewThread", inReplyToCommentId: 1 }),
    );
    expect(controls.replies[0]?.body).toContain(VERIFICATION_STUB_MARKER);
    expect(controls.replies[0]?.body).toContain("Still open");
  });

  it("does not suppress still-open stubs for omitted paths when compare is truncated", async () => {
    const result = await publishVerification(
      baseParams({
        changedFilePaths: ["src/app.ts"],
        changedFilePathsTruncated: true,
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "still open on listed path",
            },
            {
              verdict: "skipped",
              threadRootCommentId: 3,
              reason: "still open on omitted path",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degradation: ["compare_files_truncated"] });
    expect(controls.replies).toHaveLength(2);
    expect(
      controls.replies.some(
        (r) => r.target.kind === "inlineReviewThread" && r.target.inReplyToCommentId === 1,
      ),
    ).toBe(true);
    expect(
      controls.replies.some(
        (r) => r.target.kind === "inlineReviewThread" && r.target.inReplyToCommentId === 3,
      ),
    ).toBe(true);
  });

  it("edits an existing stub in place on later still-open publishes", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped", lastHeadSha: "b".repeat(40) },
          },
        }),
        stubBodies: { 555: `${VERIFICATION_STUB_MARKER}\nstub` },
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "still open after push",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    expect(editReviewCommentEvents(controls)).toHaveLength(1);
    expect(editReviewCommentEvents(controls)[0]?.commentId).toBe(555);
    expect(editReviewCommentEvents(controls)[0]?.body).toContain("still open after push");
  });

  it("recovers stub id from inventory marker when ledger lacks stubCommentId", async () => {
    await publishVerification(
      baseParams({
        inventory: [{ ...thread, verificationStubCommentId: 777 }],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "recovered",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    expect(controls.events.some((e) => e.kind === "editReviewComment" && e.commentId === 777)).toBe(
      true,
    );
  });

  it("dismisses by editing stub, grounding policy, and resolving the thread", async () => {
    await publishVerification(
      baseParams({
        inventory: [
          { ...thread, humanReplies: ["false positive"], verificationStubCommentId: 555 },
        ],
        policyResult: {
          kind: "ok",
          policy: {
            rules: [
              {
                filename: "src.mdc",
                relativePath: ".pr-agent/src.mdc",
                alwaysApply: false,
                globs: ["src/**"],
                body: "existing",
              },
            ],
          },
        },
        payload: {
          verdicts: [
            {
              verdict: "dismissed",
              threadRootCommentId: 1,
              evidence: "maintainer marked false positive",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    expect(controls.events.filter((e) => e.kind === "editReviewComment")).toHaveLength(1);
    const body =
      (controls.events.find((e) => e.kind === "editReviewComment") as { body: string } | undefined)
        ?.body ?? "";
    expect(body).toContain("Dismissed");
    expect(body).toContain("Append this to `.pr-agent/src.mdc`:");
    expect(body).not.toContain("pathInstructions");
    expect(body).not.toContain(".pr-agent.yml");
    expect(resolveThreadIds(controls)).toContain("PRRT_1");
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              stubCommentId: 555,
              lastVerdict: "dismissed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
              completion: expect.any(Object),
            },
          },
        },
      }),
    );
  });

  it("creates then resolves when dismissing without an existing stub", async () => {
    await publishVerification(
      baseParams({
        inventory: [{ ...thread, humanReplies: ["intentional"] }],
        payload: {
          verdicts: [
            {
              verdict: "dismissed",
              threadRootCommentId: 1,
              evidence: "intentional",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(1);
    expect(resolveThreadIds(controls)).toHaveLength(1);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": expect.objectContaining({
              stubCommentId: expect.any(Number),
              lastVerdict: "dismissed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
              completion: expect.any(Object),
            }),
          },
        },
      }),
    );
  });

  it("reports verdict_mapping_incomplete when inventory mapping is missing", async () => {
    const result = await publishVerification(
      baseParams({
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 99,
              reason: "orphan",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degradation: ["verdict_mapping_incomplete"] });
    expect(controls.replies).toHaveLength(0);
  });

  it("reports verdict_mapping_incomplete when fixed thread has no resolution mapping", async () => {
    const result = await publishVerification(
      baseParams({
        inventory: [thread],
        resolutionByRootCommentId: resolutionMap([]),
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degradation: ["verdict_mapping_incomplete"] });
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(controls.replies).toHaveLength(0);
  });

  it("deduplicates one reason for the whole publish-mapping family", async () => {
    const result = await publishVerification(
      baseParams({
        changedFilePathsTruncated: true,
        inventory: [thread],
        resolutionByRootCommentId: resolutionMap([]),
        payload: {
          verdicts: [
            { verdict: "fixed", threadRootCommentId: 1, commitSha: "abcdef1", evidence: "fixed" },
            { verdict: "skipped", threadRootCommentId: 99, reason: "orphan" },
          ],
        },
      }),
    );

    expect(result).toEqual({
      degradation: ["compare_files_truncated", "verdict_mapping_incomplete"],
    });
  });

  it("mixes silent resolve with still-open stub creates in one payload", async () => {
    await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
            {
              verdict: "skipped",
              threadRootCommentId: 2,
              reason: "still broken",
            },
          ],
        },
      }),
    );

    expect(resolveThreadIds(controls)).toHaveLength(1);
    expect(resolveThreadIds(controls)).toContain("PRRT_1");
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.body).toContain("Still open");
  });

  it("falls back to create when updating a deleted stub returns 404", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped" },
          },
        }),
        stubBodies: {},
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "stub was deleted",
            },
          ],
        },
      }),
    );

    expect(controls.events.some((e) => e.kind === "editReviewComment" && e.commentId === 555)).toBe(
      true,
    );
    expect(controls.replies).toHaveLength(1);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": expect.objectContaining({
              stubCommentId: expect.any(Number),
              lastVerdict: "skipped",
              lastHeadSha: "a".repeat(40),
            }),
          },
        },
      }),
    );
  });

  it("preserves stubCommentId when a later fixed verdict has no stub id", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped" },
          },
        }),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
          ],
        },
      }),
    );

    expect(controls.replies).toHaveLength(0);
    const edit = editReviewCommentEvents(controls)[0];
    expect(edit?.commentId).toBe(555);
    expect(edit?.body).toContain("**Verification**: Fixed");
    expect(resolveThreadIds(controls)).toHaveLength(1);
    expect(vi.mocked(recordPublishStep)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              stubCommentId: 555,
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
              completion: expect.objectContaining({ stubOutcome: "missing" }),
            },
          },
        },
      }),
    );
  });

  it("loads ledger by resource key so prior stubs survive a new work item", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          detail: {
            threads: {
              "1": { stubCommentId: 4242, lastVerdict: "skipped" },
            },
          },
        },
      ],
    }));
    await publishVerification(
      baseParams({
        pool: { query } as unknown as Pool,
        workItemId: "wi-new",
        leaseEpoch: 1,
        stubBodies: { 4242: `${VERIFICATION_STUB_MARKER}\nstub` },
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "cross work item",
            },
          ],
        },
      }),
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("resource_key"),
      expect.arrayContaining(["o/r#1"]),
    );
    expect(
      controls.events.some((e) => e.kind === "editReviewComment" && e.commentId === 4242),
    ).toBe(true);
    expect(controls.replies).toHaveLength(0);
  });

  it("leaves zero conversation output on a successful silent-resolve run", async () => {
    await publishVerification(
      baseParams({
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "null check added",
            },
          ],
        },
      }),
    );

    expect(
      controls.events.filter((event) => event.kind === "listConversationComments"),
    ).toHaveLength(0);
    expect(controls.events.filter((event) => event.kind === "editComment")).toHaveLength(0);
    expect(controls.events.filter((event) => event.kind === "upsertProgressComment")).toHaveLength(
      0,
    );
    expect(controls.replies).toHaveLength(0);
    expect(controls.events.filter((event) => event.kind === "editReviewComment")).toHaveLength(0);
  });

  it("answers an objection on an unchanged skipped thread without writing a stub", async () => {
    const params = baseParams({
      inventory: [{ ...thread, path: "src/quiet.ts", objections: [findingObjection()] }],
      changedFilePaths: ["src/app.ts"],
      payload: {
        verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "file did not change" }],
        objectionDecisions: [
          {
            decision: "hold",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "The write still races.",
          },
        ],
      },
    });
    seedLiveObjection();

    await publishVerification(params);

    expect(controls.replies).toHaveLength(1);
    const body = controls.replies[0]?.body ?? "";
    expect(body.startsWith("**Verification reply**:")).toBe(true);
    expect(body).toContain(renderObjectionAnswerMarker(50, OBJECTION_UPDATED_AT));
    expect(body).toContain(objectionIntentMarker());
    expect(body).not.toContain(VERIFICATION_STUB_MARKER);
    expect(resolveThreadIds(controls)).toEqual([]);

    await publishVerification(params);
    expect(controls.replies).toHaveLength(1);
  });

  it("publishes one objection-answer marker after the model echoes others", async () => {
    const foreign = renderObjectionAnswerMarker(99, "2026-01-02T00:00:00Z");
    const echoed = renderObjectionAnswerMarker(50, OBJECTION_UPDATED_AT);
    const params = baseParams({
      inventory: [{ ...thread, path: "src/quiet.ts", objections: [findingObjection()] }],
      changedFilePaths: ["src/app.ts"],
      payload: {
        verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "file did not change" }],
        objectionDecisions: [
          {
            decision: "hold",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: `The write still races.\n${foreign}\n${echoed}\n<!--  pr-agent:objection-answer v=1 c=77 u=2026-02-02T00:00:00Z -->`,
          },
        ],
      },
    });
    seedLiveObjection();

    await publishVerification(params);

    const body = controls.replies[0]?.body ?? "";
    const authoritative = renderObjectionAnswerMarker(50, OBJECTION_UPDATED_AT);
    expect(body.startsWith("**Verification reply**:")).toBe(true);
    expect(body).toContain("The write still races.");
    expect(body).not.toContain(foreign);
    expect(body).not.toContain("c=77");
    expect(body.split(authoritative)).toHaveLength(2);
    expect(body).toContain(objectionIntentMarker());
  });

  it("posts one fixed answer, names the commit, and resolves without a second reply", async () => {
    const params = baseParams({
      inventory: [{ ...thread, objections: [findingObjection({ authorized: true })] }],
      payload: {
        verdicts: [
          {
            verdict: "fixed",
            threadRootCommentId: 1,
            commitSha: "abcdef1",
            evidence: "guarded",
          },
        ],
        objectionDecisions: [
          {
            decision: "concede",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "The race is gone.",
          },
        ],
      },
    });
    seedLiveObjection();

    await publishVerification(params);

    expect(controls.replies).toHaveLength(1);
    const body = controls.replies[0]?.body ?? "";
    expect(body.startsWith("**Verification reply**:")).toBe(true);
    expect(body).toContain("abcdef1");
    expect(body).not.toContain(VERIFICATION_STUB_MARKER);
    expect(resolveThreadIds(controls)).toEqual(["PRRT_1"]);
  });

  it("posts an authorized dismissal answer, then the stub and receipt, then resolves", async () => {
    const params = baseParams({
      inventory: [
        { ...thread, objections: [findingObjection({ authorized: true, association: "OWNER" })] },
      ],
      payload: {
        verdicts: [{ verdict: "dismissed", threadRootCommentId: 1, evidence: "intentional" }],
        objectionDecisions: [
          {
            decision: "concede",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "A maintainer already accepted this.",
          },
        ],
      },
    });
    seedLiveObjection();

    await publishVerification(params);

    expect(controls.replies).toHaveLength(2);
    const answer = controls.replies[0]?.body ?? "";
    const stub = controls.replies[1]?.body ?? "";
    expect(answer.startsWith("**Verification reply**:")).toBe(true);
    expect(answer).not.toContain(VERIFICATION_STUB_MARKER);
    expect(stub).toContain(VERIFICATION_STUB_MARKER);
    expect(stub).toContain("kind=dismissed");
    expect(resolveThreadIds(controls)).toEqual(["PRRT_1"]);
  });

  it("does not dismiss an unauthorized concede and tells the reader a maintainer can", async () => {
    const params = baseParams({
      inventory: [{ ...thread, objections: [findingObjection()] }],
      payload: {
        verdicts: [{ verdict: "already-resolved", threadRootCommentId: 1, evidence: "gone" }],
        objectionDecisions: [
          {
            decision: "concede",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "The check landed.",
          },
        ],
      },
    });
    seedLiveObjection();

    await publishVerification(params);

    const bodies = controls.replies.map((reply) => reply.body);
    expect(bodies.some((body) => body.includes("Dismissed"))).toBe(false);
    expect(bodies.some((body) => body.includes("A maintainer can dismiss this finding."))).toBe(
      true,
    );
  });

  it("skips the answer when a person already resolved the thread", async () => {
    const params = baseParams({
      inventory: [{ ...thread, objections: [findingObjection()] }],
      resolutionByRootCommentId: resolutionMap([[1, { threadNodeId: "PRRT_1", isResolved: true }]]),
      threads: new Map([[1, { threadNodeId: "PRRT_1", isResolved: true }]]),
      payload: {
        verdicts: [
          {
            verdict: "fixed",
            threadRootCommentId: 1,
            commitSha: "abcdef1",
            evidence: "guarded",
          },
        ],
        objectionDecisions: [
          {
            decision: "concede",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "The race is gone.",
          },
        ],
      },
    });
    seedLiveObjection();

    await publishVerification(params);

    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toEqual([]);
    expect(recordPublishStep).toHaveBeenCalled();
  });

  it("leaves the thread open when the objection was edited before the reply", async () => {
    const params = baseParams({
      inventory: [{ ...thread, objections: [findingObjection()] }],
      payload: {
        verdicts: [{ verdict: "dismissed", threadRootCommentId: 1, evidence: "intentional" }],
        objectionDecisions: [
          {
            decision: "concede",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "A maintainer already accepted this.",
          },
        ],
      },
    });
    seedLiveObjection("2026-01-01T18:00:00Z");

    await publishVerification(params);

    expect(controls.replies).toHaveLength(0);
    expect(editReviewCommentEvents(controls)).toEqual([]);
    expect(resolveThreadIds(controls)).toEqual([]);
    const threads = await params.prSurface.listInlineReviewThreads();
    expect(threads.byRootCommentId.get(1)?.isResolved).toBe(false);
  });

  it("finds a posted marker after the journal is gone and does not reply again", async () => {
    const params = baseParams({
      inventory: [{ ...thread, path: "src/quiet.ts", objections: [findingObjection()] }],
      changedFilePaths: ["src/app.ts"],
      payload: {
        verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "file did not change" }],
        objectionDecisions: [
          {
            decision: "hold",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "The write still races.",
          },
        ],
      },
    });
    seedLiveObjection();
    await publishVerification(params);
    publishStoreState.store = createFakePublishStore();

    await publishVerification(params);

    expect(controls.replies).toHaveLength(1);
  });

  it("does not treat a human copy of the answer marker as the bot reply", async () => {
    const marker = renderObjectionAnswerMarker(50, OBJECTION_UPDATED_AT);
    const params = baseParams({
      inventory: [
        { ...thread, path: "src/quiet.ts", objections: [findingObjection({ body: marker })] },
      ],
      changedFilePaths: ["src/app.ts"],
      payload: {
        verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "file did not change" }],
        objectionDecisions: [
          {
            decision: "hold",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "The write still races.",
          },
        ],
      },
    });
    seedLiveObjection(OBJECTION_UPDATED_AT, marker);

    await publishVerification(params);

    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.body.startsWith("**Verification reply**:")).toBe(true);
  });

  it("does not post a second answer after an outcome-unknown reply was deleted", async () => {
    const params = baseParams({
      inventory: [{ ...thread, path: "src/quiet.ts", objections: [findingObjection()] }],
      changedFilePaths: ["src/app.ts"],
      payload: {
        verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "file did not change" }],
        objectionDecisions: [
          {
            decision: "hold",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "The write still races.",
          },
        ],
      },
    });
    seedLiveObjection();
    controls.acceptThenRejectNextInlineReviewReply(new Error("lost after accept"));
    controls.setReviewCommentsTruncated(true);

    await expect(publishVerification(params)).rejects.toBeDefined();
    expect(controls.replies).toHaveLength(1);
    const listed = await params.prSurface.listReviewComments();
    controls.setReviewComments(
      listed.comments.filter((comment) => !comment.body.includes("pr-agent:objection-answer")),
    );
    controls.setReviewCommentsTruncated(false);

    await expect(publishVerification(params)).rejects.toMatchObject({
      code: "operation_intent.mutation_outcome_unknown",
    });
    expect(controls.replies).toHaveLength(1);
  });

  it("does not rewrite an objection answer when a later skip updates the stub", async () => {
    const params = baseParams({
      inventory: [{ ...thread, path: "src/quiet.ts", objections: [findingObjection()] }],
      changedFilePaths: ["src/app.ts"],
      payload: {
        verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "file did not change" }],
        objectionDecisions: [
          {
            decision: "hold",
            commentId: 50,
            updatedAt: OBJECTION_UPDATED_AT,
            body: "The write still races.",
          },
        ],
      },
    });
    seedLiveObjection();
    await publishVerification(params);
    const answerBody = controls.replies[0]?.body ?? "";

    await publishVerification({ ...params, changedFilePaths: ["src/quiet.ts"] });

    expect(controls.replies[0]?.body).toBe(answerBody);
    expect(answerBody.startsWith("**Verification reply**:")).toBe(true);
    expect(answerBody).not.toContain(VERIFICATION_STUB_MARKER);
    expect(controls.replies[1]?.body).toContain(VERIFICATION_STUB_MARKER);
    expect(editReviewCommentEvents(controls)).toEqual([]);
  });
});

const HEAD_SHA = "a".repeat(40);

function reviewSummaryBody(params: {
  readonly withCiCell: boolean;
  readonly headSha?: string;
}): string {
  const ci = params.withCiCell
    ? `<tr><td><strong>CI</strong></td><td>${renderCiSummaryCell({
        status: "passing",
        headline: "All CI is passing",
        failures: [],
      })}</td></tr>`
    : "";
  return [
    REVIEW_SUMMARY_SENTINEL,
    "",
    `<table>${ci}</table>`,
    "",
    `<!-- pr-agent:review-meta headSha=${params.headSha ?? HEAD_SHA} lens=review stale=false -->`,
  ].join("\n");
}

type ConversationEdit = {
  readonly kind: string;
  readonly commentId?: number;
  readonly body?: string;
};

function conversationEdits(): ConversationEdit[] {
  const edits: ConversationEdit[] = [];
  for (const event of controls.events) {
    if (event.kind === "editComment") {
      edits.push({ kind: event.kind, commentId: event.commentId, body: event.body });
    } else if (event.kind === "upsertProgressComment") {
      edits.push({ kind: event.kind, body: event.body });
    }
  }
  return edits;
}

describe("publishVerificationFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records verification_failure and does not edit comments", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: { verdicts: [] },
    });
    controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewSummaryBody({ withCiCell: true }),
      88,
    );

    const signal = await publishVerificationFailure({
      pool: params.pool,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      prSurface: params.prSurface,
      headSha: HEAD_SHA,
      leaseEpoch: 1,
      boss: {} as import("pg-boss").PgBoss,
      installationId: 1,
    });

    expect(signal).toEqual({ headSha: HEAD_SHA, commentId: 88, surface: "ci_cell" });
    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        step: "verification_failure",
        detail: { headSha: HEAD_SHA, active: true },
      }),
    );
    expect(conversationEdits()).toHaveLength(0);
    expect(controls.replies).toHaveLength(0);
  });

  it("keeps surface ci_cell when the head review has no CI cell", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: { verdicts: [] },
    });
    controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewSummaryBody({ withCiCell: false }),
      77,
    );

    const signal = await publishVerificationFailure({
      pool: params.pool,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      prSurface: params.prSurface,
      headSha: HEAD_SHA,
      leaseEpoch: 1,
      boss: {} as import("pg-boss").PgBoss,
      installationId: 1,
    });

    expect(signal).toEqual({ headSha: HEAD_SHA, commentId: 77, surface: "ci_cell" });
    expect(conversationEdits()).toHaveLength(0);
  });

  it("uses comment id 0 when no head review comment exists", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: { verdicts: [] },
    });

    const signal = await publishVerificationFailure({
      pool: params.pool,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      prSurface: params.prSurface,
      headSha: HEAD_SHA,
      leaseEpoch: 1,
      boss: {} as import("pg-boss").PgBoss,
      installationId: 1,
    });

    expect(signal).toEqual({ headSha: HEAD_SHA, commentId: 0, surface: "ci_cell" });
    expect(conversationEdits()).toHaveLength(0);
    expect(controls.replies).toHaveLength(0);
  });

  it("clears the record without editing comments", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: { verdicts: [] },
    });
    controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewSummaryBody({ withCiCell: true }),
      88,
    );

    await clearVerificationFailureSignal({
      pool: params.pool,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      prSurface: params.prSurface,
      headSha: HEAD_SHA,
      leaseEpoch: 1,
      boss: {} as import("pg-boss").PgBoss,
      installationId: 1,
    });

    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_failure",
        detail: { headSha: HEAD_SHA, active: false },
      }),
    );
    expect(conversationEdits()).toHaveLength(0);
  });

  it("records again on a second failure and still does not edit", async () => {
    const params = baseParams({
      inventory: [thread],
      payload: { verdicts: [] },
    });
    controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      reviewSummaryBody({ withCiCell: true }),
      88,
    );

    await publishVerificationFailure({
      pool: params.pool,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      prSurface: params.prSurface,
      headSha: HEAD_SHA,
      leaseEpoch: 1,
      boss: {} as import("pg-boss").PgBoss,
      installationId: 1,
    });
    await publishVerificationFailure({
      pool: params.pool,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      prSurface: params.prSurface,
      headSha: HEAD_SHA,
      leaseEpoch: 1,
      boss: {} as import("pg-boss").PgBoss,
      installationId: 1,
    });

    const failureWrites = vi
      .mocked(recordPublishStep)
      .mock.calls.filter(
        (call) => (call[1] as { step?: string } | undefined)?.step === "verification_failure",
      );
    expect(failureWrites).toHaveLength(2);
    expect(conversationEdits()).toHaveLength(0);
  });
});
