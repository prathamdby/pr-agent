import { describe, expect, it } from "vitest";
import {
  githubPullRequestFileDiffAnchor,
  githubPullRequestFileDiffUrl,
} from "../src/github/prFileUrls.js";

describe("prFileUrls", () => {
  // Anchor matches live github.com/weppos/whois/pull/90/files HTML (verified 2026-05).
  it("uses full sha256 of the repo path for PR file diff anchors", () => {
    expect(githubPullRequestFileDiffAnchor("lib/whois/errors.rb")).toBe(
      "diff-447a111a507d8046f1ee64817cd197e9c68424b597d85d83afbbc9364f4fe41d",
    );
  });

  it("builds pull request files tab URLs", () => {
    expect(
      githubPullRequestFileDiffUrl(
        { owner: "weppos", repo: "whois", prNumber: 90 },
        "lib/whois/errors.rb",
      ),
    ).toBe(
      "https://github.com/weppos/whois/pull/90/files#diff-447a111a507d8046f1ee64817cd197e9c68424b597d85d83afbbc9364f4fe41d",
    );
  });
});
