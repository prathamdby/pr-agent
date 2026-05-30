import { describe, expect, it } from "vitest";
import {
  buildReviewPathProfile,
  formatReviewPathProfileBlock,
} from "../src/review/reviewPathProfile.js";

describe("buildReviewPathProfile", () => {
  it("detects risk categories from changed paths", () => {
    const profile = buildReviewPathProfile([
      "src/auth/login.ts",
      "migrations/002_users.sql",
      "docs/readme.md",
    ]);
    expect(profile.riskCategories).toContain("auth");
    expect(profile.riskCategories).toContain("migration");
  });
});

describe("formatReviewPathProfileBlock", () => {
  it("includes trusted context header", () => {
    const block = formatReviewPathProfileBlock(buildReviewPathProfile(["src/auth/login.ts"]));
    expect(block).toContain("Trusted context (path profile):");
    expect(block).toContain("auth");
  });
});
