import type { TriageScope } from "../../agentWork/types.js";
import type { Pool } from "pg";
import * as v from "valibot";
import type { PrSurface } from "../../github/prSurface.js";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import type { ReviewThreadResolution } from "../../github/reviewThreadResolution.js";
import { redactReviewText } from "../../review/findings/reviewPublicOutput.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import {
  TriagePayloadSchema,
  type TriagePayload,
  type TriageVerdict,
} from "../../review/triageSchema.js";
import {
  TRIAGE_CLOSED_PR_NOTICE,
  TRIAGE_PUBLISH_LENS,
  TRIAGE_STALE_HEAD_NOTICE,
  TRIAGE_SUMMARY_SENTINEL,
  TRIAGE_THREAD_RESOLUTION_NOTICE,
} from "../../settings/index.js";
import { TriageClosedPullRequestError } from "./triageErrors.js";
import { recordPublishStep } from "../../agentWork/repository.js";
import {
  operationIntentMarker,
  triagePushOperationKey,
  triageReportOperationKey,
  triageThreadOperationKey,
  withOperationIntent,
} from "../../agentWork/withOperationIntent.js";
import {
  loadActedThreadIds,
  recordActedThreadIds,
} from "../../agentWork/threadActionCheckpoint.js";
import {
  captureTriageEvent,
  captureTriageFailure,
  type TriageAnalyticsRef,
} from "../../agentWork/triageAnalytics.js";
import { safeRecordThreadFindingHistoryOutcome } from "../../agentWork/findingHistoryRepository.js";
import type { Config } from "../../config.js";
import {
  StaleHeadPushError,
  type WritablePrCheckout,
} from "../../prWorkspace/writablePrCheckout.js";
import { renderTriageReport } from "./triageRender.js";

type PublishTriageParams = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly installationId: number;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkout: WritablePrCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly payload: TriagePayload;
  readonly previouslyResolvedCount: number;
  readonly priorPush?: TriagePriorPush;
  readonly scope?: TriageScope;
  readonly threadRootCommentId?: number;
  readonly findingHistoryCfg?: Pick<Config, "findingHistoryEnabled">;
  readonly leaseEpoch: number | null;
  readonly signal?: AbortSignal;
};

type ReportOnlyParams = Omit<
  PublishTriageParams,
  "checkout" | "resolutionByRootCommentId" | "payload" | "priorPush"
> & {
  readonly body: string;
};

type TriageCommittedDetail = {
  readonly sha: string;
  readonly subject: string;
  readonly diff: string;
};

export type TriagePushOutcome = "not-needed" | "pushed" | "stale" | "closed";

type TriagePriorPush = {
  readonly pushOutcome: TriagePushOutcome;
};

export type StoredTriagePushDetail = TriagePriorPush & {
  readonly pushedHeadSha?: string;
  readonly payload: TriagePayload;
  readonly commits: readonly TriageCommittedDetail[];
};

export type PublishTriageResult = {
  readonly pushOutcome: TriagePushOutcome;
  readonly missingThreadAction: boolean;
};

export function isTriagePushOutcome(value: unknown): value is TriagePushOutcome {
  return value === "not-needed" || value === "pushed" || value === "stale" || value === "closed";
}

function parseStoredCommit(value: unknown): TriageCommittedDetail | null {
  if (typeof value !== "object" || value == null) return null;
  const entry = value as Record<string, unknown>;
  return typeof entry.sha === "string" &&
    typeof entry.subject === "string" &&
    typeof entry.diff === "string"
    ? { sha: entry.sha, subject: entry.subject, diff: entry.diff }
    : null;
}

function inferStoredPushOutcome(
  entry: Record<string, unknown>,
  commits: readonly TriageCommittedDetail[],
): TriagePushOutcome {
  if (isTriagePushOutcome(entry.pushOutcome)) return entry.pushOutcome;
  if (entry.staleHead === true) return "stale";
  return commits.length > 0 ? "pushed" : "not-needed";
}

export function parseStoredTriagePushDetail(detail: unknown): StoredTriagePushDetail | null {
  if (typeof detail !== "object" || detail == null) return null;
  const entry = detail as Record<string, unknown>;
  const payload = v.safeParse(TriagePayloadSchema, entry.payload);
  if (!payload.success || !Array.isArray(entry.commits)) return null;
  const commits = entry.commits.map(parseStoredCommit);
  if (commits.some((commit) => commit == null)) return null;
  const parsedCommits = commits as TriageCommittedDetail[];
  return {
    payload: payload.output,
    commits: parsedCommits,
    pushOutcome: inferStoredPushOutcome(entry, parsedCommits),
    pushedHeadSha: typeof entry.pushedHeadSha === "string" ? entry.pushedHeadSha : undefined,
  };
}

function storedTriagePushRecord(params: {
  readonly outcome: TriagePushOutcome;
  readonly headSha: string;
  readonly committedShas: readonly string[];
  readonly commits: readonly TriageCommittedDetail[];
  readonly payload: TriagePayload;
}): Record<string, unknown> {
  const shared = {
    pushOutcome: params.outcome,
    payload: params.payload,
    commits: params.commits,
    baseHeadSha: params.headSha,
  };
  if (params.outcome === "stale" || params.outcome === "closed") {
    // Preserve attempted SHAs for terminal no-push outcomes; staleHead keeps
    // the stale variant compatible with older workers.
    return {
      ...shared,
      ...(params.outcome === "stale" ? { staleHead: true } : {}),
      attemptedShas: params.committedShas,
    };
  }
  return {
    ...shared,
    pushedShas: params.committedShas,
    pushedHeadSha: params.committedShas.at(-1) ?? params.headSha,
  };
}

function shouldReplyToTriageThread(
  verdict: TriageVerdict,
): verdict is Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }> {
  switch (verdict.verdict) {
    case "fixed":
    case "already-resolved":
      return true;
    case "skipped":
    case "dismissed":
      return false;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function shouldResolveTriageThread(
  verdict: TriageVerdict,
  pushOutcome: TriagePushOutcome,
): boolean {
  switch (verdict.verdict) {
    case "skipped":
      return false;
    case "fixed":
      return pushOutcome === "pushed";
    case "already-resolved":
    case "dismissed":
      return true;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function replyBody(
  verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>,
): string {
  if (verdict.verdict === "fixed") {
    return redactReviewText(
      `**Triage**: Fixed in ${verdict.commitSha.slice(0, 7)} - ${verdict.evidence}`,
    );
  }
  return redactReviewText(`**Triage**: Already resolved - ${verdict.evidence}`);
}

async function findMarkedComment(
  prSurface: PrSurface,
  marker: string,
  rootCommentId?: number,
): Promise<{ readonly id: number } | null> {
  const botLogin = await prSurface.getBotLogin?.();
  if (botLogin == null) return null;
  const comments = await prSurface.listInlineReviewComments();
  const id = findCommentIdByMarker(
    comments,
    marker,
    (comment) =>
      comment.authorLogin === botLogin &&
      (rootCommentId == null || comment.inReplyToId === rootCommentId),
  );
  return id == null ? null : { id };
}

async function findMarkedConversationComment(
  prSurface: PrSurface,
  marker: string,
): Promise<{ readonly id: number } | null> {
  const botLogin = await prSurface.getBotLogin?.();
  if (botLogin == null) return null;
  const comments = await prSurface.listConversationComments();
  const id = findCommentIdByMarker(comments, marker, (comment) => comment.authorLogin === botLogin);
  return id == null ? null : { id };
}

async function replyToThread(
  params: Pick<PublishTriageParams, "prSurface" | "prNumber"> & {
    readonly thread: BotFindingThread;
    readonly verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>;
    readonly operationMarker: string;
  },
): Promise<void> {
  await params.prSurface.replyAt(
    {
      kind: "inlineReviewThread",
      prNumber: params.prNumber,
      inReplyToCommentId: params.thread.rootCommentId,
    },
    `${replyBody(params.verdict)}\n${params.operationMarker}`,
  );
}

async function upsertTriageReport(
  params: Pick<
    PublishTriageParams,
    "prSurface" | "pool" | "workItemId" | "resourceKey" | "leaseEpoch"
  > & {
    readonly body: string;
  },
): Promise<void> {
  const operationKey = triageReportOperationKey(params.resourceKey);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const result = await withOperationIntent<{ readonly id: number; readonly updated: boolean }>({
    client: params.pool,
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    operationKey,
    mutationKind: "github.triage_report",
    detail: {
      step: "triage_report",
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      operationMarker,
    },
    recover: async () => {
      const existing = await findMarkedConversationComment(params.prSurface, operationMarker);
      return existing == null
        ? { kind: "absent" as const }
        : { kind: "reconciled" as const, value: { id: existing.id, updated: false } };
    },
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    mutate: () =>
      params.prSurface.upsertProgressComment(
        `${redactReviewText(params.body)}\n${operationMarker}`,
        TRIAGE_SUMMARY_SENTINEL,
      ),
  });
  await recordPublishStep(params.pool, {
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    resourceKey: params.resourceKey,
    reviewLens: TRIAGE_PUBLISH_LENS,
    step: "triage_report",
    githubId: result.id,
    detail: { updated: result.updated },
  });
}

export async function publishTriageReportOnly(params: ReportOnlyParams): Promise<void> {
  const analytics: TriageAnalyticsRef = {
    installationId: params.installationId,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    workItemId: params.workItemId,
    scope: params.scope,
  };
  try {
    await upsertTriageReport(params);
  } catch (error) {
    captureTriageFailure(analytics, "publish_report_only", error);
    throw error;
  }
}

async function publishTriagePushResult(params: {
  readonly publish: PublishTriageParams;
  readonly analytics: TriageAnalyticsRef;
  readonly committedShas: readonly string[];
  readonly committedDetails: readonly TriageCommittedDetail[];
}): Promise<TriagePushOutcome> {
  const { publish, analytics, committedShas, committedDetails } = params;
  let pushOutcome: TriagePushOutcome = publish.priorPush?.pushOutcome ?? "not-needed";
  if (publish.priorPush) return pushOutcome;
  if (committedShas.length === 0) {
    await recordPublishStep(publish.pool, {
      workItemId: publish.workItemId,
      leaseEpoch: publish.leaseEpoch,
      resourceKey: publish.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_push",
      detail: storedTriagePushRecord({
        outcome: "not-needed",
        headSha: publish.headSha,
        committedShas: [],
        commits: [],
        payload: publish.payload,
      }),
    });
    return "not-needed";
  }
  try {
    const operationKey = triagePushOperationKey(publish.resourceKey);
    await withOperationIntent({
      client: publish.pool,
      workItemId: publish.workItemId,
      leaseEpoch: publish.leaseEpoch,
      signal: publish.signal,
      operationKey,
      mutationKind: "github.triage_push",
      detail: {
        step: "triage_push",
        resourceKey: publish.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
      },
      recover: async () => {
        const pushed = await publish.prSurface.listPushedCommits();
        return committedShas.every((sha) => pushed.some((commit) => commit.sha === sha))
          ? { kind: "reconciled" as const, value: undefined }
          : { kind: "absent" as const };
      },
      isKnownNoAcceptanceError: (error) =>
        error instanceof StaleHeadPushError || isKnownNoAcceptanceMutationError(error),
      mutate: async () => {
        await publish.checkout.push();
      },
    });
    pushOutcome = "pushed";
    await recordPublishStep(publish.pool, {
      workItemId: publish.workItemId,
      leaseEpoch: publish.leaseEpoch,
      resourceKey: publish.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_push",
      detail: storedTriagePushRecord({
        outcome: "pushed",
        headSha: publish.headSha,
        committedShas,
        commits: committedDetails,
        payload: publish.payload,
      }),
    });
  } catch (error) {
    if (error instanceof TriageClosedPullRequestError) {
      pushOutcome = "closed";
      captureTriageEvent(analytics, "triage degraded", {
        step: "publish_push",
        reason: "closed_pull_request",
      });
    } else if (error instanceof StaleHeadPushError) {
      pushOutcome = "stale";
      captureTriageEvent(analytics, "triage degraded", {
        step: "publish_push",
        reason: "stale_head",
      });
    } else {
      captureTriageFailure(analytics, "publish_push", error);
      throw error;
    }
    await recordPublishStep(publish.pool, {
      workItemId: publish.workItemId,
      leaseEpoch: publish.leaseEpoch,
      resourceKey: publish.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_push",
      detail: storedTriagePushRecord({
        outcome: pushOutcome,
        headSha: publish.headSha,
        committedShas,
        commits: committedDetails,
        payload: publish.payload,
      }),
    });
  }
  return pushOutcome;
}

export async function publishTriage(params: PublishTriageParams): Promise<PublishTriageResult> {
  const analytics: TriageAnalyticsRef = {
    installationId: params.installationId,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    workItemId: params.workItemId,
    scope: params.scope,
  };
  const committedShas = params.checkout.listCommittedShas();
  const committedDetails = params.checkout.listCommittedDetails();
  const pushOutcome = await publishTriagePushResult({
    publish: params,
    analytics,
    committedShas,
    committedDetails,
  });
  const missingThreadAction = await publishTriageThreadActions({
    publish: params,
    analytics,
    pushOutcome,
  });
  await publishTriageReportTable({
    publish: params,
    analytics,
    pushOutcome,
    committedDetails,
    missingThreadAction,
  });
  recordTriageFindingHistory(params);
  return { pushOutcome, missingThreadAction };
}

async function publishTriageThreadActions(params: {
  readonly publish: PublishTriageParams;
  readonly analytics: TriageAnalyticsRef;
  readonly pushOutcome: TriagePushOutcome;
}): Promise<boolean> {
  const { publish, analytics, pushOutcome } = params;
  let missingThreadAction = false;
  const actedThreadIds = new Set(
    await loadActedThreadIds(publish.pool, {
      workItemId: publish.workItemId,
      resourceKey: publish.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_thread_actions",
    }),
  );
  const threadById = new Map(publish.inventory.map((thread) => [thread.rootCommentId, thread]));
  for (const verdict of publish.payload.verdicts) {
    if (!shouldResolveTriageThread(verdict, pushOutcome)) continue;
    const thread = threadById.get(verdict.threadRootCommentId);
    const resolution = publish.resolutionByRootCommentId.get(verdict.threadRootCommentId);
    if (!thread || !resolution) {
      missingThreadAction = true;
      captureTriageEvent(analytics, "triage degraded", {
        step: "thread_actions",
        reason: "missing_thread_mapping",
        thread_root_comment_id: verdict.threadRootCommentId,
      });
      continue;
    }
    if (resolution.isResolved) continue;
    if (
      shouldReplyToTriageThread(verdict) &&
      !actedThreadIds.has(verdict.threadRootCommentId) &&
      thread.hasTriageReply !== true
    ) {
      try {
        const operationKey = triageThreadOperationKey(verdict.threadRootCommentId);
        const operationMarker = operationIntentMarker(operationKey, publish.workItemId);
        await withOperationIntent({
          client: publish.pool,
          workItemId: publish.workItemId,
          leaseEpoch: publish.leaseEpoch,
          operationKey,
          mutationKind: "github.triage_thread_reply",
          detail: {
            step: "triage_thread_actions",
            resourceKey: publish.resourceKey,
            reviewLens: TRIAGE_PUBLISH_LENS,
            threadRootCommentId: verdict.threadRootCommentId,
            operationMarker,
          },
          recover: async () => {
            const existing = await findMarkedComment(
              publish.prSurface,
              operationMarker,
              verdict.threadRootCommentId,
            );
            return existing == null
              ? { kind: "absent" as const }
              : { kind: "reconciled" as const, value: undefined };
          },
          isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
          mutate: () =>
            replyToThread({
              ...publish,
              thread,
              verdict,
              operationMarker,
            }),
        });
      } catch (error) {
        captureTriageFailure(analytics, "thread_reply", error, {
          thread_root_comment_id: verdict.threadRootCommentId,
        });
        throw error;
      }
      actedThreadIds.add(verdict.threadRootCommentId);
      await recordActedThreadIds(publish.pool, {
        workItemId: publish.workItemId,
        resourceKey: publish.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_thread_actions",
        actedThreadIds: [...actedThreadIds],
        leaseEpoch: publish.leaseEpoch,
      });
    }
    try {
      const operationKey = `${triageThreadOperationKey(verdict.threadRootCommentId)}:resolve`;
      await withOperationIntent({
        client: publish.pool,
        workItemId: publish.workItemId,
        leaseEpoch: publish.leaseEpoch,
        operationKey,
        mutationKind: "github.triage_thread_resolve",
        detail: {
          step: "triage_thread_actions",
          resourceKey: publish.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
          threadRootCommentId: verdict.threadRootCommentId,
        },
        recover: async () => {
          const current = await publish.prSurface.listInlineReviewThreads();
          return current.byRootCommentId.get(verdict.threadRootCommentId)?.isResolved === true
            ? { kind: "reconciled" as const, value: undefined }
            : { kind: "absent" as const };
        },
        isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
        mutate: () => publish.prSurface.resolveInlineReviewThread(resolution.threadNodeId),
      });
    } catch (error) {
      captureTriageFailure(analytics, "thread_resolve", error, {
        thread_root_comment_id: verdict.threadRootCommentId,
      });
      throw error;
    }
  }
  return missingThreadAction;
}

async function publishTriageReportTable(params: {
  readonly publish: PublishTriageParams;
  readonly analytics: TriageAnalyticsRef;
  readonly pushOutcome: TriagePushOutcome;
  readonly committedDetails: readonly TriageCommittedDetail[];
  readonly missingThreadAction: boolean;
}): Promise<void> {
  const { publish, analytics, pushOutcome, committedDetails, missingThreadAction } = params;
  try {
    await upsertTriageReport({
      ...publish,
      body: renderTriageReport({
        headSha: publish.headSha,
        inventory: publish.inventory,
        payload: publish.payload,
        commits: pushOutcome === "pushed" ? committedDetails : [],
        previouslyResolvedCount: publish.previouslyResolvedCount,
        notice: [
          pushOutcome === "closed" ? TRIAGE_CLOSED_PR_NOTICE : undefined,
          pushOutcome === "stale" ? TRIAGE_STALE_HEAD_NOTICE : undefined,
          missingThreadAction ? TRIAGE_THREAD_RESOLUTION_NOTICE : undefined,
        ]
          .filter((notice) => notice != null)
          .join("\n\n"),
        scope: publish.scope,
        threadRootCommentId: publish.threadRootCommentId,
      }),
    });
  } catch (error) {
    captureTriageFailure(analytics, "publish_report", error);
    throw error;
  }
}

function recordTriageFindingHistory(params: PublishTriageParams): void {
  if (!params.findingHistoryCfg) return;
  const findingHistoryThreadById = new Map(
    params.inventory.map((thread) => [thread.rootCommentId, thread]),
  );
  for (const verdict of params.payload.verdicts) {
    const thread = findingHistoryThreadById.get(verdict.threadRootCommentId);
    if (!thread) continue;
    safeRecordThreadFindingHistoryOutcome(params.pool, params.findingHistoryCfg, {
      scope: {
        installationId: params.installationId,
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        workItemId: params.workItemId,
        headSha: params.headSha,
      },
      resourceKey: params.resourceKey,
      thread,
      outcome: verdict.verdict,
    });
  }
}
