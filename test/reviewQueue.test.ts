import { describe, expect, it } from "vitest";
import { configureReviewQueue, runQueuedReview } from "../src/agent/reviewQueue.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("review queue", () => {
  it("limits concurrency", async () => {
    configureReviewQueue(1);

    const events: string[] = [];

    const a = runQueuedReview("a", async () => {
      events.push("a:start");
      await sleep(20);
      events.push("a:end");
      return "a";
    });

    const b = runQueuedReview("b", async () => {
      events.push("b:start");
      await sleep(1);
      events.push("b:end");
      return "b";
    });

    const out = await Promise.all([a, b]);
    expect(out).toEqual(["a", "b"]);

    expect(events.indexOf("b:start")).toBeGreaterThan(events.indexOf("a:end"));
  });

  it("under burst: never exceeds concurrency, completes all, preserves FIFO", async () => {
    const concurrency = 2;
    configureReviewQueue(concurrency);

    let inFlight = 0;
    let peakInFlight = 0;
    const startOrder: string[] = [];
    const endOrder: string[] = [];

    const labels = ["t1", "t2", "t3", "t4", "t5"];
    const tasks = labels.map((label, i) =>
      runQueuedReview(label, async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        startOrder.push(label);
        // Vary durations so FIFO doesn't trivially fall out of equal sleeps.
        await sleep(5 + (i % 3) * 4);
        endOrder.push(label);
        inFlight -= 1;
        return label;
      }),
    );

    const results = await Promise.all(tasks);

    expect(results).toEqual(labels);
    expect(peakInFlight).toBeLessThanOrEqual(concurrency);
    // First N starts must be the first N labels (queue is FIFO at acquire-time).
    expect(startOrder.slice(0, concurrency)).toEqual(labels.slice(0, concurrency));
    expect(new Set(endOrder)).toEqual(new Set(labels));
  });
});
