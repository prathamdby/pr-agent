import { describe, expect, it } from "vitest";
import { isAuthorizedMaintainerDecision } from "../src/review/maintainerAuthorization.js";

const allowedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

describe("isAuthorizedMaintainerDecision", () => {
  it.each([
    ["repository owner", 10, "OWNER", true],
    ["repository member", 11, "MEMBER", true],
    ["collaborator", 12, "COLLABORATOR", true],
    ["pull request author", 13, "CONTRIBUTOR", false],
    ["ordinary commenter", 14, "NONE", false],
    ["bot", 99, "OWNER", false],
    ["missing user", null, "OWNER", false],
    ["missing association", 15, null, false],
  ])("fails closed for %s", (_label, userId, authorAssociation, expected) => {
    expect(
      isAuthorizedMaintainerDecision({
        userId,
        botUserId: 99,
        authorAssociation,
        allowedAssociations,
      }),
    ).toBe(expected);
  });

  it("does not treat wildcard configuration as a maintainer decision", () => {
    expect(
      isAuthorizedMaintainerDecision({
        userId: 10,
        botUserId: 99,
        authorAssociation: "NONE",
        allowedAssociations: new Set(["*"]),
      }),
    ).toBe(false);
  });
});
