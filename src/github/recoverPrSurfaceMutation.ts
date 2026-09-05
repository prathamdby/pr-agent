import type { OperationIntentRow } from "../agentWork/operationIntentRepository.js";
import type { OperationIntentRecovery } from "../agentWork/withOperationIntent.js";
import { isRecord } from "../util/typeGuards.js";
import { findCommentIdByMarker } from "./prSurfaceHelpers.js";
import type { PrSurface, PrSurfaceMutationMethods } from "./prSurfaceTypes.js";

export const PR_SURFACE_MUTATION_METHODS = {
  setAcknowledgementReaction: true,
  replyAt: true,
  upsertProgressComment: true,
  editComment: true,
  setReviewCommitStatus: true,
  publishThreadBatch: true,
  resolveInlineReviewThread: true,
  setLabels: true,
  startReviewCheck: true,
  finishReviewCheck: true,
  editReviewComment: true,
  publishDescription: true,
} satisfies Record<keyof PrSurfaceMutationMethods, true>;

const OPERATION_INTENT_MARKER_RE = /<!-- pr-agent:operation-intent [a-f0-9]{24} -->/;

export function isPrSurfaceMutationMethod(
  property: unknown,
): property is keyof PrSurfaceMutationMethods {
  return typeof property === "string" && property in PR_SURFACE_MUTATION_METHODS;
}

function firstOperationIntentMarker(text: string): string | undefined {
  return OPERATION_INTENT_MARKER_RE.exec(text)?.[0];
}

function detailString(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === "string" ? value : undefined;
}

function detailNumber(detail: Record<string, unknown>, key: string): number | undefined {
  const value = detail[key];
  return typeof value === "number" ? value : undefined;
}

function replyTargetKind(value: unknown): "prConversation" | "inlineReviewThread" | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "prConversation" || value.kind === "inlineReviewThread") {
    return value.kind;
  }
  return undefined;
}

/**
 * Persist enough identity for later GitHub lookup. Methods that cannot prove
 * this attempt landed (reactions, labels, commit status, finishing a check)
 * store nothing extra and stay fail-closed.
 */
export function extractPrSurfaceRecoverDetail(
  method: keyof PrSurfaceMutationMethods,
  args: readonly unknown[],
): Record<string, unknown> {
  switch (method) {
    case "replyAt": {
      const target = args[0];
      const body = typeof args[1] === "string" ? args[1] : "";
      const marker = firstOperationIntentMarker(body);
      const kind = replyTargetKind(target);
      return {
        ...(kind != null ? { replyTargetKind: kind } : {}),
        ...(kind === "inlineReviewThread" &&
        isRecord(target) &&
        typeof target.inReplyToCommentId === "number"
          ? { inReplyToId: target.inReplyToCommentId }
          : {}),
        ...(marker != null ? { operationMarker: marker } : {}),
      };
    }
    case "upsertProgressComment": {
      const body = typeof args[0] === "string" ? args[0] : "";
      const sentinel = typeof args[1] === "string" ? args[1] : undefined;
      const marker = firstOperationIntentMarker(body);
      return {
        ...(sentinel != null ? { sentinel } : {}),
        ...(marker != null ? { operationMarker: marker } : {}),
      };
    }
    case "editComment":
    case "editReviewComment": {
      const commentId = typeof args[0] === "number" ? args[0] : undefined;
      const body = typeof args[1] === "string" ? args[1] : "";
      const marker = firstOperationIntentMarker(body);
      return {
        ...(commentId != null ? { commentId } : {}),
        ...(marker != null ? { operationMarker: marker } : {}),
      };
    }
    case "publishThreadBatch": {
      const review = args[0];
      if (!isRecord(review) || typeof review.body !== "string") return {};
      const marker = firstOperationIntentMarker(review.body);
      return {
        ...(typeof review.commitId === "string" ? { commitId: review.commitId } : {}),
        ...(marker != null ? { operationMarker: marker } : {}),
      };
    }
    case "publishDescription": {
      const marker = typeof args[2] === "string" ? args[2] : undefined;
      return marker != null ? { operationMarker: marker } : {};
    }
    case "startReviewCheck": {
      const headSha = typeof args[0] === "string" ? args[0] : undefined;
      const externalId = typeof args[1] === "string" ? args[1] : undefined;
      return {
        ...(headSha != null ? { headSha } : {}),
        ...(externalId != null ? { externalId } : {}),
      };
    }
    case "resolveInlineReviewThread": {
      const threadId = typeof args[0] === "string" ? args[0] : undefined;
      return threadId != null ? { threadId } : {};
    }
    case "setAcknowledgementReaction":
    case "setReviewCommitStatus":
    case "setLabels":
    case "finishReviewCheck":
      return {};
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

async function recoverReplyAt(
  surface: PrSurface,
  detail: Record<string, unknown>,
): Promise<OperationIntentRecovery<{ readonly commentId: number }>> {
  const marker = detailString(detail, "operationMarker");
  if (marker == null) return { kind: "absent" };
  const botLogin = await surface.getBotLogin?.();
  if (botLogin == null) return { kind: "absent" };

  const kind = detailString(detail, "replyTargetKind");
  if (kind === "inlineReviewThread") {
    const comments = await surface.listInlineReviewComments();
    const inReplyToId = detailNumber(detail, "inReplyToId");
    const commentId = findCommentIdByMarker(comments, marker, (comment) => {
      if (comment.authorLogin !== botLogin) return false;
      return inReplyToId == null || comment.inReplyToId === inReplyToId;
    });
    return commentId == null ? { kind: "absent" } : { kind: "reconciled", value: { commentId } };
  }

  const comments = await surface.listConversationComments();
  const commentId = findCommentIdByMarker(
    comments,
    marker,
    (comment) => comment.authorLogin === botLogin,
  );
  return commentId == null ? { kind: "absent" } : { kind: "reconciled", value: { commentId } };
}

async function recoverProgressComment(
  surface: PrSurface,
  detail: Record<string, unknown>,
): Promise<OperationIntentRecovery<{ readonly id: number; readonly updated: boolean }>> {
  const sentinel = detailString(detail, "sentinel");
  if (sentinel == null) return { kind: "absent" };
  const found = await surface.findProgressComment(sentinel);
  if (found == null) return { kind: "absent" };
  const marker = detailString(detail, "operationMarker");
  if (marker != null && found.body?.includes(marker) !== true) return { kind: "absent" };
  return { kind: "reconciled", value: { id: found.id, updated: true } };
}

async function recoverMarkedComment(
  surface: PrSurface,
  detail: Record<string, unknown>,
  source: "conversation" | "inline",
): Promise<OperationIntentRecovery<unknown>> {
  const marker = detailString(detail, "operationMarker");
  if (marker == null) return { kind: "absent" };
  const botLogin = await surface.getBotLogin?.();
  if (botLogin == null) return { kind: "absent" };
  const comments =
    source === "inline"
      ? await surface.listInlineReviewComments()
      : await surface.listConversationComments();
  const commentId = detailNumber(detail, "commentId");
  const foundId = findCommentIdByMarker(comments, marker, (comment) => {
    if (comment.authorLogin !== botLogin) return false;
    return commentId == null || comment.id === commentId;
  });
  if (foundId == null) return { kind: "absent" };
  return source === "inline"
    ? { kind: "reconciled", value: true }
    : { kind: "reconciled", value: undefined };
}

/**
 * Look up the GitHub side effect for a leased PR-surface mutation. Absence is
 * not permission to remutate. Reactions, labels, commit statuses, and finishing
 * a check run cannot prove this attempt landed, so they stay fail-closed.
 */
export async function recoverPrSurfaceMutation<T>(
  surface: PrSurface,
  intent: OperationIntentRow,
): Promise<OperationIntentRecovery<T>> {
  const method = intent.detail.surfaceMethod;
  if (!isPrSurfaceMutationMethod(method)) return { kind: "absent" };

  let recovery: OperationIntentRecovery<unknown>;
  switch (method) {
    case "replyAt":
      recovery = await recoverReplyAt(surface, intent.detail);
      break;
    case "upsertProgressComment":
      recovery = await recoverProgressComment(surface, intent.detail);
      break;
    case "editComment":
      recovery = await recoverMarkedComment(surface, intent.detail, "conversation");
      break;
    case "editReviewComment":
      recovery = await recoverMarkedComment(surface, intent.detail, "inline");
      break;
    case "publishThreadBatch": {
      const marker = detailString(intent.detail, "operationMarker");
      if (marker == null) {
        recovery = { kind: "absent" };
        break;
      }
      const found = await surface.findPublishedThreadBatch?.(
        marker,
        detailString(intent.detail, "commitId"),
      );
      recovery = found == null ? { kind: "absent" } : { kind: "reconciled", value: found };
      break;
    }
    case "publishDescription": {
      const marker = detailString(intent.detail, "operationMarker");
      if (marker == null) {
        recovery = { kind: "absent" };
        break;
      }
      const body = await surface.getPullRequestBody();
      recovery =
        body != null && body.includes(marker)
          ? {
              kind: "reconciled",
              value: {
                prNumber: surface.prNumber,
                titleUpdated: false,
                bodyUpdated: true,
              },
            }
          : { kind: "absent" };
      break;
    }
    case "startReviewCheck": {
      const headSha = detailString(intent.detail, "headSha");
      const externalId = detailString(intent.detail, "externalId");
      if (headSha == null || externalId == null) {
        recovery = { kind: "absent" };
        break;
      }
      const found = await surface.findReviewCheck?.(headSha, externalId);
      recovery = found == null ? { kind: "absent" } : { kind: "reconciled", value: found };
      break;
    }
    case "resolveInlineReviewThread": {
      const threadId = detailString(intent.detail, "threadId");
      if (threadId == null) {
        recovery = { kind: "absent" };
        break;
      }
      const threads = await surface.listInlineReviewThreads();
      const resolved = [...threads.byRootCommentId.values()].some(
        (thread) => thread.threadNodeId === threadId && thread.isResolved,
      );
      recovery = resolved ? { kind: "reconciled", value: undefined } : { kind: "absent" };
      break;
    }
    case "setAcknowledgementReaction":
    case "setReviewCommitStatus":
    case "setLabels":
    case "finishReviewCheck":
      recovery = { kind: "absent" };
      break;
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
  return recovery as OperationIntentRecovery<T>;
}
