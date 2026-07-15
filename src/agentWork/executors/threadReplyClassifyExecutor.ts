import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool, PoolClient } from "pg";
import {
  parseAskQuestionResult,
  ASK_QUESTION_TOO_LONG_HINT,
} from "../../commands/parseAskQuestion.js";
import type { Config } from "../../config.js";
import { inTransaction } from "../../db/postgres.js";
import { logInfo, logWarn } from "../../evlog.js";
import { getAppBotIdentity, mintInstallationAuth } from "../../github/appAuth.js";
import { getPullRequestReviewComment } from "../../github/reviewPublish.js";
import { sanitizeLogMessage } from "../../security/sanitizeLogMessage.js";
import {
  ASK_USAGE_HINT,
  DEFERRED_HEAD_SHA,
  IGNORED_BOT_SLASH_COMMAND,
  IGNORED_NON_BOT_THREAD_REPLY,
  IGNORED_UNAUTHORIZED_SLASH,
  MAX_ASK_QUESTION_CHARS,
  THREAD_REPLY_ASK_ENQUEUED,
  THREAD_REPLY_CLASSIFICATION_FAILED,
} from "../../settings/index.js";
import { hasStoredInlineReviewId } from "../repository.js";
import {
  type AckJobData,
  type AckTarget,
  type PrRef,
  type ThreadReplyClassifyJobData,
  prResourceKey,
} from "../types.js";
import { enqueueAck, enqueueAsk, jobCorrelation } from "../intake/queueing.js";
import { createAskWorkItem } from "../intake/workItemRepository.js";
import {
  isTerminalThreadReplyDecision,
  isThreadReplyClassificationQueued,
  lockWebhookEventForUpdate,
  updateWebhookEventDecision,
} from "../intake/webhookEvents.js";

function isTerminalPgBossAttempt(job: JobWithMetadata<unknown>): boolean {
  return job.retryCount >= job.retryLimit;
}

function isUnauthorizedAssociation(cfg: Config, association: string | null | undefined): boolean {
  if (cfg.slashAllowedAssociations.has("*")) return false;
  if (association && cfg.slashAllowedAssociations.has(association.toUpperCase())) {
    return false;
  }
  return true;
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
    | typeof IGNORED_NON_BOT_THREAD_REPLY
    | typeof IGNORED_BOT_SLASH_COMMAND
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

    let askParse = parseAskQuestionResult(data.body);
    if (askParse.kind === "not_ask" && data.replyTarget.kind === "inlineReviewThread") {
      const question = data.body.trim();
      if (question.length === 0) {
        askParse = { kind: "missing" };
      } else if (question.length > MAX_ASK_QUESTION_CHARS) {
        askParse = { kind: "too_long" };
      } else {
        askParse = { kind: "ok", question };
      }
    }

    const correlation = jobCorrelation(eventId, {
      delivery: data.delivery,
      rawBody: Buffer.alloc(0),
    });
    const ref: PrRef = {
      owner: data.owner,
      repo: data.repo,
      prNumber: data.prNumber,
      installationId: data.installationId,
      headSha: DEFERRED_HEAD_SHA,
      repositorySizeKb: data.repositorySizeKb,
    };
    const targets: AckTarget[] = [
      { kind: "pr", prNumber: data.prNumber },
      { kind: "reviewComment", commentId: data.commentId },
    ];
    const baseAck: AckJobData = {
      kind: "ack",
      installationId: data.installationId,
      owner: data.owner,
      repo: data.repo,
      prNumber: data.prNumber,
      targets,
      commenterId: data.commenterId,
      ...correlation,
    };

    if (askParse.kind === "too_long") {
      await enqueueAck(boss, client, {
        ...baseAck,
        reply: { target: data.replyTarget, body: ASK_QUESTION_TOO_LONG_HINT },
      });
      await updateWebhookEventDecision(client, eventId, THREAD_REPLY_ASK_ENQUEUED);
      return;
    }
    if (askParse.kind !== "ok") {
      await enqueueAck(boss, client, {
        ...baseAck,
        reply: { target: data.replyTarget, body: ASK_USAGE_HINT },
      });
      await updateWebhookEventDecision(client, eventId, THREAD_REPLY_ASK_ENQUEUED);
      return;
    }

    const askInsert = await createAskWorkItem(client, {
      webhookEventId: eventId,
      ref,
      question: askParse.question,
      replyTarget: data.replyTarget,
      commentId: data.commentId,
      commenterId: data.commenterId,
      codeAnchor: data.codeAnchor,
    });
    await enqueueAck(boss, client, { ...baseAck, workItemId: askInsert.id });
    await enqueueAsk(boss, client, ref, askInsert.id, correlation);
    await updateWebhookEventDecision(client, eventId, THREAD_REPLY_ASK_ENQUEUED);
    logInfo("thread_reply_classification_terminal", {
      webhookEventId: eventId,
      decision: THREAD_REPLY_ASK_ENQUEUED,
      workItemId: askInsert.id,
      created: askInsert.created,
    });
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
    if (isUnauthorizedAssociation(cfg, data.authorAssociation)) {
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
