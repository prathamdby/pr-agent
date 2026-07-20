import { describe, expect, it } from "vitest";
import { parseReviewMetaFromCommentBody } from "../src/review/ci/reviewMetaParse.js";

describe("parseReviewMetaFromCommentBody", () => {
  it("parses headSha, lens, and stale from the review-meta marker", () => {
    const body = [
      "## PR Agent Review",
      "<!-- pr-agent:review-meta headSha=deadbeef lens=security stale=true -->",
    ].join("\n");
    expect(parseReviewMetaFromCommentBody(body)).toEqual({
      headSha: "deadbeef",
      lens: "security",
      stale: true,
    });
  });

  it("returns null when the marker is missing", () => {
    expect(parseReviewMetaFromCommentBody("no meta here")).toBeNull();
  });
});
