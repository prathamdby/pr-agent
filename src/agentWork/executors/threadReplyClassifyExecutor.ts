import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool, PoolClient } from "pg";
import type { Config } from "../../config.js";
import { isSlashAssociationAllowed } from "../../commands/slashAssociation.js";
import { inTransaction } from "../../db/postgres.js";
import { logInfo, logWarn } from "../../evlog.js";
import { getAppBotIdentity, mintInstallationAuth } from "../../github/appAuth.js";
import { getPullRequestReviewComment } from "../../github/reviewPublish.js";
import { sanitizeLogMessage } from "../../security/sanitizeLogMessage.js";
import {
  IGNORED_BOT_SLASH_COMMAND,
  IGNORED_NON_BOT_THREAD_REPLY,
  IGNORED_UNAUTHORIZED_SLASH,
  THREAD_REPLY_ASK_ENQUEUED,
  THREAD_REPLY_CLASSIFICATION_FAILED,
} from "../../settings/index.js";
import { hasStoredInlineReviewId } from "../repository.js";
import { type AckTarget, type ThreadReplyClassifyJobData, prResourceKey } from "../types.js";
import { promoteAskFromWebhookEvent } from "../intake/askIntake.js";
import { jobCorrelation } from "../intake/queueing.js";
import {
  isTerminalThreadReplyDecision,
  isThreadReplyClassificationQueued,
  lockWebhookEventForUpdate,
  updateWebhookEventDecision,
} from "../intake/webhookEvents.js";

function isTerminalPgBossAttempt(job: JobWithMetadata<unknown>): boolean {
  return job.retryCount >= job.retryLimit;
}

async function resolveIsBotThread(
  cfg: Config,
  pool: Pool,
  data: ThreadReplyClassifyJobData,
  botUserId: number,
): Promise<boolean> {
  if (data.storedReviewMatchHint === true) {
    return true;
  }

  const resourceKey = prResourceKey(data.owner, data.repo, data.prNumber);
  let reviewId = data.pullRequestReviewId;

  if (reviewId != null && (await hasStoredInlineReviewId(pool, resourceKey, reviewId))) {
    return true;
  }

  const auth = await mintInstallationAuth(cfg, data.installationId);
  const parent = await getPullRequestReviewComment(
    auth.token,
    data.owner,
    data.repo,
    data.inReplyToCommentId,
  );
  if (parent.userId === botUserId) return true;
  reviewId = parent.pullRequestReviewId;
  if (reviewId == null) return false;
  return hasStoredInlineReviewId(pool, resourceKey, reviewId);
}

function missingWebhookEventError(eventId: string): Error {
  return new Error(`webhook event ${eventId} missing during thread reply promotion`);
}

async function markTerminalDecision(
  client: PoolClient,
  eventId: string,
  decision: string,
  errorMessage: string | null = null,
): Promise<"applied" | "already_terminal"> {
  const locked = await lockWebhookEventForUpdate(client, eventId);
  if (!locked) throw missingWebhookEventError(eventId);
  if (isTerminalThreadReplyDecision(locked.processingDecision)) {
    return "already_terminal";
  }
  if (!isThreadReplyClassificationQueued(locked.processingDecision)) {
    return "already_terminal";
  }
  await updateWebhookEventDecision(client, eventId, decision, errorMessage);
  return "applied";
}

async function promoteNegative(
  pool: Pool,
  eventId: string,
  decision:
    | typeof IGNORED_BOT_SLASH_COMMAND
    | typeof IGNORED_NON_BOT_THREAD_REPLY
    | typeof IGNORED_UNAUTHORIZED_SLASH,
): Promise<void> {
  await inTransaction(pool, async (client) => {
    const result = await markTerminalDecision(client, eventId, decision);
    if (result === "applied") {
      logInfo("thread_reply_classification_terminal", { webhookEventId: eventId, decision });
    }
  });
}

async function promotePositiveAsk(
  boss: PgBoss,
  pool: Pool,
  data: ThreadReplyClassifyJobData,
): Promise<void> {
  const eventId = data.webhookEventId;
  if (eventId == null) {
    throw new Error("thread reply classify job missing webhookEventId");
  }

  await inTransaction(pool, async (client) => {
    const locked = await lockWebhookEventForUpdate(client, eventId);
    if (!locked) throw missingWebhookEventError(eventId);
    if (isTerminalThreadReplyDecision(locked.processingDecision)) return;
    if (!isThreadReplyClassificationQueued(locked.processingDecision)) return;

    const correlation = jobCorrelation(eventId, {
      delivery: data.delivery,
      rawBody: Buffer.alloc(0),
    });
    const targets: AckTarget[] = [
      { kind: "pr", prNumber: data.prNumber },
      { kind: "reviewComment", commentId: data.commentId },
    ];

    const outcome = await promoteAskFromWebhookEvent(
      boss,
      client,
      {
        webhookEventId: eventId,
        correlation,
        installationId: data.installationId,
        owner: data.owner,
        repo: data.repo,
        repositorySizeKb: data.repositorySizeKb,
        prNumber: data.prNumber,
        body: data.body,
        replyTarget: data.replyTarget,
        commentId: data.commentId,
        commenterId: data.commenterId,
        codeAnchor: data.codeAnchor,
        ackTargets: targets,
      },
      "recover",
    );

    await updateWebhookEventDecision(client, eventId, THREAD_REPLY_ASK_ENQUEUED);

    switch (outcome.kind) {
      case "hint_acked":
        logInfo("thread_reply_classification_terminal", {
          webhookEventId: eventId,
          decision: THREAD_REPLY_ASK_ENQUEUED,
          hint: outcome.reason,
        });
        break;
      case "promoted":
        logInfo("thread_reply_classification_terminal", {
          webhookEventId: eventId,
          decision: THREAD_REPLY_ASK_ENQUEUED,
          workItemId: outcome.workItemId,
          created: outcome.created,
        });
        break;
      case "already_exists_skipped":
        // recover policy never returns this; keep exhaustive
        break;
      default: {
        const exhaustive: never = outcome;
        void exhaustive;
      }
    }
  });
}

export async function executeThreadReplyClassifyJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<ThreadReplyClassifyJobData>,
): Promise<void> {
  const data = job.data;
  const eventId = data.webhookEventId;
  if (eventId == null) {
    throw new Error("thread reply classify job missing webhookEventId");
  }

  try {
    const bot = await getAppBotIdentity(cfg);
    if (data.commenterId === bot.userId) {
      await promoteNegative(pool, eventId, IGNORED_BOT_SLASH_COMMAND);
      return;
    }
    if (!isSlashAssociationAllowed(cfg.slashAllowedAssociations, data.authorAssociation)) {
      await promoteNegative(pool, eventId, IGNORED_UNAUTHORIZED_SLASH);
      return;
    }

    const isBotThread = await resolveIsBotThread(cfg, pool, data, bot.userId);
    if (!isBotThread) {
      await promoteNegative(pool, eventId, IGNORED_NON_BOT_THREAD_REPLY);
      return;
    }

    await promotePositiveAsk(boss, pool, data);
  } catch (error) {
    const message = sanitizeLogMessage(error instanceof Error ? error.message : String(error));
    if (isTerminalPgBossAttempt(job)) {
      await inTransaction(pool, async (client) => {
        await markTerminalDecision(client, eventId, THREAD_REPLY_CLASSIFICATION_FAILED, message);
      });
      logWarn("thread_reply_classification_failed", {
        webhookEventId: eventId,
        delivery: data.delivery,
        message,
      });
    }
    throw error;
  }
}
