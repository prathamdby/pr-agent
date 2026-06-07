import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { groupAutoFixTargets } from "../src/autoFix/groupTargets.js";
import type { AutoFixTarget } from "../src/autoFix/types.js";

function target(overrides: Partial<AutoFixTarget>): AutoFixTarget {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    bundleId: "bundle",
    workItemId: "work",
    resourceKey: "o/r#1",
    reviewLens: "review",
    headSha: "a".repeat(40),
    fingerprint: overrides.fingerprint ?? crypto.randomUUID(),
    severity: "P1",
    filePath: "src/a.ts",
    startLine: 10,
    endLine: 12,
    title: "Bug",
    detail: "detail",
    fixPrompt: "fix",
    placementKind: "inline",
    inlineReviewCommentId: 123,
    ...overrides,
  };
}

describe("groupAutoFixTargets", () => {
  it("groups same-file overlapping ranges and keeps unrelated targets separate", () => {
    const groups = groupAutoFixTargets([
      target({ id: "b", startLine: 11, endLine: 15 }),
      target({ id: "c", startLine: 30, endLine: 30 }),
      target({ id: "d", filePath: "src/b.ts", startLine: 11, endLine: 12 }),
      target({ id: "a", startLine: 8, endLine: 11 }),
    ]);

    expect(groups.map((group) => group.targets.map((entry) => entry.id))).toEqual([
      ["a", "b"],
      ["c"],
      ["d"],
    ]);
  });
});
