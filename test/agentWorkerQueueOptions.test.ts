import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { logAgentQueueStats, retentionQueueWorkOptions } from "../src/agentWork/worker.js";
import * as evlog from "../src/evlog.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  CI_REFRESH_QUEUE,
  DESCRIPTION_QUEUE,
  RETENTION_QUEUE_POLLING_INTERVAL_SECONDS,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../src/settings/index.js";

describe("retentionQueueWorkOptions", () => {
  it("polls the once-daily retention queue on the slow interval", () => {
    expect(retentionQueueWorkOptions()).toMatchObject({
      localConcurrency: 1,
      pollingIntervalSeconds: RETENTION_QUEUE_POLLING_INTERVAL_SECONDS,
    });
  });
});

describe("logAgentQueueStats", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches queue stats concurrently and logs in original queue order", async () => {
    const queues = [
      ACK_QUEUE,
      REVIEW_QUEUE,
      ASK_QUEUE,
      DESCRIPTION_QUEUE,
      TRIAGE_QUEUE,
      VERIFICATION_QUEUE,
      CI_REFRESH_QUEUE,
    ];
    type Deferred = {
      readonly queue: string;
      readonly resolve: (stats: {
        queuedCount: number;
        activeCount: number;
        totalCount: number;
      }) => void;
    };
    const started: Deferred[] = [];
    const getQueueStats = vi.fn((queue: string) => {
      let resolve!: Deferred["resolve"];
      const promise = new Promise<
        [{ queuedCount: number; activeCount: number; totalCount: number }]
      >((res) => {
        resolve = (stats) => res([stats]);
      });
      started.push({ queue, resolve });
      return promise;
    });
    const boss = { getQueueStats } as unknown as PgBoss;
    const logDebug = vi.spyOn(evlog, "logDebug").mockImplementation(() => undefined);

    const statsPromise = logAgentQueueStats(boss);

    await vi.waitFor(() => expect(started).toHaveLength(queues.length));
    expect(started.map((entry) => entry.queue)).toEqual(queues);

    // Resolve out of order; logging must still follow the original queue list.
    const reverseCounts = queues.map((_, index) => ({
      queuedCount: 100 + index,
      activeCount: index,
      totalCount: 200 + index,
    }));
    for (let i = queues.length - 1; i >= 0; i -= 1) {
      const entry = started[i];
      const counts = reverseCounts[i];
      if (entry == null || counts == null) {
        throw new Error(`missing deferred stats for index ${i}`);
      }
      entry.resolve(counts);
    }

    await statsPromise;

    expect(logDebug.mock.calls.map((call) => call[0])).toEqual(
      queues.map(() => "agent_queue_stats"),
    );
    expect(logDebug.mock.calls.map((call) => call[1])).toEqual(
      queues.map((queue, index) => {
        const counts = reverseCounts[index];
        if (counts == null) {
          throw new Error(`missing expected counts for index ${index}`);
        }
        return {
          queue,
          queued: counts.queuedCount,
          active: counts.activeCount,
          total: counts.totalCount,
        };
      }),
    );
  });
});
