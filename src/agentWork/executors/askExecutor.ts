import * as v from "valibot";
import type { BotIdentity } from "../../github/appAuth.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import { runAskRun } from "../../agent/ask/askRun.ts";
import { loadPullRequestDiscussion } from "../../agent/discussion/pullRequestDiscussion.ts";
import { formatAskReply, sanitizeAskAnswerText } from "../../agent/ask/formatAskReply.ts";
import {
  askReplyBodyWithOperationMarker,
  askReplyCommentIdFromIntentResult,
  findExistingAskReplyComment,
} from "../../agent/ask/recoverAskReply.ts";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.ts";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.ts";
import { logWarn } from "../../evlog.ts";
import { ASK_PUBLISH_LENS } from "../../settings/index.ts";
import {
  askFailureReplyOperationKey,
  askReplyOperationKey,
  intentResult,
  type FeaturePublication,
} from "../../state/featurePublication.ts";
import { createAskExecutionId, recordAskProviderUsage } from "../../state/askQuotas.ts";
import type { AskWorkItem } from "../types.ts";
import type {
  FeatureExecutionResult,
  FeatureWorkDependencies,
  FeatureWorkExecution,
} from "./featureExecution.ts";
import { errorMessage } from "../../errors/errorMessage.ts";

type ReplyTargetKind = AskWorkItem["payload"]["replyTarget"]["kind"];

const askReplyResultSchema = v.object({
  commentId: v.number(),
  replyTargetKind: v.optional(v.picklist(["inlineReviewThread", "prConversation"])),
});

function decodeAskReplyResult(value: unknown) {
  return ((pinnedReturn: v.InferOutput<typeof askReplyResultSchema>) => pinnedReturn)(
    v.parse(askReplyResultSchema, value),
  );
}

function replyTargetKindFromIntentResult(value: unknown, fallback: ReplyTargetKind) {
  return ((pinnedReturn: ReplyTargetKind) => pinnedReturn)(
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
  readonly publication: FeaturePublication;
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
}) {
  const { publication, prSurface, item } = params;
  const operationKey = askReplyOperationKey(item.resourceKey, item.payload.commentId);
  const intent = publication.intent(operationKey);
  const stored = intent?.state === "reconciled" ? intentResult(intent) : undefined;
  const stashed = askReplyCommentIdFromIntentResult(stored);
  if (stashed != null) {
    return ((pinnedReturn: AskReplyRecovery | Promise<AskReplyRecovery>) => pinnedReturn)({
      kind: "recovered",
      commentId: stashed,
      targetKind: replyTargetKindFromIntentResult(
        v.is(v.object({ replyTargetKind: v.unknown() }), stored)
          ? stored.replyTargetKind
          : undefined,
        item.payload.replyTarget.kind,
      ),
    });
  }

  if (
    intent == null ||
    intent.state === "reconciled" ||
    intent.state === "mutation_failed" ||
    intent.state === "outcome_unknown_terminal"
  ) {
    return ((pinnedReturn: AskReplyRecovery | Promise<AskReplyRecovery>) => pinnedReturn)(
      intent?.state === "outcome_unknown_terminal" ? { kind: "outcome_unknown" } : null,
    );
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
      intent.state === "reserved" ? null : { kind: "outcome_unknown" },
    );
  }
  return ((pinnedReturn: AskReplyRecovery | Promise<AskReplyRecovery>) => pinnedReturn)({
    kind: "recovered",
    commentId: recovered.commentId,
    targetKind: recovered.targetKind ?? item.payload.replyTarget.kind,
  });
}

type AskFailureReplyDecision = "skip" | "publish";

async function decideAskFailureReply(params: {
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly publication: FeaturePublication;
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
}) {
  if (params.publication.completed("ask_reply")) {
    return ((pinnedReturn: AskFailureReplyDecision | Promise<AskFailureReplyDecision>) =>
      pinnedReturn)("skip");
  }
  const recovered = await recoverDeliveredAskReplyCommentId(params);
  return ((pinnedReturn: AskFailureReplyDecision | Promise<AskFailureReplyDecision>) =>
    pinnedReturn)(recovered?.kind === "recovered" ? "skip" : "publish");
}

function recordAskReply(
  publication: FeaturePublication,
  item: AskWorkItem,
  detail: { readonly replyTargetKind: ReplyTargetKind; readonly commentId: number },
) {
  try {
    publication.record({ lens: ASK_PUBLISH_LENS, step: "ask_reply", detail });
    return ((pinnedReturn: "ok" | "degraded") => pinnedReturn)("ok");
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
    return ((pinnedReturn: "ok" | "degraded") => pinnedReturn)("degraded");
  }
}

async function finalizeAskReplyPublish(params: {
  readonly publication: FeaturePublication;
  readonly item: AskWorkItem;
  readonly commentId: number;
  readonly targetKind: ReplyTargetKind;
}) {
  const { publication, item, commentId, targetKind } = params;
  const value = { commentId, replyTargetKind: targetKind };
  await publication.once({
    decodeResult: decodeAskReplyResult,
    resourceTarget: `ask_reply:${item.payload.commentId}`,
    operationKey: askReplyOperationKey(item.resourceKey, item.payload.commentId),
    mutationKind: "github.ask_reply",
    identity: {
      step: "ask_reply",
      resourceKey: item.resourceKey,
      reviewLens: ASK_PUBLISH_LENS,
      replyTargetKind: targetKind,
    },
    recover: async () => ({ found: true, value }),
    mutate: async () => value,
  });
  return ((pinnedReturn: "ok" | "degraded") => pinnedReturn)(
    recordAskReply(publication, item, value),
  );
}

async function publishNewAskReply(params: {
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly publication: FeaturePublication;
  readonly prSurface: PrSurface;
  readonly item: AskWorkItem;
  readonly answer: Parameters<typeof publishAskAnswer>[3];
}) {
  const { getBotIdentity, publication, prSurface, item, answer } = params;
  const { payload } = item;
  const operationKey = askReplyOperationKey(item.resourceKey, payload.commentId);

  const posted = await publication.once({
    decodeResult: decodeAskReplyResult,
    resourceTarget: `ask_reply:${payload.commentId}`,
    operationKey,
    mutationKind: "github.ask_reply",
    identity: {
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
        ? { found: false }
        : {
            found: true,
            value: { commentId: recovered.commentId, replyTargetKind: recovered.targetKind },
          };
    },
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    mutate: async () => {
      const published = await publishAskAnswer(
        getBotIdentity,
        prSurface,
        item,
        answer,
        operationKey,
        true,
      );
      return { commentId: published.commentId, replyTargetKind: published.targetKind };
    },
  });
  const status = recordAskReply(publication, item, {
    replyTargetKind: posted.replyTargetKind ?? payload.replyTarget.kind,
    commentId: posted.commentId,
  });
  if (status === "degraded") {
    return ((pinnedReturn: FeatureExecutionResult) => pinnedReturn)({
      kind: "completed",
      degradation: ["publish_record_failed"] satisfies readonly AskDegradationReason[],
      completion: {
        kind: "ask",
        outcome: "degraded",
        replyTargetKind: payload.replyTarget.kind,
        durableDegradation: "publish_record_failed",
      },
    });
  }
  return ((pinnedReturn: FeatureExecutionResult) => pinnedReturn)({
    kind: "completed",
    completion: {
      kind: "ask",
      outcome: "published",
      replyTargetKind: payload.replyTarget.kind,
    },
  });
}

export function createAskFeatureExecution({ botIdentity }: FeatureWorkDependencies) {
  const getBotIdentity = botIdentity;
  return ((pinnedReturn: FeatureWorkExecution<"ask">) => pinnedReturn)({
    execute: async (item, env) => {
      const { prSurface, publication } = env;
      const headSha = env.headSha;
      const payload = item.payload;
      if (publication.completed("ask_reply")) {
        return { kind: "completed" };
      }

      const recoveredReply = await recoverDeliveredAskReplyCommentId({
        getBotIdentity,
        publication,
        prSurface,
        item,
      });
      if (recoveredReply?.kind === "recovered") {
        const status = await finalizeAskReplyPublish({
          publication,
          item,
          commentId: recoveredReply.commentId,
          targetKind: recoveredReply.targetKind,
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

      return env.withRepositoryView(
        {
          repositorySizeKb: payload.repositorySizeKb,
        },
        async (repositoryView) => {
          const discussion = await loadPullRequestDiscussion(prSurface);
          const executionId = createAskExecutionId();
          const result = await runAskRun({
            cfg: env.cfg,
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
            createSession: env.createSession,
            db: env.db,
            installationId: item.installationId,
            signal: env.signal,
          });
          recordAskProviderUsage(env.db, {
            workItemId: item.id,
            executionId,
            ...(result.usage?.totalTokens != null ? { totalTokens: result.usage.totalTokens } : {}),
          });
          if (publication.completed("ask_reply")) return { kind: "completed" };
          return publishNewAskReply({
            getBotIdentity,
            publication,
            prSurface,
            item,
            answer: result.answer,
          });
        },
      );
    },
    onTerminalFailure: async (item, prSurface, env) => {
      if (!prSurface) return;
      const { publication } = env;
      if (
        (await decideAskFailureReply({
          getBotIdentity,
          publication,
          prSurface,
          item,
        })) === "skip"
      )
        return;
      const payload = item.payload;
      const operationKey = askFailureReplyOperationKey(item.resourceKey, item.payload.commentId);
      await publication.once({
        decodeResult: decodeAskReplyResult,
        resourceTarget: `ask_failure_reply:${payload.commentId}`,
        operationKey,
        mutationKind: "github.ask_failure_reply",
        identity: {
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
            ? { found: false }
            : {
                found: true,
                value: { commentId: recovered.commentId, replyTargetKind: recovered.targetKind },
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
          return { commentId: published.commentId, replyTargetKind: published.targetKind };
        },
      });
    },
  });
}
