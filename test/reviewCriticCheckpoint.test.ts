import { describe, expect, it } from "vitest";
import {
  createInMemoryReviewCheckpointStores,
  payloadCheckpointMatches,
  type ReviewCriticCheckpointKey,
} from "../src/review/run/reviewCriticCheckpoint.js";

const SCOPE = {
  workItemId: "work-1",
  headSha: "a".repeat(40),
  evidenceHash: "e".repeat(64),
  promptContractVersion: 1,
};

function key(criticId: string): ReviewCriticCheckpointKey {
  return { ...SCOPE, criticId };
}

describe("in-memory review critic checkpoint store", () => {
  it("reuses a completed report after a simulated durable retry", async () => {
    const { criticStore } = createInMemoryReviewCheckpointStores();
    await criticStore.claimAttempt(key("correctness"));
    await criticStore.saveCompletedReport(key("correctness"), { coverage: "done" });

    const loaded = await criticStore.loadCheckpoints(SCOPE);
    expect(loaded.get("correctness")?.status).toBe("completed");
    expect(loaded.get("correctness")?.report).toEqual({ coverage: "done" });

    const retryClaim = await criticStore.claimAttempt(key("correctness"));
    expect(retryClaim.claimed).toBe(false);
    expect(retryClaim.attemptCount).toBe(1);
  });

  it("ignores checkpoints whose identity fields differ", async () => {
    const { criticStore } = createInMemoryReviewCheckpointStores();
    await criticStore.claimAttempt(key("security"));
    await criticStore.saveCompletedReport(key("security"), { coverage: "done" });

    for (const scope of [
      { ...SCOPE, headSha: "b".repeat(40) },
      { ...SCOPE, evidenceHash: "f".repeat(64) },
      { ...SCOPE, promptContractVersion: 2 },
      { ...SCOPE, workItemId: "work-2" },
    ]) {
      expect((await criticStore.loadCheckpoints(scope)).size).toBe(0);
    }
  });

  it("persists attempt counts so a critic never exceeds two total attempts", async () => {
    const { criticStore } = createInMemoryReviewCheckpointStores();
    const first = await criticStore.claimAttempt(key("reliability"));
    expect(first).toEqual({ attemptCount: 1, claimed: true });
    const second = await criticStore.claimAttempt(key("reliability"));
    expect(second).toEqual({ attemptCount: 2, claimed: true });
    await criticStore.markExhausted(key("reliability"));

    const loaded = await criticStore.loadCheckpoints(SCOPE);
    expect(loaded.get("reliability")).toMatchObject({ status: "exhausted", attemptCount: 2 });
  });

  it("never replaces a completed report with a failed state", async () => {
    const { criticStore } = createInMemoryReviewCheckpointStores();
    await criticStore.claimAttempt(key("change-safety"));
    await criticStore.saveCompletedReport(key("change-safety"), { coverage: "first" });
    await criticStore.markExhausted(key("change-safety"));
    await criticStore.saveCompletedReport(key("change-safety"), { coverage: "second" });

    const loaded = await criticStore.loadCheckpoints(SCOPE);
    expect(loaded.get("change-safety")).toMatchObject({
      status: "completed",
      report: { coverage: "first" },
    });
  });
});

describe("in-memory review payload checkpoint store", () => {
  it("stores the validated payload once and returns the original on rewrite", async () => {
    const { payloadStore } = createInMemoryReviewCheckpointStores();
    const checkpoint = { ...SCOPE, payload: { prCharacter: "first" } };
    const stored = await payloadStore.saveOnce(checkpoint);
    expect(stored.payload).toEqual({ prCharacter: "first" });

    const replay = await payloadStore.saveOnce({ ...SCOPE, payload: { prCharacter: "second" } });
    expect(replay.payload).toEqual({ prCharacter: "first" });
    expect((await payloadStore.load(SCOPE.workItemId))?.payload).toEqual({ prCharacter: "first" });
  });
});

describe("payloadCheckpointMatches", () => {
  it("rejects checkpoints from a different head, evidence, or prompt version", () => {
    const checkpoint = { ...SCOPE, payload: {} };
    expect(payloadCheckpointMatches(checkpoint, SCOPE)).toBe(true);
    expect(payloadCheckpointMatches(checkpoint, { ...SCOPE, headSha: "b".repeat(40) })).toBe(false);
    expect(payloadCheckpointMatches(checkpoint, { ...SCOPE, evidenceHash: "f".repeat(64) })).toBe(
      false,
    );
    expect(payloadCheckpointMatches(checkpoint, { ...SCOPE, promptContractVersion: 9 })).toBe(
      false,
    );
  });
});
