import { Context, Duration, Effect } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { inTransaction } from "../db/postgres.js";
import { HEALTH_DB_PING_TIMEOUT_MS } from "../settings/index.js";
import type { RequestLogger } from "../evlog.js";
import { logWarn } from "../evlog.js";
import {
  applyAutomatedPullRequestIntake,
  applySlashCommandIntake,
  recordIgnoredWebhook,
  type SlashCommandInput,
} from "./intake/applier.js";
import { hasStoredInlineReviewId } from "./repository.js";
import type { PrRef, WebhookHeaders } from "./types.js";
import { prResourceKey } from "./types.js";
import { getPullRequestReviewComment } from "../github/reviewPublish.js";
import { mintInstallationAuth, getAppBotIdentity } from "../github/appAuth.js";

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
    readonly matchesStoredInlineReview: (
      installationId: number,
      owner: string,
      repo: string,
      prNumber: number,
      pullRequestReviewId: number | null | undefined,
      inReplyToId: number,
    ) => Effect.Effect<boolean, Error>;
    readonly ping: () => Effect.Effect<boolean>;
  }
>() {}

export function makeAgentWorkScheduler(
  pool: Pool,
  boss: PgBoss,
  cfg: Pick<
    Config,
    | "reviewAutoActions"
    | "descriptionAutoActions"
    | "verificationAutoActions"
    | "githubAppId"
    | "githubAppPrivateKey"
  >,
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

    matchesStoredInlineReview: (
      installationId,
      owner,
      repo,
      prNumber,
      pullRequestReviewId,
      inReplyToId,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const resourceKey = prResourceKey(owner, repo, prNumber);
          let reviewId = pullRequestReviewId ?? null;
          if (reviewId != null && (await hasStoredInlineReviewId(pool, resourceKey, reviewId))) {
            return true;
          }
          const auth = await mintInstallationAuth(cfg, installationId);
          const parent = await getPullRequestReviewComment(auth.token, owner, repo, inReplyToId);
          const bot = await getAppBotIdentity(cfg);
          if (parent.userId === bot.userId) return true;
          reviewId = parent.pullRequestReviewId;
          if (reviewId == null) return false;
          return hasStoredInlineReviewId(pool, resourceKey, reviewId);
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            logWarn("thread_reply_bot_thread_lookup_failed", {
              owner,
              repo,
              pr: prNumber,
              message: e.message,
            });
            return false;
          }),
        ),
      ),

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
