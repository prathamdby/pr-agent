import { Context, Duration, Effect } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { inTransaction } from "../db/postgres.js";
import { HEALTH_DB_PING_TIMEOUT_MS } from "../settings/index.js";
import type { RequestLogger } from "../evlog.js";
import {
  applyAutomatedPullRequestIntake,
  applySlashCommandIntake,
  recordIgnoredWebhook,
  type SlashCommandInput,
} from "./intake/applier.js";
import {
  applyThreadReplyClassifyIntake,
  type ThreadReplyClassifyInput,
} from "./intake/threadReplyClassifyIntake.js";
import { hasStoredInlineReviewId } from "./repository.js";
import type { PrRef, WebhookHeaders } from "./types.js";
import { prResourceKey } from "./types.js";

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
    /** DB-only: true when pull_request_review_id is a stored bot inline review. */
    readonly lookupStoredInlineReviewHint: (
      owner: string,
      repo: string,
      prNumber: number,
      pullRequestReviewId: number | null | undefined,
    ) => Effect.Effect<boolean, Error>;
    readonly submitThreadReplyClassification: (
      input: ThreadReplyClassifyInput,
      intakeLog: RequestLogger,
    ) => Effect.Effect<void, Error>;
    readonly ping: () => Effect.Effect<boolean>;
  }
>() {}

export function makeAgentWorkScheduler(
  pool: Pool,
  boss: PgBoss,
  cfg: Pick<Config, "reviewAutoActions" | "descriptionAutoActions" | "verificationAutoActions">,
) {
  return AgentWorkScheduler.of({
    recordIgnored: (headers, decision, intakeLog) =>
      Effect.tryPromise({
        try: () => recordIgnoredWebhook(pool, headers, decision, intakeLog),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    submitAutomatedReview: (headers, ref, action, intakeLog) =>
      Effect.tryPromise({
        try: () =>
          applyAutomatedPullRequestIntake(boss, pool, headers, ref, action, intakeLog, cfg),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    submitSlashCommand: (input, intakeLog) =>
      Effect.tryPromise({
        try: () =>
          inTransaction(pool, (client) => applySlashCommandIntake(boss, client, input, intakeLog)),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    lookupStoredInlineReviewHint: (owner, repo, prNumber, pullRequestReviewId) =>
      Effect.tryPromise({
        try: async () => {
          if (pullRequestReviewId == null) return false;
          const resourceKey = prResourceKey(owner, repo, prNumber);
          return hasStoredInlineReviewId(pool, resourceKey, pullRequestReviewId);
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),

    submitThreadReplyClassification: (input, intakeLog) =>
      Effect.tryPromise({
        try: () =>
          inTransaction(pool, (client) =>
            applyThreadReplyClassifyIntake(boss, client, input, intakeLog),
          ),
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
