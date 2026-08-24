import { Context, Duration, Effect } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { inTransaction } from "../db/postgres.js";
import { HEALTH_DB_PING_TIMEOUT_MS } from "../settings/index.js";
import type { RequestLogger } from "../evlog.js";
import {
  applyAutomatedPullRequestIntake,
  applyCiRefreshIntake,
  applySlashCommandIntake,
  recordIgnoredWebhook,
  type SlashCommandInput,
} from "./intake/applier.js";
import { flushDeferredEvents } from "./intake/deferredEvents.js";
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
      opts?: { readonly pushBeforeSha?: string; readonly merged?: boolean },
    ) => Effect.Effect<void, Error>;
    readonly submitCiRefresh: (
      headers: WebhookHeaders,
      data: {
        readonly installationId: number;
        readonly owner: string;
        readonly repo: string;
        readonly headSha: string;
        readonly prNumbers: readonly number[];
      },
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
    readonly submitSlashCommand: (
      input: SlashCommandInput,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
    readonly ping: () => Effect.Effect<boolean>;
  }
>() {}

export function makeAgentWorkScheduler(pool: Pool, boss: PgBoss, cfg: Pick<Config, "features">) {
  return AgentWorkScheduler.of({
    recordIgnored: (headers, decision, intakeLog) =>
      Effect.tryPromise({
        try: () =>
          inTransaction(pool, (client) =>
            recordIgnoredWebhook(client, headers, decision, intakeLog),
          ),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    submitAutomatedReview: (headers, ref, action, intakeLog, opts) =>
      Effect.tryPromise({
        try: () =>
          applyAutomatedPullRequestIntake(boss, pool, headers, ref, action, intakeLog, cfg, opts),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    submitCiRefresh: (headers, data, intakeLog) =>
      Effect.tryPromise({
        try: () => applyCiRefreshIntake(boss, pool, headers, data, intakeLog),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    submitSlashCommand: (input, intakeLog) =>
      Effect.tryPromise({
        try: async () => {
          const events = await inTransaction(pool, (client) =>
            applySlashCommandIntake(boss, client, input, cfg.features),
          );
          flushDeferredEvents(intakeLog, events);
        },
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
