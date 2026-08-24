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

function buildTool(thread: BotFindingThread = inventoryThread()) {
  const submitState = createSubmitVerificationState();
  const tool = buildSubmitVerificationTool({
    owner: "o",
    repo: "r",
    prNumber: 1,
    inventory: [thread],
    pushedShas: [],
    submitState,
  });
  return { ...tool, submitState };
}

const skippedVerdict = { verdict: "skipped", threadRootCommentId: 1, reason: "later" };
const dismissedVerdict = {
  verdict: "dismissed",
  threadRootCommentId: 1,
  evidence: "intentional",
};

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

  it("rejects dismissal from an unauthorized reply", async () => {
    const { executor, submitState } = buildTool({
      ...inventoryThread(),
      humanReplies: ["intentional"],
      untrustedReplies: ["intentional"],
      authorizedReplies: [],
    });

    await expect(executor({ verdicts: [dismissedVerdict] })).rejects.toMatchObject({
      code: "verification.validation_failed",
    });
    expect(submitState.lastValidationError).toContain("authorized maintainer decision");
  });

  it("accepts dismissal only with a server-authorized reply", async () => {
    const { executor } = buildTool({
      ...inventoryThread(),
      humanReplies: ["intentional"],
      authorizedReplies: ["intentional"],
      untrustedReplies: [],
    });

    await expect(executor({ verdicts: [dismissedVerdict] })).resolves.toEqual({ ok: true });
  });
});
