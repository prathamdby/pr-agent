import { describe, expect, it } from "vitest";
import {
  descriptionSingletonKey,
  prResourceKey,
  reviewSingletonKey,
} from "../src/agentWork/types.js";

describe("agent work keys", () => {
  it("builds stable per-PR resource and per-lens singleton keys", () => {
    const resourceKey = prResourceKey("owner", "repo", 42);

    expect(resourceKey).toBe("owner/repo#42");
    expect(reviewSingletonKey(resourceKey, "review")).toBe("owner/repo#42:review");
    expect(reviewSingletonKey(resourceKey, "review-security")).toBe(
      "owner/repo#42:review-security",
    );
    expect(reviewSingletonKey(resourceKey, "review-quality")).toBe("owner/repo#42:review-quality");
    expect(reviewSingletonKey(resourceKey, "review-tests")).toBe("owner/repo#42:review-tests");
    expect(descriptionSingletonKey(resourceKey)).toBe("owner/repo#42:description");
    expect(String(123)).toBe("123");
  });
});
