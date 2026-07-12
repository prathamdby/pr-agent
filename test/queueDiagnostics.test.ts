import { describe, expect, it, vi } from "vitest";
import {
  collectQueueStallDiagnostic,
  formatQueueStallLogFields,
} from "../src/agentWork/queueDiagnostics.js";
import {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  DESCRIPTION_QUEUE,
  RETENTION_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_DEAD_LETTER_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
  VERIFICATION_QUEUE,
} from "../src/settings/index.js";

const ALL_QUEUES = [
  ACK_QUEUE,
  REVIEW_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
  RETENTION_QUEUE,
  ACK_DEAD_LETTER_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  TRIAGE_DEAD_LETTER_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
];

describe("collectQueueStallDiagnostic", () => {
  it("reports depth/age, DLQ, blocked keys, and oldest running work without treating empty as healthy", async () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const boss = {
      getQueue: vi.fn(async (name: string) => ({
        name,
        queuedCount: name === REVIEW_QUEUE ? 2 : 0,
        activeCount: name === REVIEW_QUEUE ? 1 : 0,
        totalCount: name === REVIEW_QUEUE ? 3 : name.endsWith("-dead") ? 1 : 0,
        failedCount: name === REVIEW_QUEUE ? 1 : 0,
      })),
      getBlockedKeys: vi.fn(async (name: string) =>
        name === REVIEW_QUEUE ? ["owner/repo#1:review"] : [],
      ),
      findJobs: vi.fn(async (_name: string, opts: { key?: string }) => {
        if (opts.key === "owner/repo#1:review") {
          return [
            {
              state: "failed",
              blocked: false,
              createdOn: new Date(now - 120_000),
            },
          ];
        }
        return [];
      }),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pgboss.job")) {
          return { rows: [{ age_seconds: 45 }] };
        }
        return { rows: [{ type: "review", age_seconds: 90 }] };
      }),
    };

    const diagnostic = await collectQueueStallDiagnostic({
      boss: boss as never,
      pool: pool as never,
      nowMs: () => now,
    });

    expect(diagnostic.emptyQueuesDoNotImplyHealthy).toBe(true);
    expect(diagnostic.queues.map((q) => q.queue)).toEqual([
      ACK_QUEUE,
      REVIEW_QUEUE,
      ASK_QUEUE,
      DESCRIPTION_QUEUE,
      TRIAGE_QUEUE,
      VERIFICATION_QUEUE,
      RETENTION_QUEUE,
    ]);
    expect(diagnostic.queues.find((q) => q.queue === REVIEW_QUEUE)).toMatchObject({
      queued: 2,
      active: 1,
      oldestQueuedAgeSeconds: 45,
    });
    expect(diagnostic.deadLetters.every((q) => ALL_QUEUES.includes(q.queue))).toBe(true);
    expect(diagnostic.blockedKeys).toEqual([
      { queue: REVIEW_QUEUE, key: "owner/repo#1:review", ageSeconds: 120 },
    ]);
    expect(diagnostic.oldestRunningWork).toEqual([{ type: "review", ageSeconds: 90 }]);

    const fields = formatQueueStallLogFields(diagnostic);
    expect(fields.empty_queues_do_not_imply_healthy).toBe(true);
    expect(fields.blocked_key_count).toBe(1);
    expect(fields.dead_letter_total).toBe(6);
  });
});
