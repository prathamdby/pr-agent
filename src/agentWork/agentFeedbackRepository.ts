import type { Pool, PoolClient } from "pg";
import { logWarn } from "../evlog.ts";
import { errorMessage } from "../errors/errorMessage.ts";

const FEEDBACK_BUDGET_MS = 500;

export type AgentFeedbackInsert = {
  readonly deliveryKey: string | null;
  readonly groupKey: string;
  readonly workItemId: string;
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

function isPoolClient(db: Pool | PoolClient): db is PoolClient {
  return "release" in db && typeof db.release === "function";
}

function rejectAfter(ms: number): {
  readonly promise: Promise<never>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("obstacle_report_budget")), ms);
  });
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer);
    },
  };
}

async function withFeedbackClient<T>(
  db: Pool | PoolClient,
  run: (client: Pool | PoolClient) => Promise<T>,
): Promise<T> {
  if (isPoolClient(db)) {
    const budget = rejectAfter(FEEDBACK_BUDGET_MS);
    try {
      return await Promise.race([run(db), budget.promise]);
    } finally {
      budget.cancel();
    }
  }

  const budget = rejectAfter(FEEDBACK_BUDGET_MS);
  const connected = db.connect();
  let client: PoolClient;
  try {
    client = await Promise.race([connected, budget.promise]);
  } catch (error) {
    void connected.then((late) => late.release()).catch(() => undefined);
    throw error;
  } finally {
    budget.cancel();
  }

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${FEEDBACK_BUDGET_MS}ms`,
    ]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError) => {
      logWarn("agent_feedback_rollback_failed", { message: errorMessage(rollbackError) });
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function insertAgentFeedback(
  db: Pool | PoolClient,
  row: AgentFeedbackInsert,
): Promise<void> {
  await withFeedbackClient(db, (client) =>
    client.query(
      `INSERT INTO agent_feedback (
         delivery_key, group_key, work_item_id, installation_id, owner, repo, pr_number,
         execution_id, attempt_count, session_role, specialist, provider, model, tool_call_id,
         obstacle, subject, intent, problem, expected, severity
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20
       )
       ON CONFLICT (delivery_key) WHERE delivery_key IS NOT NULL DO NOTHING`,
      [
        row.deliveryKey,
        row.groupKey,
        row.workItemId,
        row.installationId,
        row.owner,
        row.repo,
        row.prNumber,
        row.executionId ?? null,
        row.attemptCount ?? null,
        row.sessionRole,
        row.specialist ?? null,
        row.provider,
        row.model,
        row.toolCallId,
        row.obstacle,
        row.subject,
        row.intent,
        row.problem,
        row.expected,
        row.severity,
      ],
    ),
  );
}
