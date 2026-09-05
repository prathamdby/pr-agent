import { describe, expect, it } from "vitest";
import { DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE } from "../src/agent/description/descriptionSchema.js";
import {
  operationIntentMarker,
  runInOperationIntentFrame,
} from "../src/agentWork/withOperationIntent.js";
import type { OperationIntentRow } from "../src/agentWork/operationIntentRepository.js";
import { createFakePrSurface, withPrSurfaceMutationBoundary } from "../src/github/prSurface.js";
import type { PrSurfaceMutation, PrSurfaceMutationBoundary } from "../src/github/prSurface.js";
import { recoverPrSurfaceMutation } from "../src/github/recoverPrSurfaceMutation.js";
import { makeTestConfig } from "./helpers/config.js";

const surfaceParams = { owner: "o", repo: "r", prNumber: 1 };

describe("PrSurface lease mutation boundary", () => {
  it("blocks every mutating method before the fake external call when ownership is lost", async () => {
    let owned = false;
    const runCalls: PrSurfaceMutation[] = [];
    const run: PrSurfaceMutationBoundary["run"] = async <T>(
      mutation: PrSurfaceMutation,
      mutate: () => Promise<T>,
    ): Promise<T> => {
      runCalls.push(mutation);
      if (!owned) throw new Error("lease lost");
      return mutate();
    };
    const { surface, controls } = createFakePrSurface(surfaceParams, {
      mutationBoundary: { signal: new AbortController().signal, run },
    });

    const attempts: Array<readonly [string, () => Promise<unknown>]> = [
      [
        "setAcknowledgementReaction",
        () => surface.setAcknowledgementReaction([{ kind: "pr", prNumber: 1 }], "eyes"),
      ],
      ["replyAt", () => surface.replyAt({ kind: "prConversation", prNumber: 1 }, "reply")],
      ["upsertProgressComment", () => surface.upsertProgressComment("body", "sentinel")],
      ["editComment", () => surface.editComment(10, "body")],
      [
        "setReviewCommitStatus",
        () => surface.setReviewCommitStatus("head", { state: "success", description: "done" }),
      ],
      [
        "publishThreadBatch",
        () => surface.publishThreadBatch({ body: "review", event: "COMMENT" }),
      ],
      ["resolveInlineReviewThread", () => surface.resolveInlineReviewThread("thread")],
      ["setLabels", () => surface.setLabels(["pr-agent-size-small"])],
      ["startReviewCheck", () => surface.startReviewCheck("head", "work-item")],
      [
        "finishReviewCheck",
        () =>
          surface.finishReviewCheck({
            checkRunId: 1,
            conclusion: "cancelled",
            summary: "cancelled",
          }),
      ],
      ["editReviewComment", () => surface.editReviewComment(10, "body")],
      [
        "publishDescription",
        () =>
          surface.publishDescription(
            { features: makeTestConfig().features },
            DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE,
          ),
      ],
    ];

    for (const [, attempt] of attempts) {
      await expect(attempt()).rejects.toThrow("lease lost");
    }

    expect(runCalls).toHaveLength(attempts.length);
    expect(
      controls.events.filter((event) =>
        [
          "setAcknowledgementReaction",
          "replyAt",
          "upsertProgressComment",
          "editComment",
          "setReviewCommitStatus",
          "publishThreadBatch",
          "resolveInlineReviewThread",
          "setLabels",
          "startReviewCheck",
          "finishReviewCheck",
          "editReviewComment",
          "publishDescription",
        ].includes(event.kind),
      ),
    ).toHaveLength(0);

    owned = true;
    await surface.setLabels(["pr-agent-size-small"]);
    expect(controls.events).toContainEqual({ kind: "setLabels", labels: ["pr-agent-size-small"] });
  });

  it("does not invoke the boundary after cancellation and leaves every read available", async () => {
    const controller = new AbortController();
    let runCalled = false;
    const run: PrSurfaceMutationBoundary["run"] = async <T>(
      _mutation: PrSurfaceMutation,
      _mutate: () => Promise<T>,
    ): Promise<T> => {
      runCalled = true;
      return undefined as T;
    };
    const { surface, controls } = createFakePrSurface(surfaceParams, {
      mutationBoundary: { signal: controller.signal, run },
    });

    controller.abort(new Error("renewal lost"));
    await expect(surface.replyAt({ kind: "prConversation", prNumber: 1 }, "reply")).rejects.toThrow(
      "renewal lost",
    );
    expect(runCalled).toBe(false);

    const reads: Array<readonly [string, () => Promise<unknown>]> = [
      ["getHead", () => surface.getHead()],
      ["getHeadSha", () => surface.getHeadSha()],
      ["findProgressComment", () => surface.findProgressComment("sentinel")],
      ["resolveProgressComment", () => surface.resolveProgressComment("sentinel")],
      ["listPullRequestReviewComments", () => surface.listPullRequestReviewComments()],
      ["fetchPriorInlineFeedback", () => surface.fetchPriorInlineFeedback(1, "review")],
      ["fetchBotFindingThreads", () => surface.fetchBotFindingThreads(1)],
      ["fetchReviewCommentParentGraph", () => surface.fetchReviewCommentParentGraph()],
      ["listInlineReviewThreads", () => surface.listInlineReviewThreads()],
      [
        "listChangedFiles",
        () =>
          surface.listChangedFiles({
            maxPrFilesListed: 10,
            maxPrFilesPatchBytes: 100,
          }),
      ],
      ["listCommitCompareFiles", () => surface.listCommitCompareFiles("base", "head")],
      ["getLabels", () => surface.getLabels()],
      ["getCiStatus", () => surface.getCiStatus("head")],
      ["listFailingActionsJobs", () => surface.listFailingActionsJobs("head")],
      ["downloadActionsJobLogs", () => surface.downloadActionsJobLogs(1)],
      ["listCheckRunAnnotations", () => surface.listCheckRunAnnotations(1)],
      ["gitCredentialAuth", () => surface.gitCredentialAuth()],
      ["listConversationComments", () => surface.listConversationComments()],
      ["listInlineReviewComments", () => surface.listInlineReviewComments()],
      ["getPullRequestBody", () => surface.getPullRequestBody()],
      ["getPullRequestBranchInfo", () => surface.getPullRequestBranchInfo()],
      ["listPushedCommits", () => surface.listPushedCommits()],
      ["lookupGitHubUser", () => surface.lookupGitHubUser(1)],
    ];

    for (const [, read] of reads) await expect(read()).resolves.not.toBeUndefined();
    expect(surface.isRateLimitCircuitOpen()).toBe(false);
    expect(runCalled).toBe(false);
    expect(controls.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(reads.map(([kind]) => kind)),
    );
  });

  it("records stable mutation metadata and preserves unleased ask semantics", async () => {
    const mutations: PrSurfaceMutation[] = [];
    const { surface } = createFakePrSurface(surfaceParams, {
      mutationBoundary: {
        signal: new AbortController().signal,
        run: async (mutation, mutate) => {
          mutations.push(mutation);
          return mutate();
        },
      },
    });

    await surface.setLabels(["pr-agent-size-small"]);
    expect(mutations[0]).toMatchObject({
      operationKey: expect.stringMatching(/^pr-surface:setLabels:/),
      mutationKind: "github.pr_surface.setLabels",
      detail: { surfaceMethod: "setLabels" },
    });
    await surface.publishThreadBatch({ body: "review", event: "COMMENT", commitId: "head" });
    await surface.publishThreadBatch({ commitId: "head", event: "COMMENT", body: "review" });
    expect(mutations[1]?.operationKey).toBe(mutations[2]?.operationKey);
    expect(mutations[1]?.detail?.inputHash).toHaveLength(64);

    const unleased = createFakePrSurface(surfaceParams);
    await unleased.surface.replyAt({ kind: "prConversation", prNumber: 1 }, "ask reply");
    expect(unleased.controls.replies).toEqual([
      { target: { kind: "prConversation", prNumber: 1 }, body: "ask reply" },
    ]);
  });

  it("nests surface mutation keys under a stable parent operation key", async () => {
    const mutations: PrSurfaceMutation[] = [];
    const { surface } = createFakePrSurface(surfaceParams, {
      mutationBoundary: {
        signal: new AbortController().signal,
        run: async (mutation, mutate) => {
          mutations.push(mutation);
          return mutate();
        },
      },
    });

    await runInOperationIntentFrame("ask:reply:1:o/r#1", async () => {
      await surface.replyAt({ kind: "prConversation", prNumber: 1 }, "first body");
      await surface.replyAt({ kind: "prConversation", prNumber: 1 }, "retry with a new body");
    });

    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.operationKey).toBe("ask:reply:1:o/r#1:surface:replyAt");
    expect(mutations[1]?.operationKey).toBe(mutations[0]?.operationKey);
    expect(mutations[0]?.detail).toMatchObject({
      surfaceMethod: "replyAt",
      parentOperationKey: "ask:reply:1:o/r#1",
    });
    expect(mutations[0]?.detail?.inputHash).not.toBe(mutations[1]?.detail?.inputHash);
  });

  it("returns the cached wrapped surface instead of the raw surface", async () => {
    const raw = createFakePrSurface(surfaceParams).surface;
    const boundary: PrSurfaceMutationBoundary = {
      signal: new AbortController().signal,
      run: async (_mutation, mutate) => mutate(),
    };

    const first = withPrSurfaceMutationBoundary(raw, boundary);
    expect(withPrSurfaceMutationBoundary(raw, boundary)).toBe(first);
    expect(withPrSurfaceMutationBoundary(first, boundary)).toBe(first);
  });

  it("recovers a marked replyAt without remutating and fails closed for labels", async () => {
    const mutations: PrSurfaceMutation[] = [];
    const { surface } = createFakePrSurface(surfaceParams, {
      mutationBoundary: {
        signal: new AbortController().signal,
        run: async (mutation, mutate) => {
          mutations.push(mutation);
          return mutate();
        },
      },
    });
    const marker = operationIntentMarker("verification:thread:9", "wi-1");

    const posted = await surface.replyAt(
      { kind: "prConversation", prNumber: 1 },
      `${marker}\nverification note`,
    );
    const replyMutation = mutations[0];
    expect(replyMutation?.detail).toMatchObject({
      surfaceMethod: "replyAt",
      operationMarker: marker,
      replyTargetKind: "prConversation",
    });
    expect(replyMutation?.recover).toEqual(expect.any(Function));

    const recovered = await recoverPrSurfaceMutation(surface, {
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: replyMutation?.operationKey ?? "pr-surface:replyAt",
      mutationKind: "github.pr_surface.replyAt",
      status: "pending",
      publishRecordId: null,
      detail: { ...replyMutation?.detail, __mutating: true },
    } satisfies OperationIntentRow);
    expect(recovered).toEqual({ kind: "reconciled", value: { commentId: posted.commentId } });

    await surface.setLabels(["pr-agent-size-small"]);
    const labelMutation = mutations[1];
    const labelsRecovered = await recoverPrSurfaceMutation(surface, {
      id: "intent-2",
      workItemId: "wi-1",
      operationKey: labelMutation?.operationKey ?? "pr-surface:setLabels",
      mutationKind: "github.pr_surface.setLabels",
      status: "pending",
      publishRecordId: null,
      detail: { ...labelMutation?.detail, __mutating: true },
    } satisfies OperationIntentRow);
    expect(labelsRecovered).toEqual({ kind: "absent" });
  });

  it("recovers marked review-comment edits, thread resolution, and check runs", async () => {
    const mutations: PrSurfaceMutation[] = [];
    const { surface, controls } = createFakePrSurface(surfaceParams, {
      mutationBoundary: {
        signal: new AbortController().signal,
        run: async (mutation, mutate) => {
          mutations.push(mutation);
          return mutate();
        },
      },
    });
    const marker = operationIntentMarker("verification:thread:3", "wi-1");
    controls.setReviewCommentBody(8, "prior");
    controls.setInlineReviewComments([
      {
        id: 8,
        inReplyToId: 3,
        authorLogin: "pr-agent[bot]",
        body: `${marker}\n**Verification**: Still open`,
      },
    ]);
    controls.setThreads(new Map([[3, { threadNodeId: "thread-node", isResolved: true }]]));

    await surface.editReviewComment(8, `${marker}\n**Verification**: Still open`);
    const editRecovered = await recoverPrSurfaceMutation(surface, {
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "verification:thread:3:surface:editReviewComment",
      mutationKind: "github.pr_surface.editReviewComment",
      status: "pending",
      publishRecordId: null,
      detail: { ...mutations[0]?.detail, __mutating: true },
    } satisfies OperationIntentRow);
    expect(editRecovered).toEqual({ kind: "reconciled", value: true });

    await surface.resolveInlineReviewThread("thread-node");
    const resolveRecovered = await recoverPrSurfaceMutation(surface, {
      id: "intent-2",
      workItemId: "wi-1",
      operationKey: "verification:thread:3:surface:resolveInlineReviewThread",
      mutationKind: "github.pr_surface.resolveInlineReviewThread",
      status: "pending",
      publishRecordId: null,
      detail: { ...mutations[1]?.detail, __mutating: true },
    } satisfies OperationIntentRow);
    expect(resolveRecovered).toEqual({ kind: "reconciled", value: undefined });

    const check = await surface.startReviewCheck("abc123", "wi-1");
    const checkRecovered = await recoverPrSurfaceMutation(surface, {
      id: "intent-3",
      workItemId: "wi-1",
      operationKey: "review:check_run:wi-1:surface:startReviewCheck",
      mutationKind: "github.pr_surface.startReviewCheck",
      status: "pending",
      publishRecordId: null,
      detail: { ...mutations[2]?.detail, __mutating: true },
    } satisfies OperationIntentRow);
    expect(checkRecovered).toEqual({ kind: "reconciled", value: check });
  });

  it("derives progress updated from knownExistingId and fails closed without a marker", async () => {
    const mutations: PrSurfaceMutation[] = [];
    const { surface, controls } = createFakePrSurface(surfaceParams, {
      mutationBoundary: {
        signal: new AbortController().signal,
        run: async (mutation, mutate) => {
          mutations.push(mutation);
          return mutate();
        },
      },
    });
    const marker = operationIntentMarker("review:summary:review:o/r#1", "wi-1");
    const created = await surface.upsertProgressComment(
      `${marker}\n## PR Agent Review`,
      "## PR Agent Review",
    );
    expect(created.updated).toBe(false);
    expect(mutations[0]?.detail).toMatchObject({
      surfaceMethod: "upsertProgressComment",
      operationMarker: marker,
      sentinel: "## PR Agent Review",
    });

    const createdRecovered = await recoverPrSurfaceMutation(surface, {
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: mutations[0]?.operationKey ?? "pr-surface:upsertProgressComment",
      mutationKind: "github.pr_surface.upsertProgressComment",
      status: "pending",
      publishRecordId: null,
      detail: { ...mutations[0]?.detail, __mutating: true },
    } satisfies OperationIntentRow);
    expect(createdRecovered).toEqual({
      kind: "reconciled",
      value: { id: created.id, updated: false },
    });

    const updated = await surface.upsertProgressComment(
      `${marker}\n## PR Agent Review\ndone`,
      "## PR Agent Review",
      { id: created.id, url: "https://example.test/1" },
    );
    expect(updated.updated).toBe(true);
    const updateRecovered = await recoverPrSurfaceMutation(surface, {
      id: "intent-2",
      workItemId: "wi-1",
      operationKey: mutations[1]?.operationKey ?? "pr-surface:upsertProgressComment",
      mutationKind: "github.pr_surface.upsertProgressComment",
      status: "pending",
      publishRecordId: null,
      detail: { ...mutations[1]?.detail, __mutating: true },
    } satisfies OperationIntentRow);
    expect(mutations[1]?.detail).toMatchObject({ knownExistingId: created.id });
    expect(updateRecovered).toEqual({
      kind: "reconciled",
      value: { id: created.id, updated: true },
    });

    controls.setConversationComments([
      {
        id: 99,
        inReplyToId: null,
        authorLogin: "attacker",
        body: "## PR Agent Review\nspoofed",
      },
    ]);
    const sentinelOnly = await recoverPrSurfaceMutation(surface, {
      id: "intent-3",
      workItemId: "wi-1",
      operationKey: "pr-surface:upsertProgressComment",
      mutationKind: "github.pr_surface.upsertProgressComment",
      status: "pending",
      publishRecordId: null,
      detail: { surfaceMethod: "upsertProgressComment", sentinel: "## PR Agent Review" },
    } satisfies OperationIntentRow);
    expect(sentinelOnly).toEqual({ kind: "absent" });
  });

  it("recovers a marked description body without synthesizing titleUpdated", async () => {
    const marker = operationIntentMarker("description:pr_body:o/r#1", "wi-1");
    const { surface, controls } = createFakePrSurface(surfaceParams);
    controls.setPullRequestBody(`agent block\n${marker}`);
    const recovered = await recoverPrSurfaceMutation(surface, {
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "description:pr_body:o/r#1:surface:publishDescription",
      mutationKind: "github.pr_surface.publishDescription",
      status: "pending",
      publishRecordId: null,
      detail: { surfaceMethod: "publishDescription", operationMarker: marker },
    } satisfies OperationIntentRow);
    expect(recovered).toEqual({
      kind: "reconciled",
      value: { prNumber: 1, bodyUpdated: true },
    });
  });
});
