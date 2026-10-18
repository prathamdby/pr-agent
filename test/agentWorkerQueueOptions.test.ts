import { describe, expect, it } from "vitest";
import { retentionQueueWorkOptions } from "../src/agentWork/worker.ts";
import { RETENTION_QUEUE_POLLING_INTERVAL_SECONDS } from "../src/settings/index.ts";

describe("retentionQueueWorkOptions", () => {
  it("polls the once-daily retention queue on the slow interval", () => {
    expect(retentionQueueWorkOptions()).toMatchObject({
      localConcurrency: 1,
      pollingIntervalSeconds: RETENTION_QUEUE_POLLING_INTERVAL_SECONDS,
    });
  });
});
