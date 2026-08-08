import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { stopWorkerConsumers } from "../src/agentWork/worker.js";
import { WORKER_CONSUMER_QUEUES } from "../src/agentWork/workerHealth.js";

describe("stopWorkerConsumers", () => {
  it("calls offWork with wait:false so stopBoss can bound the drain", async () => {
    const offWork = vi.fn(async () => undefined);
    const boss = { offWork } as unknown as PgBoss;

    await stopWorkerConsumers(boss);

    expect(offWork).toHaveBeenCalledTimes(WORKER_CONSUMER_QUEUES.length);
    for (const queue of WORKER_CONSUMER_QUEUES) {
      expect(offWork).toHaveBeenCalledWith(queue, { wait: false });
    }
  });
});
