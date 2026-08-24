import { describe, expect, it } from "vitest";
import { DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE } from "../src/agent/description/descriptionSchema.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
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

  it("does not invoke the boundary after cancellation and leaves reads available", async () => {
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
    await expect(surface.getHeadSha()).resolves.toBe("fake-head-sha");
    expect(controls.events).toContainEqual({ kind: "getHeadSha" });
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

    const unleased = createFakePrSurface(surfaceParams);
    await unleased.surface.replyAt({ kind: "prConversation", prNumber: 1 }, "ask reply");
    expect(unleased.controls.replies).toEqual([
      { target: { kind: "prConversation", prNumber: 1 }, body: "ask reply" },
    ]);
  });
});
