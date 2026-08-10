import { describe, expect, it } from "vitest";
import {
  buildSubmitVerificationTool,
  createSubmitVerificationState,
} from "../src/agent/verification/submitVerificationTool.js";
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
  const submitState = createSubmitVerificationState();
  const tool = buildSubmitVerificationTool({
    owner: "o",
    repo: "r",
    prNumber: 1,
    inventory: [inventoryThread()],
    pushedShas: [],
    submitState,
  });
  return { ...tool, submitState };
}

const skippedVerdict = { verdict: "skipped", threadRootCommentId: 1, reason: "later" };

describe("submitVerification tool", () => {
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
      code: "verification.validation_failed",
    });
    expect(submitState.lastValidationError).toContain("verdicts");
  });
});
