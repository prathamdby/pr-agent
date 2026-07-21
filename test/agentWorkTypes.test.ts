import { describe, expect, it } from "vitest";
import {
  descriptionSingletonKey,
  installationGroupId,
  prResourceKey,
  reviewSingletonKey,
  triageSingletonKey,
  verificationSingletonKey,
} from "../src/agentWork/types.js";

describe("agent work keys", () => {
  it("builds stable per-PR resource and singleton keys", () => {
    const resourceKey = prResourceKey("owner", "repo", 42);

    expect(resourceKey).toBe("owner/repo#42");
    expect(reviewSingletonKey(resourceKey)).toBe("owner/repo#42:review");
    expect(descriptionSingletonKey(resourceKey)).toBe("owner/repo#42:description");
    expect(triageSingletonKey(resourceKey)).toBe("owner/repo#42:triage");
    expect(verificationSingletonKey(resourceKey)).toBe("owner/repo#42:verification");
    expect(installationGroupId(123)).toBe("123");
  });
});
