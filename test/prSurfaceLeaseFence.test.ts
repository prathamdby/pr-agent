import { describe, expect, it } from "vitest";
import { DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE } from "../src/agent/description/descriptionSchema.js";
import { createFakePrSurface, withPrSurfaceMutationBoundary } from "../src/github/prSurface.js";
import type { PrSurfaceMutation, PrSurfaceMutationBoundary } from "../src/github/prSurface.js";
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
      ["gitCredentialToken", () => surface.gitCredentialToken()],
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
});
