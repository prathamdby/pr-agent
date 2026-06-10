import { Context, Duration, Effect } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { inTransaction } from "../db/postgres.js";
import { HEALTH_DB_PING_TIMEOUT_MS } from "../settings/index.js";
import type { RequestLogger } from "../evlog.js";
import {
  applyAutomatedPullRequestIntake,
  applySlashCommandIntake,
  recordIgnoredWebhook,
  type SlashCommandInput,
} from "./intake/applier.js";
import { planAutomatedPullRequestIntake } from "./intake/planner.js";
import type { PrRef, WebhookHeaders } from "./types.js";

export class AgentWorkScheduler extends Context.Tag("AgentWorkScheduler")<
  AgentWorkScheduler,
  {
    readonly recordIgnored: (
      headers: WebhookHeaders,
      decision: string,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
    readonly submitAutomatedReview: (
      headers: WebhookHeaders,
      ref: PrRef,
      action: string,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
    readonly submitSlashCommand: (
      input: SlashCommandInput,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
    readonly ping: () => Effect.Effect<boolean>;
  }
>() {}

export function makeAgentWorkScheduler(pool: Pool, boss: PgBoss) {
  return AgentWorkScheduler.of({
    recordIgnored: (headers, decision, intakeLog) =>
      Effect.tryPromise({
        try: () => recordIgnoredWebhook(pool, headers, decision, intakeLog),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    submitAutomatedReview: (headers, ref, action, intakeLog) =>
      Effect.tryPromise({
        try: async () => {
          const plan = planAutomatedPullRequestIntake(action);
          if (plan.kinds.length === 0) {
            await recordIgnoredWebhook(pool, headers, `ignored_pull_request_${action}`, intakeLog);
            return;
          }
          await inTransaction(pool, (client) =>
            applyAutomatedPullRequestIntake(boss, client, headers, ref, action, intakeLog),
          );
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    submitSlashCommand: (input, intakeLog) =>
      Effect.tryPromise({
        try: () =>
          inTransaction(pool, (client) => applySlashCommandIntake(boss, client, input, intakeLog)),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    ping: () =>
      Effect.tryPromise({
        try: () => pool.query("SELECT 1"),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.timeout(Duration.millis(HEALTH_DB_PING_TIMEOUT_MS)),
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      ),
  });
}
