import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { captureEvent } from "../../analytics/index.js";
import { runAskRun } from "../../agent/ask/askRun.js";
import { loadAskThreadTranscript } from "../../agent/ask/askThreadContext.js";
import { formatAskReply, sanitizeAskAnswerText } from "../../agent/ask/formatAskReply.js";
import {
  askReplyCommentIdFromIntentDetail,
  findExistingAskReplyComment,
} from "../../agent/ask/recoverAskReply.js";
import {
  classifyFailure,
  classifiedFailureLogFields,
  classifiedFailurePostHogProperties,
} from "../../errors/classifiedFailure.js";
import { getAppBotIdentity, installationOctokit } from "../../github/appAuth.js";
import { logWarn } from "../../evlog.js";
import { ASK_PUBLISH_LENS } from "../../settings/index.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { makeInstallationTokenRefresher, runDurableWorkItem } from "../durableJob.js";
import { getPullRequestHead, postSlashReply } from "../githubPrSurface.js";
import {
  getOperationIntent,
  mergeOperationIntentDetail,
  persistOperationIntent,
} from "../operationIntentRepository.js";
import { hasCompletedPublishStep, recordAskPublishStep } from "../repository.js";
import { askReplyOperationKey, withOperationIntent } from "../withOperationIntent.js";
import type { AskJobData, AskWorkItem } from "../types.js";
import { buildRepositoryViewParams } from "./repositoryViewParams.js";

async function publishAskAnswer(
  token: string,
  tokenExpiresAtTs: number,
  item: AskWorkItem,
  answer: string,
  alreadySanitized = false,
): Promise<{ commentId: number }> {
  const body = alreadySanitized ? answer : sanitizeAskAnswerText(answer);
  const replyTarget = item.payload.replyTarget;
  if (replyTarget.kind === "inlineReviewThread") {
    try {
      return await postSlashReply(
        token,
        item.owner,
        item.repo,
        replyTarget,
        body,
        tokenExpiresAtTs,
      );
    } catch (e) {
      const failure = classifyFailure(e, { phase: "publish", toolName: "ask_inline_reply" });
      logWarn("ask_inline_reply_failed", {
        owner: item.owner,
        repo: item.repo,
        pr: replyTarget.prNumber,
        inReplyToCommentId: replyTarget.inReplyToCommentId,
        message: e instanceof Error ? e.message : String(e),
        ...classifiedFailureLogFields(failure),
      });
      const octokit = installationOctokit(token, tokenExpiresAtTs);
      const { data } = await octokit.rest.issues.createComment({
        owner: item.owner,
        repo: item.repo,
        issue_number: replyTarget.prNumber,
        body: ["_Could not reply in the review thread; posting here instead._", "", body].join(
          "\n",
        ),
      });
      return { commentId: data.id };
    }
  }
  return await postSlashReply(token, item.owner, item.repo, replyTarget, body, tokenExpiresAtTs);
}

async function stashRecoveredAskReply(params: {
  readonly pool: Pool;
  readonly item: AskWorkItem;
  readonly operationKey: string;
  readonly commentId: number;
}): Promise<void> {
  const { pool, item, operationKey, commentId } = params;
  const intent = await getOperationIntent(pool, item.id, operationKey);
  const result = { commentId };
  if (intent == null) {
    await persistOperationIntent(pool, {
      workItemId: item.id,
      operationKey,
      mutationKind: "github.ask_reply",
      detail: {
        step: "ask_reply",
        resourceKey: item.resourceKey,
        reviewLens: ASK_PUBLISH_LENS,
        replyTargetKind: item.payload.replyTarget.kind,
        __result: result,
      },
    });
    return;
  }
  if (intent.status === "pending" && askReplyCommentIdFromIntentDetail(intent.detail) == null) {
    await mergeOperationIntentDetail(pool, {
      workItemId: item.id,
      operationKey,
      detail: { __result: result },
    });
  }
}

/**
 * Recover a GitHub ask reply that was accepted but not yet recorded locally.
 * Returns the comment id when delivery can complete without remutation/model rerun.
 */
async function recoverDeliveredAskReplyCommentId(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly token: string;
  readonly tokenExpiresAtTs: number;
  readonly item: AskWorkItem;
}): Promise<number | null> {
  const { cfg, pool, token, tokenExpiresAtTs, item } = params;
  const operationKey = askReplyOperationKey(item.resourceKey);
  const intent = await getOperationIntent(pool, item.id, operationKey);
  const stashed = askReplyCommentIdFromIntentDetail(intent?.detail);
  if (stashed != null) return stashed;

  const replyTarget = item.payload.replyTarget;
  if (replyTarget.kind === "inlineReviewThread") {
    return null;
  }

  const bot = await getAppBotIdentity(cfg);
  const recovered = await findExistingAskReplyComment({
    token,
    tokenExpiresAtTs,
    owner: item.owner,
    repo: item.repo,
    replyTarget,
    question: item.payload.question,
    botLogin: bot.login,
  });
  if (recovered == null) return null;

  await stashRecoveredAskReply({
    pool,
    item,
    operationKey,
    commentId: recovered.commentId,
  });
  return recovered.commentId;
}

async function finalizeAskReplyPublish(params: {
  readonly pool: Pool;
  readonly item: AskWorkItem;
  readonly commentId: number;
}): Promise<"ok" | "degraded"> {
  const { pool, item, commentId } = params;
  await withOperationIntent({
    client: pool,
    workItemId: item.id,
    operationKey: askReplyOperationKey(item.resourceKey),
    mutationKind: "github.ask_reply",
    detail: {
      step: "ask_reply",
      resourceKey: item.resourceKey,
      reviewLens: ASK_PUBLISH_LENS,
      replyTargetKind: item.payload.replyTarget.kind,
    },
    mutate: async () => ({ commentId }),
  });
  try {
    await recordAskPublishStep(pool, {
      workItemId: item.id,
      resourceKey: item.resourceKey,
      step: "ask_reply",
      detail: {
        replyTargetKind: item.payload.replyTarget.kind,
        commentId,
      },
    });
    return "ok";
  } catch (e) {
    const failure = classifyFailure(e, { phase: "publish" });
    logWarn("ask_publish_record_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      workItemId: item.id,
      message: e instanceof Error ? e.message : String(e),
      ...classifiedFailureLogFields(failure),
    });
    captureEvent({
      distinctId: `installation:${item.installationId}`,
      event: "ask failed",
      properties: {
        owner: item.owner,
        repo: item.repo,
        pr_number: item.prNumber,
        reply_target_kind: item.payload.replyTarget.kind,
        ...classifiedFailurePostHogProperties(failure),
      },
    });
    return "degraded";
  }
}

export async function executeAskJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<AskJobData>,
): Promise<void> {
  let answerDelivered = false;
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "ask",
    resolveHeadSha: (token, expiresAtTs, item) =>
      getPullRequestHead(token, item.owner, item.repo, item.prNumber, expiresAtTs),
    execute: async (item, env) => {
      const tokenState = { installation: env.installation };
      const headSha = env.headSha;
      const payload = item.payload;
      const askReplyPublished = () =>
        hasCompletedPublishStep(pool, item.id, item.resourceKey, ASK_PUBLISH_LENS, "ask_reply");
      if (await askReplyPublished()) {
        answerDelivered = true;
        return {};
      }

      const recoveredCommentId = await recoverDeliveredAskReplyCommentId({
        cfg,
        pool,
        token: tokenState.installation.token,
        tokenExpiresAtTs: tokenState.installation.expiresAtTs,
        item,
      });
      if (recoveredCommentId != null) {
        answerDelivered = true;
        const status = await finalizeAskReplyPublish({
          pool,
          item,
          commentId: recoveredCommentId,
        });
        return status === "degraded" ? { degraded: true } : {};
      }

      return withPrRepositoryView(
        buildRepositoryViewParams(
          item,
          { installation: tokenState.installation, headSha, pullRequest: env.pullRequest },
          payload,
        ),
        async (repositoryView) => {
          const transcript = await loadAskThreadTranscript({
            token: tokenState.installation.token,
            tokenExpiresAtTs: tokenState.installation.expiresAtTs,
            owner: item.owner,
            repo: item.repo,
            replyTarget: payload.replyTarget,
            commentId: payload.commentId,
          });
          const result = await runAskRun({
            cfg,
            token: tokenState.installation.token,
            tokenExpiresAtTs: tokenState.installation.expiresAtTs,
            tokenTtlMs: tokenState.installation.ttlMs,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            question: payload.question,
            replyTarget: payload.replyTarget,
            codeAnchor: payload.codeAnchor,
            threadTranscript: transcript.text,
            threadTranscriptTruncated: transcript.truncated,
            cwd: repositoryView.agentCwd,
            workspace: repositoryView.workspace,
            refreshInstallationToken: makeInstallationTokenRefresher(
              cfg,
              item.installationId,
              tokenState,
            ),
            durability: {
              pool,
              workItemId: item.id,
              installationId: item.installationId,
            },
          });
          if (!(await askReplyPublished())) {
            const posted = await withOperationIntent({
              client: pool,
              workItemId: item.id,
              operationKey: askReplyOperationKey(item.resourceKey),
              mutationKind: "github.ask_reply",
              detail: {
                step: "ask_reply",
                resourceKey: item.resourceKey,
                reviewLens: ASK_PUBLISH_LENS,
                replyTargetKind: payload.replyTarget.kind,
              },
              mutate: () =>
                publishAskAnswer(
                  tokenState.installation.token,
                  tokenState.installation.expiresAtTs,
                  item,
                  result.answer,
                  true,
                ),
            });
            answerDelivered = true;
            captureEvent({
              distinctId: `installation:${item.installationId}`,
              event: "ask answered",
              properties: {
                owner: item.owner,
                repo: item.repo,
                pr_number: item.prNumber,
                reply_target_kind: payload.replyTarget.kind,
              },
            });
            try {
              await recordAskPublishStep(pool, {
                workItemId: item.id,
                resourceKey: item.resourceKey,
                step: "ask_reply",
                detail: {
                  replyTargetKind: payload.replyTarget.kind,
                  commentId: posted.commentId,
                },
              });
            } catch (e) {
              const failure = classifyFailure(e, { phase: "publish" });
              logWarn("ask_publish_record_failed", {
                owner: item.owner,
                repo: item.repo,
                pr: item.prNumber,
                workItemId: item.id,
                message: e instanceof Error ? e.message : String(e),
                ...classifiedFailureLogFields(failure),
              });
              captureEvent({
                distinctId: `installation:${item.installationId}`,
                event: "ask failed",
                properties: {
                  owner: item.owner,
                  repo: item.repo,
                  pr_number: item.prNumber,
                  reply_target_kind: payload.replyTarget.kind,
                  ...classifiedFailurePostHogProperties(failure),
                },
              });
              return { degraded: true };
            }
          } else {
            answerDelivered = true;
          }
          return {};
        },
      );
    },
    onTerminalFailure: async (item, installation, error) => {
      const failure = classifyFailure(error ?? new Error("Ask failed after retries"), {
        phase: "ask",
      });
      captureEvent({
        distinctId: `installation:${item.installationId}`,
        event: "ask failed",
        properties: {
          owner: item.owner,
          repo: item.repo,
          pr_number: item.prNumber,
          reply_target_kind: item.payload.replyTarget.kind,
          ...classifiedFailurePostHogProperties(failure),
        },
      });
      if (!installation || answerDelivered) return;
      const payload = item.payload;
      await publishAskAnswer(
        installation.token,
        installation.expiresAtTs,
        item,
        formatAskReply({
          question: payload.question,
          answer: "PR Agent could not complete this ask after retries. Please try again later.",
          replyTarget: payload.replyTarget,
        }),
        true,
      );
    },
  });
}
