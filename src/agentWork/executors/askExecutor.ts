import { decodePostedReply } from "../../github/prSurfaceResults.ts";
import type { BotIdentity } from "../../github/appAuth.ts";
import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.ts";
import { productionInstallationSurface } from "../installationSurface.ts";
import { createPublishContext } from "../publishOnce.ts";
import type { Pool } from "pg";

import type { PrSurface } from "../../github/prSurface.ts";
import { runAskRun } from "../../agent/ask/askRun.ts";
import { loadPullRequestDiscussion } from "../../agent/discussion/pullRequestDiscussion.ts";
import { formatAskReply, sanitizeAskAnswerText } from "../../agent/ask/formatAskReply.ts";
import {
  askReplyBodyWithOperationMarker,
  askReplyCommentIdFromIntentDetail,
  findExistingAskReplyComment,
} from "../../agent/ask/recoverAskReply.ts";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.ts";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.ts";
import { logWarn } from "../../evlog.ts";
import { ASK_PUBLISH_LENS } from "../../settings/index.ts";
import { getOperationIntent } from "../operationIntentRepository.ts";
import { askFailureReplyOperationKey, askReplyOperationKey, publishOnce } from "../publishOnce.ts";
import { fenceForEpoch } from "../writeFence.ts";
import { createAskExecutionId, recordAskProviderUsage } from "../askQuota.ts";
import type { AskWorkItem } from "../types.ts";
import type { DurableExecutionResult } from "../durableJob.ts";
import { errorMessage } from "../../errors/errorMessage.ts";

function replyTargetKindFromIntentDetail(
  value: unknown,
  fallback: AskWorkItem["payload"]["replyTarget"]["kind"],
) {
  return ((pinnedReturn: AskWorkItem["payload"]["replyTarget"]["kind"]) => pinnedReturn)(
    value === "inlineReviewThread" || value === "prConversation" ? value : fallback,
  );
}

function askReplyLookupKeys(resourceKey: string, operationKey: string) {
  const scopedKey = askReplyOperationKey(resourceKey);
  if (operationKey === scopedKey)
    return ((pinnedReturn: readonly string[]) => pinnedReturn)([operationKey]);
  if (operationKey.startsWith(`ask:reply:${resourceKey}`)) {
    return ((pinnedReturn: readonly string[]) => pinnedReturn)([operationKey, scopedKey]);
  }
  return ((pinnedReturn: readonly string[]) => pinnedReturn)([operationKey]);
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
) {
  const body = alreadySanitized ? answer : sanitizeAskAnswerText(answer);
  const replyTarget = item.payload.replyTarget;
  const markedBody = askReplyBodyWithOperationMarker(body, operationKey, item.id);
  try {
    const posted = await prSurface.replyAt(replyTarget, markedBody);
    return ((
      pinnedReturn:
        | { commentId: number; targetKind: AskWorkItem["payload"]["replyTarget"]["kind"] }
        | Promise<{ commentId: number; targetKind: AskWorkItem["payload"]["replyTarget"]["kind"] }>,
    ) => pinnedReturn)({ ...posted, targetKind: replyTarget.kind });
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
      return ((
        pinnedReturn:
          | { commentId: number; targetKind: AskWorkItem["payload"]["replyTarget"]["kind"] }
          | Promise<{
              commentId: number;
              targetKind: AskWorkItem["payload"]["replyTarget"]["kind"];
            }>,
      ) => pinnedReturn)({ commentId: recovered.commentId, targetKind: recovered.targetKind });
    }
    const failure = classifyFailure(e, { phase: "publish", toolName: "ask_inline_reply" });
    logWarn("ask_inline_reply_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: replyTarget.prNumber,
      inReplyToCommentId: replyTarget.inReplyToCommentId,
      message: errorMessage(e),
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
    return ((
      pinnedReturn:
        | { commentId: number; targetKind: AskWorkItem["payload"]["replyTarget"]["kind"] }
        | Promise<{ commentId: number; targetKind: AskWorkItem["payload"]["replyTarget"]["kind"] }>,
    ) => pinnedReturn)({ ...fallback, targetKind: "prConversation" });
  }
}

type AskDegradationReason =
  | "reply_recovery_degraded"
  | "reply_outcome_unknown"
  | "publish_record_failed";

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
}) {
  const { pool, prSurface, item } = params;
  const operationKey = askReplyOperationKey(item.resourceKey, item.payload.commentId);
  const intent = await getOperationIntent(pool, item.id, operationKey);
  const stashed = askReplyCommentIdFromIntentDetail(intent?.detail);
  if (stashed != null) {
    return ((pinnedReturn: AskReplyRecovery | Promise<AskReplyRecovery>) => pinnedReturn)({
      kind: "recovered",
      commentId: stashed,
      targetKind: replyTargetKindFromIntentDetail(
        intent?.detail.replyTargetKind,
        item.payload.replyTarget.kind,
      ),
    });
  }

  if (intent == null || (intent.status !== "pending" && intent.status !== "outcome_unknown")) {
    return ((pinnedReturn: AskReplyRecovery | Promise<AskReplyRecovery>) => pinnedReturn)(null);
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
    return ((pinnedReturn: AskReplyRecovery | Promise<AskReplyRecovery>) => pinnedReturn)(
      intent.status === "outcome_unknown" || intent.detail.__mutating === true
        ? { kind: "outcome_unknown" }
        : null,
    );
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
  return ((pinnedReturn: AskReplyRecovery | Promise<AskReplyRecovery>) => pinnedReturn)({
    kind: "recovered",
    commentId: recovered.commentId,
    targetKind: recovered.targetKind ?? item.payload.replyTarget.kind,
  });
}

type AskFailureReplyDecision = "skip" | "publish";

async function decideAskFailureReply(params: {
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
}) {
  const { pool, prSurface, item } = params;
  if (
    await createPublishContext(pool, {
      workItemId: item.id,
      resourceKey: item.resourceKey,
      reviewLens: ASK_PUBLISH_LENS,
    }).completed("ask_reply")
  ) {
    return ((pinnedReturn: AskFailureReplyDecision | Promise<AskFailureReplyDecision>) =>
      pinnedReturn)("skip");
  }
  const recovered = await recoverDeliveredAskReplyCommentId({
    getBotIdentity: params.getBotIdentity,
    pool,
    prSurface,
    item,
  });
  return ((pinnedReturn: AskFailureReplyDecision | Promise<AskFailureReplyDecision>) =>
    pinnedReturn)(recovered?.kind === "recovered" ? "skip" : "publish");
}

async function finalizeAskReplyPublish(params: {
  readonly pool: Pool;
  readonly item: AskWorkItem;
  readonly commentId: number;
  readonly targetKind: AskWorkItem["payload"]["replyTarget"]["kind"];
  readonly leaseEpoch: number | null;
}) {
  const { pool, item, commentId, targetKind, leaseEpoch } = params;
  await publishOnce({
    client: pool,
    workItemId: item.id,
    operationKey: askReplyOperationKey(item.resourceKey, item.payload.commentId),
    mutationKind: "github.ask_reply",
    leaseEpoch,
    fence: fenceForEpoch(leaseEpoch),
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
    return ((pinnedReturn: ("ok" | "degraded") | Promise<"ok" | "degraded">) => pinnedReturn)("ok");
  } catch (e) {
    const failure = classifyFailure(e, { phase: "publish" });
    logWarn("ask_publish_record_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      workItemId: item.id,
      message: errorMessage(e),
      ...classifiedFailureLogFields(failure),
    });
    return ((pinnedReturn: ("ok" | "degraded") | Promise<"ok" | "degraded">) => pinnedReturn)(
      "degraded",
    );
  }
}

async function publishNewAskReply(params: {
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
  readonly answer: Parameters<typeof publishAskAnswer>[3];
  readonly leaseEpoch: number | null;
}) {
  const { getBotIdentity, pool, prSurface, item, answer, leaseEpoch } = params;
  const { payload } = item;
  const operationKey = askReplyOperationKey(item.resourceKey, payload.commentId);
  let selectedTargetKind = payload.replyTarget.kind;
  const publishAnswer = async () => {
    const published = await publishAskAnswer(
      getBotIdentity,
      prSurface,
      item,
      answer,
      operationKey,
      true,
    );
    selectedTargetKind = published.targetKind;
    return { commentId: published.commentId };
  };

  const posted = await publishOnce<{ readonly commentId: number }>({
    decodeResult: decodePostedReply,
    fence: fenceForEpoch(leaseEpoch),
    client: pool,
    workItemId: item.id,
    operationKey,
    mutationKind: "github.ask_reply",
    leaseEpoch,
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
    mutate: publishAnswer,
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
      leaseEpoch,
      reviewLens: "ask",
    }).record();
  } catch (e) {
    const failure = classifyFailure(e, { phase: "publish" });
    logWarn("ask_publish_record_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      workItemId: item.id,
      message: errorMessage(e),
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
    } satisfies DurableExecutionResult;
  }
  return {
    kind: "completed",
    completion: {
      kind: "ask",
      outcome: "published",
      replyTargetKind: payload.replyTarget.kind,
    },
  } satisfies DurableExecutionResult;
}

export function createAskWorkExecution({
  cfg,
  pool,
  installationSurface = productionInstallationSurface,
}: WorkExecutionDependencies) {
  const getBotIdentity = () => installationSurface.botIdentity(cfg);
  return ((pinnedReturn: WorkExecution<"ask">) => pinnedReturn)({
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
          const discussion = await loadPullRequestDiscussion(prSurface);
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
            discussion,
            discussionTrigger:
              payload.replyTarget.kind === "inlineReviewThread"
                ? { kind: "inline", commentId: payload.replyTarget.inReplyToCommentId }
                : { kind: "conversation", commentId: payload.commentId },
            cwd: repositoryView.agentCwd,
            workspace: repositoryView.workspace,
            sessionContext: env.durability,
            pool,
            signal: env.signal,
          });
          await recordAskProviderUsage(pool, {
            workItemId: item.id,
            executionId,
            usage: result.usage,
          });
          if (await askReplyPublished()) return { kind: "completed" };
          return publishNewAskReply({
            getBotIdentity,
            pool,
            prSurface,
            item,
            answer: result.answer,
            leaseEpoch: env.leaseEpoch,
          });
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
        fence: fenceForEpoch(null),
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
  });
}
