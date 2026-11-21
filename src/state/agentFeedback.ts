import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { readRow } from "./db.ts";

export type AgentFeedbackInsert = {
  readonly deliveryKey: string | null;
  readonly groupKey: string;
  readonly workId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly executionId?: string;
  readonly attemptCount?: number;
  readonly sessionRole: string;
  readonly specialist?: string;
  readonly provider: string;
  readonly model: string;
  readonly toolCallId: string | null;
  readonly obstacle: "tool" | "prompt" | "input" | "instruction";
  readonly subject: string;
  readonly intent: string;
  readonly problem: string;
  readonly expected: string;
  readonly severity: "blocked" | "degraded" | "noise";
};

export function insertAgentFeedback(db: DatabaseSync, row: AgentFeedbackInsert, now: number) {
  if (row.deliveryKey !== null) {
    const existing = readRow(
      db
        .prepare(
          `SELECT id FROM agent_feedback WHERE json_extract(payload_json, '$.deliveryKey') = ?`,
        )
        .get(row.deliveryKey),
      v.object({ id: v.optional(v.number()) }),
    );
    if (existing !== undefined) return;
  }
  db.prepare(
    `INSERT INTO agent_feedback (work_id, pr_key, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.workId,
    `${row.owner}/${row.repo}#${String(row.prNumber)}`,
    row.obstacle,
    JSON.stringify(row),
    now,
  );
}
