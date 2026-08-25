import { describe, expect, it } from "vitest";
import { findExistingAskReplyComment } from "../src/agent/ask/recoverAskReply.js";
import {
  askReplyOperationKey,
  operationIntentMarker,
} from "../src/agentWork/withOperationIntent.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

describe("findExistingAskReplyComment", () => {
  it("recovers a reply posted under the unscoped ask operation key", async () => {
    const resourceKey = "1:o/r#9";
    const instance = "work-1";
    const legacyKey = askReplyOperationKey(resourceKey);
    const marker = operationIntentMarker(legacyKey, instance);
    const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 9 });
    await surface.replyAt(
      { kind: "prConversation", prNumber: 9 },
      `${marker}\n**Question:** why?\n**Answer:** because`,
    );

    const found = await findExistingAskReplyComment({
      prSurface: surface,
      replyTarget: { kind: "prConversation", prNumber: 9 },
      question: "why?",
      botLogin: "pr-agent[bot]",
      operationKey: legacyKey,
      operationInstance: instance,
    });

    expect(found?.commentId).toEqual(expect.any(Number));
  });
});
