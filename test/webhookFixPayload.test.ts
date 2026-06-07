import { describe, expect, it } from "vitest";
import { parseGithubPayload } from "../src/webhook/parseGithubPayload.js";

describe("pull_request_review_comment parsing", () => {
  it("keeps in_reply_to_id for /fix target resolution", () => {
    const parsed = parseGithubPayload("pull_request_review_comment", {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "acme" }, name: "app", size: 12 },
      pull_request: { number: 7 },
      comment: {
        id: 101,
        in_reply_to_id: 55,
        user: { id: 9, login: "dev" },
        body: "/fix",
        path: "src/app.ts",
        line: 12,
        side: "RIGHT",
      },
    });

    expect(parsed.name).toBe("pull_request_review_comment");
    if (parsed.name !== "pull_request_review_comment") return;
    expect(parsed.data.comment.in_reply_to_id).toBe(55);
    expect(parsed.data.comment.user.login).toBe("dev");
  });
});
