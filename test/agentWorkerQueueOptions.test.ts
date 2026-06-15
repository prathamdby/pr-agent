import { describe, expect, it } from "vitest";
import { retentionQueueWorkOptions } from "../src/agentWork/worker.js";
import { RETENTION_QUEUE_POLLING_INTERVAL_SECONDS } from "../src/settings.js";

describe("retentionQueueWorkOptions", () => {
  it("polls the once-daily retention queue on the slow interval", () => {
    expect(retentionQueueWorkOptions()).toMatchObject({
      localConcurrency: 1,
      pollingIntervalSeconds: RETENTION_QUEUE_POLLING_INTERVAL_SECONDS,
    });
  });
});
