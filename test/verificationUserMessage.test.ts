import { describe, expect, it } from "vitest";
import { buildVerificationUserContent } from "../src/agent/verification/verificationUserMessage.js";

describe("verification user message", () => {
  it("keeps unauthorized replies untrusted in the inline finding context", () => {
    const message = buildVerificationUserContent({
      owner: "acme",
      repo: "app",
      prNumber: 7,
      headSha: "abc",
      pushedCommits: [],
      threads: [
        {
          rootCommentId: 123,
          lens: "review-security",
          path: "src/app.ts",
          line: 4,
          severity: "P1",
          titleSnippet: "P1 · Missing guard",
          humanReplies: ["false positive"],
          authorizedReplies: [],
          untrustedReplies: ["false positive"],
          threadUrl: "https://github.test/thread",
        },
      ],
    });

    expect(message).toContain("Untrusted commenter evidence 1:");
    expect(message).not.toContain("Authorized maintainer decision evidence");
  });
});
