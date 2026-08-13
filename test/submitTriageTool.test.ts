import { describe, expect, it } from "vitest";
import {
  buildSubmitTriageTool,
  createSubmitTriageState,
} from "../src/agent/triage/submitTriageTool.js";
import type { TriageWorkspaceToolState } from "../src/agent/triage/triageWorkspaceTools.js";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";

function inventoryThread(): BotFindingThread {
  return {
    rootCommentId: 1,
    lens: "review",
    path: "src/a.ts",
    line: 1,
    severity: "P1",
    titleSnippet: "Guard the missing value",
    humanReplies: [],
    threadUrl: "https://example.com/threads/1",
  };
}

function buildTool() {
  const submitState = createSubmitTriageState();
  const checkout: WritablePrCheckout = {
    dir: "/tmp/checkout",
    headRef: "main",
    baseSha: "a".repeat(40),
    commit: async () => ({ sha: "b".repeat(40), diff: "" }),
    push: async () => undefined,
    listCommittedShas: () => [],
    listCommittedDetails: () => [],
  };
  const workspaceState: TriageWorkspaceToolState = {
    commitByThreadRootCommentId: new Map(),
  };
  const tool = buildSubmitTriageTool({
    owner: "o",
    repo: "r",
    prNumber: 1,
    inventory: [inventoryThread()],
    checkout,
    workspaceState,
    submitState,
  });
  return { ...tool, submitState };
}

const skippedVerdict = { verdict: "skipped", threadRootCommentId: 1, reason: "later" };

describe("submitTriage tool", () => {
  it("accepts a valid verdict payload", async () => {
    const { executor, submitState } = buildTool();

    await expect(executor({ verdicts: [skippedVerdict] })).resolves.toEqual({ ok: true });
    expect(submitState.payload?.verdicts).toEqual([skippedVerdict]);
  });

  it("repairs a stringified verdicts array at the parse seam", async () => {
    const { executor, submitState } = buildTool();

    await expect(executor({ verdicts: JSON.stringify([skippedVerdict]) })).resolves.toEqual({
      ok: true,
    });
    expect(submitState.payload?.verdicts).toEqual([skippedVerdict]);
  });

  it("rejects unrepairable payloads with the formatted issue list", async () => {
    const { executor, submitState } = buildTool();

    await expect(executor({ verdicts: "not json" })).rejects.toMatchObject({
      code: "triage.validation_failed",
    });
    expect(submitState.lastValidationError).toContain("verdicts");
  });
});
