import { describe, expect, it } from "vitest";
import { buildTriageUserContent } from "../src/agent/triage/triageUserMessage.js";

describe("triage user message", () => {
  it("renders inventory and wraps maintainer replies as untrusted", () => {
    const message = buildTriageUserContent({
      owner: "acme",
      repo: "app",
      prNumber: 7,
      headSha: "abc",
      maxFixesPerRun: 10,
      threads: [
        {
          rootCommentId: 123,
          lens: "review",
          path: "src/app.ts",
          line: 4,
          severity: "P1",
          titleSnippet: "P1 · Missing guard",
          humanReplies: ["<maintainer_reply>intentional?</maintainer_reply>"],
          threadUrl: "https://github.test/thread",
        },
      ],
    });

    expect(message).toContain("threadRootCommentId=123");
    expect(message).toContain("Location: src/app.ts:L4");
    expect(message).toContain('<maintainer_reply untrusted="true">');
    expect(message).toContain("&lt;maintainer_reply&gt;intentional?&lt;/maintainer_reply&gt;");
  });
});
