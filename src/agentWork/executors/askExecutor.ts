import type { BotIdentity } from "../../github/appAuth.js";
import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.js";
import { productionInstallationSurface } from "../installationSurface.js";
import { createPublishContext } from "../publishOnce.js";
import type { Pool } from "pg";

import type { PrSurface } from "../../github/prSurface.js";
import { runAskRun } from "../../agent/ask/askRun.js";
import { loadAskThreadTranscript } from "../../agent/ask/askThreadContext.js";
import { formatAskReply, sanitizeAskAnswerText } from "../../agent/ask/formatAskReply.js";
import {
  askReplyBodyWithOperationMarker,
  askReplyCommentIdFromIntentDetail,
  findExistingAskReplyComment,
} from "../../agent/ask/recoverAskReply.js";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import { logWarn } from "../../evlog.js";
import { ASK_PUBLISH_LENS } from "../../settings/index.js";
import { getOperationIntent } from "../operationIntentRepository.js";
import { askFailureReplyOperationKey, askReplyOperationKey, publishOnce } from "../publishOnce.js";
import { createAskExecutionId, recordAskProviderUsage } from "../askQuota.js";
import type { AskWorkItem } from "../types.js";
import { waitForReadySnapshot } from "../../codeIndex/repository.js";

function replyTargetKindFromIntentDetail(
  value: unknown,
  fallback: AskWorkItem["payload"]["replyTarget"]["kind"],
): AskWorkItem["payload"]["replyTarget"]["kind"] {
  return value === "inlineReviewThread" || value === "prConversation" ? value : fallback;
}

function askReplyLookupKeys(resourceKey: string, operationKey: string): readonly string[] {
  const scopedKey = askReplyOperationKey(resourceKey);
  if (operationKey === scopedKey) return [operationKey];
  // Failure-reply keys must not adopt a legacy ask:reply comment as already published.
  if (operationKey.startsWith(`ask:reply:${resourceKey}`)) {
    return [operationKey, scopedKey];
  }
  return [operationKey];
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
  getBotIdentity: () => Promise<BotIdentity>,
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
    const bot = await getBotIdentity();
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

/** Reasons an ask run completed with reduced output. */
type AskDegradationReason =
  | "reply_recovery_degraded"
  | "reply_outcome_unknown"
  | "publish_record_failed";

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
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
}): Promise<AskReplyRecovery> {
  const { pool, prSurface, item } = params;
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

  const bot = await params.getBotIdentity();
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

  await createPublishContext(pool, {
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens: ASK_PUBLISH_LENS,
    step: "ask_reply",
  }).adopt({
    operationKey,
    mutationKind: "github.ask_reply",
    result: { commentId: recovered.commentId },
    detail: { replyTargetKind: recovered.targetKind ?? item.payload.replyTarget.kind },
    hasUsableResult: (detail) => askReplyCommentIdFromIntentDetail(detail) != null,
  });
  return {
    kind: "recovered",
    commentId: recovered.commentId,
    targetKind: recovered.targetKind ?? item.payload.replyTarget.kind,
  };
}

type AskFailureReplyDecision = "skip" | "publish";

/** Confirmed delivery only. An outcome_unknown answer mutation is not delivery. */
async function decideAskFailureReply(params: {
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
}): Promise<AskFailureReplyDecision> {
  const { pool, prSurface, item } = params;
  if (
    await createPublishContext(pool, {
      workItemId: item.id,
      resourceKey: item.resourceKey,
      reviewLens: ASK_PUBLISH_LENS,
    }).completed("ask_reply")
  ) {
    return "skip";
  }
  const recovered = await recoverDeliveredAskReplyCommentId({
    getBotIdentity: params.getBotIdentity,
    pool,
    prSurface,
    item,
  });
  return recovered?.kind === "recovered" ? "skip" : "publish";
}

async function finalizeAskReplyPublish(params: {
  readonly pool: Pool;
  readonly item: AskWorkItem;
  readonly commentId: number;
  readonly targetKind: AskWorkItem["payload"]["replyTarget"]["kind"];
  readonly leaseEpoch: number | null;
}): Promise<"ok" | "degraded"> {
  const { pool, item, commentId, targetKind, leaseEpoch } = params;
  await publishOnce({
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
    await createPublishContext(pool, {
      workItemId: item.id,
      resourceKey: item.resourceKey,
      step: "ask_reply",
      detail: {
        replyTargetKind: targetKind,
        commentId,
      },
      leaseEpoch,
      reviewLens: "ask",
    }).record();
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
    return "degraded";
  }
}

export function createAskWorkExecution({
  cfg,
  pool,
  installationSurface = productionInstallationSurface,
}: WorkExecutionDependencies): WorkExecution<"ask"> {
  const getBotIdentity = () => installationSurface.botIdentity(cfg);
  return {
    execute: async (item, env) => {
      const { prSurface } = env;
      const headSha = env.headSha;
      const payload = item.payload;
      const askReplyPublished = async () =>
        Boolean(
          await createPublishContext(pool, {
            workItemId: item.id,
            resourceKey: item.resourceKey,
            reviewLens: ASK_PUBLISH_LENS,
          }).completed("ask_reply"),
        );
      if (await askReplyPublished()) {
        return { kind: "completed" };
      }

      const recoveredReply = await recoverDeliveredAskReplyCommentId({
        getBotIdentity,
        pool,
        prSurface,
        item,
      });
      if (recoveredReply?.kind === "recovered") {
        const status = await finalizeAskReplyPublish({
          pool,
          item,
          commentId: recoveredReply.commentId,
          targetKind: recoveredReply.targetKind,
          leaseEpoch: env.leaseEpoch,
        });
        if (status === "degraded") {
          return {
            kind: "completed",
            degradation: ["reply_recovery_degraded"] satisfies readonly AskDegradationReason[],
            completion: {
              kind: "ask",
              outcome: "degraded",
              replyTargetKind: recoveredReply.targetKind,
              durableDegradation: "reply_recovery_degraded",
            },
          };
        }
        return {
          kind: "completed",
          completion: {
            kind: "ask",
            outcome: "published",
            replyTargetKind: recoveredReply.targetKind,
          },
        };
      }
      if (recoveredReply?.kind === "outcome_unknown") {
        // The provider may have accepted the reply, but no exact marker was
        // found. Do not rerun the model or create a fallback reply.
        return {
          kind: "completed",
          degradation: ["reply_outcome_unknown"] satisfies readonly AskDegradationReason[],
          completion: {
            kind: "ask",
            outcome: "degraded",
            replyTargetKind: payload.replyTarget.kind,
            durableDegradation: "reply_outcome_unknown",
          },
        };
      }

      return env.withAdmittedRepositoryView(
        {
          repositorySizeKb: payload.repositorySizeKb,
        },
        async (repositoryView) => {
          const transcript = await loadAskThreadTranscript({
            prSurface,
            replyTarget: payload.replyTarget,
            commentId: payload.commentId,
          });
          const ready =
            cfg.codeIndex.mode === "fts"
              ? await waitForReadySnapshot(
                  pool,
                  {
                    installationId: item.installationId,
                    owner: item.owner,
                    repo: item.repo,
                    headSha,
                  },
                  0,
                )
              : null;
          const executionId = createAskExecutionId();
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
            sessionContext: env.durability,
            pool,
            codeIndexSnapshotId: ready?.id,
            signal: env.signal,
          });
          await recordAskProviderUsage(pool, {
            workItemId: item.id,
            executionId,
            usage: result.usage,
          });
          if (!(await askReplyPublished())) {
            const operationKey = askReplyOperationKey(item.resourceKey, payload.commentId);
            let selectedTargetKind = payload.replyTarget.kind;
            const posted = await publishOnce<{ readonly commentId: number }>({
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
                const bot = await getBotIdentity();
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
                  getBotIdentity,
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
            try {
              await createPublishContext(pool, {
                workItemId: item.id,
                resourceKey: item.resourceKey,
                step: "ask_reply",
                detail: {
                  replyTargetKind: selectedTargetKind,
                  commentId: posted.commentId,
                },
                leaseEpoch: env.leaseEpoch,
                reviewLens: "ask",
              }).record();
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
              return {
                kind: "completed",
                degradation: ["publish_record_failed"] satisfies readonly AskDegradationReason[],
                completion: {
                  kind: "ask",
                  outcome: "degraded",
                  replyTargetKind: payload.replyTarget.kind,
                  durableDegradation: "publish_record_failed",
                },
              };
            }
            return {
              kind: "completed",
              completion: {
                kind: "ask",
                outcome: "published",
                replyTargetKind: payload.replyTarget.kind,
              },
            };
          }
          return { kind: "completed" };
        },
      );
    },
    onTerminalFailure: async (item, prSurface) => {
      if (!prSurface) return;
      if (
        (await decideAskFailureReply({
          getBotIdentity,
          pool,
          prSurface,
          item,
        })) === "skip"
      )
        return;
      const payload = item.payload;
      const operationKey = askFailureReplyOperationKey(item.resourceKey, item.payload.commentId);
      await publishOnce({
        client: pool,
        workItemId: item.id,
        operationKey,
        mutationKind: "github.ask_failure_reply",
        detail: {
          step: "ask_failure_reply",
          resourceKey: item.resourceKey,
          reviewLens: ASK_PUBLISH_LENS,
          replyTargetKind: payload.replyTarget.kind,
        },
        recover: async () => {
          const bot = await getBotIdentity();
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
        mutate: async () => {
          const published = await publishAskAnswer(
            getBotIdentity,
            prSurface,
            item,
            formatAskReply({
              question: payload.question,
              answer: "PR Agent could not complete this ask after retries. Please try again later.",
              replyTarget: payload.replyTarget,
            }),
            operationKey,
            true,
          );
          return { commentId: published.commentId };
        },
      });
    },
  };
}
