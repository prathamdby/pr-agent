import { describe, expect, it } from "vitest";
import {
  conversationIdFor,
  initialReviewCheckpoint,
  reviewRunCoverage,
  withConversationId,
} from "../src/review/orchestrator/orchestratorRun.ts";
import { nextSynthesisStep } from "../src/review/orchestrator/runStep.ts";

describe("reviewRunCoverage", () => {
  it("keeps specialist failure ahead of unread files and caps stored paths", () => {
    const unread = ["src/a.ts", "src/b.ts"];
    expect(reviewRunCoverage(["tests"], unread)).toEqual({
      kind: "partial",
      failed: ["tests"],
      paths: unread,
      note: "Coverage partial: tests specialist failed. Unread changed files: src/a.ts, src/b.ts.",
    });
    expect(reviewRunCoverage(["correctness", "security", "quality", "tests"], unread)).toEqual({
      kind: "none",
      failed: ["correctness", "security", "quality", "tests"],
    });
    expect(reviewRunCoverage([], [], ["tests", "quality"])).toEqual({
      kind: "partial",
      unjudged: ["tests", "quality"],
      note: "Not judged: tests, quality.",
    });
    const many = Array.from({ length: 501 }, (_, index) => `src/f${index}.ts`);
    const capped = reviewRunCoverage([], many);
    expect(capped).toMatchObject({
      kind: "partial",
      note: "Unread changed files: src/f0.ts, src/f1.ts, src/f2.ts (+498 more).",
    });
    if (capped.kind !== "partial" || capped.paths == null) {
      throw new Error("expected unread coverage");
    }
    expect(capped.paths).toHaveLength(500);
    expect(capped.paths[0]).toBe("src/f0.ts");
    expect(capped.failed).toBeUndefined();
  });
});

describe("review attempt checkpoint", () => {
  it("records each child conversation in the checkpoint so a restart re-finds it", () => {
    const checkpoint = initialReviewCheckpoint({
      now: 1_000,
      headSha: "head",
      baseSha: null,
      budgetMs: 255_000,
      finalizationMs: 30_000,
      reconBudgetMs: 50_000,
    });
    expect(checkpoint.phase).toBe("recon");
    expect(checkpoint.timing).toEqual({
      startedAt: 1_000,
      reconAt: 51_000,
      modelStopAt: 226_000,
      returnBy: 256_000,
    });
    const withChildren = withConversationId(
      withConversationId(checkpoint, "orchestrator", "7"),
      "security",
      "9",
    );
    expect(conversationIdFor(withChildren, "orchestrator")).toBe("7");
    expect(conversationIdFor(withChildren, "security")).toBe("9");
    expect(conversationIdFor(withChildren, "tests")).toBeUndefined();
    expect(JSON.parse(JSON.stringify(withChildren))).toEqual(withChildren);
  });
});

describe("nextSynthesisStep", () => {
  const base = {
    pendingJudgment: false,
    orchestratorAvailable: true,
    summaryPublished: false,
    synthesisSent: false,
    repairsUsed: 0,
    repairLimit: 2,
    recoveriesUsed: 0,
    recoveryLimit: 2,
  };
  it("judges pending reports before synthesis and degrades without an orchestrator", () => {
    expect(nextSynthesisStep({ ...base, pendingJudgment: true })).toBe("judge");
    expect(
      nextSynthesisStep({ ...base, pendingJudgment: true, orchestratorAvailable: false }),
    ).toBe("unjudged");
  });
  it("walks synthesis, repair, and recovery before the deterministic publish", () => {
    expect(nextSynthesisStep(base)).toBe("synthesis");
    expect(nextSynthesisStep({ ...base, synthesisSent: true })).toBe("repair_summary");
    expect(nextSynthesisStep({ ...base, synthesisSent: true, repairsUsed: 2 })).toBe(
      "recover_summary",
    );
    expect(
      nextSynthesisStep({ ...base, synthesisSent: true, repairsUsed: 2, recoveriesUsed: 2 }),
    ).toBe("publish");
    expect(nextSynthesisStep({ ...base, summaryPublished: true })).toBe("publish");
  });
});
