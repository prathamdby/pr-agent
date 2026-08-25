import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import type { PrSurface } from "../../github/prSurface.js";
import { captureEvent } from "../../analytics/index.js";
import { runAskRun } from "../../agent/ask/askRun.js";
import { loadAskThreadTranscript } from "../../agent/ask/askThreadContext.js";
import { formatAskReply, sanitizeAskAnswerText } from "../../agent/ask/formatAskReply.js";
import {
  askReplyBodyWithOperationMarker,
  askReplyCommentIdFromIntentDetail,
  findExistingAskReplyComment,
} from "../../agent/ask/recoverAskReply.js";
import {
  classifyFailure,
  classifiedFailureLogFields,
  classifiedFailurePostHogProperties,
} from "../../errors/classifiedFailure.js";
import { getAppBotIdentity } from "../../github/appAuth.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import { logWarn } from "../../evlog.js";
import { ASK_PUBLISH_LENS } from "../../settings/index.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { resolveWorkItemHead, runDurableWorkItem } from "../durableJob.js";
import {
  getOperationIntent,
  mergeOperationIntentDetail,
  persistOperationIntent,
  reconcileOperationIntent,
} from "../operationIntentRepository.js";
import { hasCompletedPublishStep, recordAskPublishStep } from "../repository.js";
import {
  askReplyOperationKey,
  isKnownNoAcceptanceMutationError,
  withOperationIntent,
} from "../withOperationIntent.js";
import { recordAskProviderUsage } from "../askQuota.js";
import type { AskJobData, AskWorkItem } from "../types.js";
import { buildRepositoryViewParams } from "./repositoryViewParams.js";

function replyTargetKindFromIntentDetail(
  value: unknown,
  fallback: AskWorkItem["payload"]["replyTarget"]["kind"],
): AskWorkItem["payload"]["replyTarget"]["kind"] {
  return value === "inlineReviewThread" || value === "prConversation" ? value : fallback;
}

function askReplyLookupKeys(resourceKey: string, operationKey: string): readonly string[] {
  const legacyKey = askReplyOperationKey(resourceKey);
  return legacyKey === operationKey ? [operationKey] : [operationKey, legacyKey];
}

async function findAskReplyOnAnyTarget(params: {
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
  readonly botLogin: string;
  readonly operationKey: string;
  readonly operationInstance: string;
}) {
  const { prSurface, item, botLogin, operationKey, operationInstance } = params;
  for (const key of askReplyLookupKeys(item.resourceKey, operationKey)) {
    const primary = await findExistingAskReplyComment({
      prSurface,
      replyTarget: item.payload.replyTarget,
      question: item.payload.question,
      botLogin,
      operationKey: key,
      operationInstance,
    });
    if (primary != null) return primary;
    if (item.payload.replyTarget.kind === "prConversation") continue;
    const conversation = await findExistingAskReplyComment({
      prSurface,
      replyTarget: { kind: "prConversation", prNumber: item.prNumber },
      question: item.payload.question,
      botLogin,
      operationKey: key,
      operationInstance,
    });
    if (conversation != null) return conversation;
  }
  return null;
}

async function publishAskAnswer(
  cfg: Config,
  prSurface: PrSurface,
  item: AskWorkItem,
  answer: string,
  operationKey: string,
  alreadySanitized = false,
): Promise<{ commentId: number; targetKind: AskWorkItem["payload"]["replyTarget"]["kind"] }> {
  const body = alreadySanitized ? answer : sanitizeAskAnswerText(answer);
  const replyTarget = item.payload.replyTarget;
  const markedBody = askReplyBodyWithOperationMarker(body, operationKey, item.id);
  try {
    const posted = await prSurface.replyAt(replyTarget, markedBody);
    return { ...posted, targetKind: replyTarget.kind };
  } catch (e) {
    if (replyTarget.kind !== "inlineReviewThread") throw e;
    const bot = await getAppBotIdentity(cfg);
    let recovered = null;
    for (const key of askReplyLookupKeys(item.resourceKey, operationKey)) {
      recovered = await findExistingAskReplyComment({
        prSurface,
        replyTarget,
        question: item.payload.question,
        botLogin: bot.login,
        operationKey: key,
        operationInstance: item.id,
      });
      if (recovered != null) break;
    }
    if (recovered != null) {
      return { commentId: recovered.commentId, targetKind: recovered.targetKind };
    }
    const failure = classifyFailure(e, { phase: "publish", toolName: "ask_inline_reply" });
    logWarn("ask_inline_reply_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: replyTarget.prNumber,
      inReplyToCommentId: replyTarget.inReplyToCommentId,
      message: e instanceof Error ? e.message : String(e),
      ...classifiedFailureLogFields(failure),
    });
    if (!isKnownNoAcceptanceMutationError(e)) throw e;
    const fallback = await prSurface.replyAt(
      { kind: "prConversation", prNumber: replyTarget.prNumber },
      askReplyBodyWithOperationMarker(
        ["_Could not reply in the review thread; posting here instead._", "", body].join("\n"),
        operationKey,
        item.id,
      ),
    );
    return { ...fallback, targetKind: "prConversation" };
  }
}

async function stashRecoveredAskReply(params: {
  readonly pool: Pool;
  readonly item: AskWorkItem;
  readonly operationKey: string;
  readonly commentId: number;
  readonly targetKind: AskWorkItem["payload"]["replyTarget"]["kind"];
}): Promise<void> {
  const { pool, item, operationKey, commentId, targetKind } = params;
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
        replyTargetKind: targetKind,
        __result: result,
      },
    });
    return;
  }
  if (askReplyCommentIdFromIntentDetail(intent.detail) != null) return;
  if (intent.status === "outcome_unknown") {
    // Evidence recovered from GitHub: finish the unknown outcome without remutating.
    await reconcileOperationIntent(pool, {
      workItemId: item.id,
      operationKey,
      status: "reconciled",
      detail: {
        __result: result,
        replyTargetKind: targetKind,
        recoveredAfterMutating: true,
      },
    });
    return;
  }
  if (intent.status === "pending") {
    await mergeOperationIntentDetail(pool, {
      workItemId: item.id,
      operationKey,
      detail: { __result: result, replyTargetKind: targetKind },
    });
  }
}

/**
 * Recover a GitHub ask reply that was accepted but not yet recorded locally.
 * Returns the comment id when delivery can complete without remutation/model rerun.
 */
type AskReplyRecovery =
  | {
      readonly kind: "recovered";
      readonly commentId: number;
      readonly targetKind: AskWorkItem["payload"]["replyTarget"]["kind"];
    }
  | { readonly kind: "outcome_unknown" }
  | null;

async function recoverDeliveredAskReplyCommentId(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
}): Promise<AskReplyRecovery> {
  const { cfg, pool, prSurface, item } = params;
  const operationKey = askReplyOperationKey(item.resourceKey, item.payload.commentId);
  const intent = await getOperationIntent(pool, item.id, operationKey);
  const stashed = askReplyCommentIdFromIntentDetail(intent?.detail);
  if (stashed != null) {
    return {
      kind: "recovered",
      commentId: stashed,
      targetKind: replyTargetKindFromIntentDetail(
        intent?.detail.replyTargetKind,
        item.payload.replyTarget.kind,
      ),
    };
  }

  // Scan only while the mutation may still be in flight or outcome-unknown.
  // Skip failed/reconciled so an older identical-question reply is not reused.
  if (intent == null || (intent.status !== "pending" && intent.status !== "outcome_unknown")) {
    return null;
  }

  const bot = await getAppBotIdentity(cfg);
  const recovered = await findAskReplyOnAnyTarget({
    prSurface,
    item,
    botLogin: bot.login,
    operationKey,
    operationInstance: item.id,
  });
  if (recovered == null) {
    return intent.status === "outcome_unknown" || intent.detail.__mutating === true
      ? { kind: "outcome_unknown" }
      : null;
  }

  await stashRecoveredAskReply({
    pool,
    item,
    operationKey,
    commentId: recovered.commentId,
    targetKind: recovered.targetKind ?? item.payload.replyTarget.kind,
  });
  return {
    kind: "recovered",
    commentId: recovered.commentId,
    targetKind: recovered.targetKind ?? item.payload.replyTarget.kind,
  };
}

async function finalizeAskReplyPublish(params: {
  readonly pool: Pool;
  readonly item: AskWorkItem;
  readonly commentId: number;
  readonly targetKind: AskWorkItem["payload"]["replyTarget"]["kind"];
  readonly leaseEpoch: number | null;
}): Promise<"ok" | "degraded"> {
  const { pool, item, commentId, targetKind, leaseEpoch } = params;
  await withOperationIntent({
    client: pool,
    workItemId: item.id,
    operationKey: askReplyOperationKey(item.resourceKey, item.payload.commentId),
    mutationKind: "github.ask_reply",
    leaseEpoch,
    detail: {
      step: "ask_reply",
      resourceKey: item.resourceKey,
      reviewLens: ASK_PUBLISH_LENS,
      replyTargetKind: targetKind,
    },
    mutate: async () => ({ commentId }),
  });
  try {
    await recordAskPublishStep(pool, {
      workItemId: item.id,
      resourceKey: item.resourceKey,
      step: "ask_reply",
      detail: {
        replyTargetKind: targetKind,
        commentId,
      },
      leaseEpoch,
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
    resolveHeadSha: resolveWorkItemHead,
    execute: async (item, env) => {
      const { prSurface } = env;
      const headSha = env.headSha;
      const payload = item.payload;
      const askReplyPublished = () =>
        hasCompletedPublishStep(pool, item.id, item.resourceKey, ASK_PUBLISH_LENS, "ask_reply");
      if (await askReplyPublished()) {
        answerDelivered = true;
        return { kind: "completed" };
      }

      const recoveredReply = await recoverDeliveredAskReplyCommentId({
        cfg,
        pool,
        prSurface,
        item,
      });
      if (recoveredReply?.kind === "recovered") {
        answerDelivered = true;
        const status = await finalizeAskReplyPublish({
          pool,
          item,
          commentId: recoveredReply.commentId,
          targetKind: recoveredReply.targetKind,
          leaseEpoch: env.leaseEpoch,
        });
        return status === "degraded"
          ? { kind: "completed", degraded: true }
          : { kind: "completed" };
      }
      if (recoveredReply?.kind === "outcome_unknown") {
        // The provider may have accepted the reply, but no exact marker was
        // found. Do not rerun the model or create a fallback reply.
        answerDelivered = true;
        return { kind: "completed", degraded: true };
      }

      return withPrRepositoryView(
        buildRepositoryViewParams(
          item,
          {
            gitCredentialAuth: () => prSurface.gitCredentialAuth(),
            headSha,
            pullRequest: env.pullRequest,
          },
          payload,
        ),
        async (repositoryView) => {
          const transcript = await loadAskThreadTranscript({
            prSurface,
            replyTarget: payload.replyTarget,
            commentId: payload.commentId,
          });
          const result = await runAskRun({
            cfg,
            prSurface,
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
            durability: {
              pool,
              workItemId: item.id,
              installationId: item.installationId,
            },
          });
          await recordAskProviderUsage(pool, {
            workItemId: item.id,
            usage: result.usage,
          });
          if (!(await askReplyPublished())) {
            const operationKey = askReplyOperationKey(item.resourceKey, payload.commentId);
            let selectedTargetKind = payload.replyTarget.kind;
            const posted = await withOperationIntent<{ readonly commentId: number }>({
              client: pool,
              workItemId: item.id,
              operationKey,
              mutationKind: "github.ask_reply",
              leaseEpoch: env.leaseEpoch,
              detail: {
                step: "ask_reply",
                resourceKey: item.resourceKey,
                reviewLens: ASK_PUBLISH_LENS,
                replyTargetKind: payload.replyTarget.kind,
              },
              recover: async () => {
                const bot = await getAppBotIdentity(cfg);
                const recovered = await findAskReplyOnAnyTarget({
                  prSurface,
                  item,
                  botLogin: bot.login,
                  operationKey,
                  operationInstance: item.id,
                });
                return recovered == null
                  ? { kind: "absent" as const }
                  : {
                      kind: "reconciled" as const,
                      value: { commentId: recovered.commentId },
                      detail: { replyTargetKind: recovered.targetKind },
                    };
              },
              isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
              reconcileDetail: () => ({ replyTargetKind: selectedTargetKind }),
              mutate: async () => {
                const published = await publishAskAnswer(
                  cfg,
                  prSurface,
                  item,
                  result.answer,
                  operationKey,
                  true,
                );
                selectedTargetKind = published.targetKind;
                return { commentId: published.commentId };
              },
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
                  replyTargetKind: selectedTargetKind,
                  commentId: posted.commentId,
                },
                leaseEpoch: env.leaseEpoch,
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
              return { kind: "completed", degraded: true };
            }
          } else {
            answerDelivered = true;
          }
          return { kind: "completed" };
        },
      );
    },
    onTerminalFailure: async (item, prSurface, error) => {
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
      if (!prSurface) return;
      // Durable publish_records survive process death; answerDelivered does not.
      if (
        await hasCompletedPublishStep(
          pool,
          item.id,
          item.resourceKey,
          ASK_PUBLISH_LENS,
          "ask_reply",
        )
      ) {
        return;
      }
      if (answerDelivered) return;
      const payload = item.payload;
      await publishAskAnswer(
        cfg,
        prSurface,
        item,
        formatAskReply({
          question: payload.question,
          answer: "PR Agent could not complete this ask after retries. Please try again later.",
          replyTarget: payload.replyTarget,
        }),
        askReplyOperationKey(item.resourceKey, item.payload.commentId),
        true,
      );
    },
  });
}
