import { describe, expect, it } from "vitest";
import { shouldSampleShadow } from "../src/review/evaluation/reviewShadow.js";

describe("reviewShadow", () => {
  describe("shouldSampleShadow", () => {
    it("never samples when rate is 0", () => {
      expect(shouldSampleShadow({ sampleRate: 0, workItemId: "abc123", headSha: "sha" })).toBe(
        false,
      );
    });

    it("always samples when rate is 1", () => {
      expect(shouldSampleShadow({ sampleRate: 1, workItemId: "abc123", headSha: "sha" })).toBe(
        true,
      );
    });

    it("is deterministic for the same work item identity", () => {
      const r1 = shouldSampleShadow({ sampleRate: 0.5, workItemId: "item001", headSha: "sha" });
      const r2 = shouldSampleShadow({ sampleRate: 0.5, workItemId: "item001", headSha: "sha" });
      expect(r1).toBe(r2);
    });

    it("samples different work items differently", () => {
      const results = new Set<boolean>();
      for (let i = 0; i < 100; i++) {
        results.add(
          shouldSampleShadow({
            sampleRate: 0.5,
            workItemId: `item-${i}-abcdef12`,
            headSha: "sha",
          }),
        );
      }
      expect(results.size).toBeGreaterThan(1);
    });
  });
});
