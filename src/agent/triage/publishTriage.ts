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
  TRIAGE_PUBLISH_LENS,
  TRIAGE_STALE_HEAD_NOTICE,
  TRIAGE_SUMMARY_SENTINEL,
  TRIAGE_THREAD_RESOLUTION_NOTICE,
} from "../../settings/index.js";
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

export type TriagePushOutcome = "not-needed" | "pushed" | "stale";

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
  return value === "not-needed" || value === "pushed" || value === "stale";
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
  if (params.outcome === "stale") {
    // Keep staleHead so mixed-version workers still parse this row.
    return { ...shared, staleHead: true, attemptedShas: params.committedShas };
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

export async function publishTriage(params: PublishTriageParams): Promise<PublishTriageResult> {
  const analytics: TriageAnalyticsRef = {
    installationId: params.installationId,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    workItemId: params.workItemId,
    scope: params.scope,
  };
  let pushOutcome: TriagePushOutcome = params.priorPush?.pushOutcome ?? "not-needed";
  let missingThreadAction = false;
  const committedShas = params.checkout.listCommittedShas();
  const committedDetails = params.checkout.listCommittedDetails();
  if (!params.priorPush && committedShas.length > 0) {
    try {
      const operationKey = triagePushOperationKey(params.resourceKey);
      await withOperationIntent<void>({
        client: params.pool,
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        signal: params.signal,
        operationKey,
        mutationKind: "github.triage_push",
        detail: {
          step: "triage_push",
          resourceKey: params.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
        },
        recover: async () => {
          const pushed = await params.prSurface.listPushedCommits();
          return committedShas.every((sha) => pushed.some((commit) => commit.sha === sha))
            ? { kind: "reconciled" as const, value: undefined }
            : { kind: "absent" as const };
        },
        isKnownNoAcceptanceError: (error) =>
          error instanceof StaleHeadPushError || isKnownNoAcceptanceMutationError(error),
        mutate: async () => {
          await params.checkout.push();
        },
      });
      pushOutcome = "pushed";
      await recordPublishStep(params.pool, {
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: storedTriagePushRecord({
          outcome: "pushed",
          headSha: params.headSha,
          committedShas,
          commits: committedDetails,
          payload: params.payload,
        }),
      });
    } catch (error) {
      if (!(error instanceof StaleHeadPushError)) {
        captureTriageFailure(analytics, "publish_push", error);
        throw error;
      }
      pushOutcome = "stale";
      captureTriageEvent(analytics, "triage degraded", {
        step: "publish_push",
        reason: "stale_head",
      });
      await recordPublishStep(params.pool, {
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: storedTriagePushRecord({
          outcome: "stale",
          headSha: params.headSha,
          committedShas,
          commits: committedDetails,
          payload: params.payload,
        }),
      });
    }
  } else if (!params.priorPush) {
    await recordPublishStep(params.pool, {
      workItemId: params.workItemId,
      leaseEpoch: params.leaseEpoch,
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_push",
      detail: storedTriagePushRecord({
        outcome: "not-needed",
        headSha: params.headSha,
        committedShas: [],
        commits: [],
        payload: params.payload,
      }),
    });
  }

  const actedThreadIds = new Set(
    await loadActedThreadIds(params.pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_thread_actions",
    }),
  );
  const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
  for (const verdict of params.payload.verdicts) {
    if (!shouldResolveTriageThread(verdict, pushOutcome)) continue;
    const thread = threadById.get(verdict.threadRootCommentId);
    const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
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
        const operationMarker = operationIntentMarker(operationKey, params.workItemId);
        await withOperationIntent<void>({
          client: params.pool,
          workItemId: params.workItemId,
          leaseEpoch: params.leaseEpoch,
          operationKey,
          mutationKind: "github.triage_thread_reply",
          detail: {
            step: "triage_thread_actions",
            resourceKey: params.resourceKey,
            reviewLens: TRIAGE_PUBLISH_LENS,
            threadRootCommentId: verdict.threadRootCommentId,
            operationMarker,
          },
          recover: async () => {
            const existing = await findMarkedComment(
              params.prSurface,
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
              ...params,
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
      await recordActedThreadIds(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_thread_actions",
        actedThreadIds: [...actedThreadIds],
        leaseEpoch: params.leaseEpoch,
      });
    }
    try {
      const operationKey = `${triageThreadOperationKey(verdict.threadRootCommentId)}:resolve`;
      await withOperationIntent<void>({
        client: params.pool,
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        operationKey,
        mutationKind: "github.triage_thread_resolve",
        detail: {
          step: "triage_thread_actions",
          resourceKey: params.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
          threadRootCommentId: verdict.threadRootCommentId,
        },
        recover: async () => {
          const current = await params.prSurface.listInlineReviewThreads();
          return current.byRootCommentId.get(verdict.threadRootCommentId)?.isResolved === true
            ? { kind: "reconciled" as const, value: undefined }
            : { kind: "absent" as const };
        },
        isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
        mutate: () => params.prSurface.resolveInlineReviewThread(resolution.threadNodeId),
      });
    } catch (error) {
      captureTriageFailure(analytics, "thread_resolve", error, {
        thread_root_comment_id: verdict.threadRootCommentId,
      });
      throw error;
    }
  }

  try {
    await upsertTriageReport({
      ...params,
      body: renderTriageReport({
        headSha: params.headSha,
        inventory: params.inventory,
        payload: params.payload,
        commits: pushOutcome === "pushed" ? committedDetails : [],
        previouslyResolvedCount: params.previouslyResolvedCount,
        notice: [
          pushOutcome === "stale" ? TRIAGE_STALE_HEAD_NOTICE : undefined,
          missingThreadAction ? TRIAGE_THREAD_RESOLUTION_NOTICE : undefined,
        ]
          .filter((notice) => notice != null)
          .join("\n\n"),
        scope: params.scope,
        threadRootCommentId: params.threadRootCommentId,
      }),
    });
  } catch (error) {
    captureTriageFailure(analytics, "publish_report", error);
    throw error;
  }

  if (params.findingHistoryCfg) {
    const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
    for (const verdict of params.payload.verdicts) {
      const thread = threadById.get(verdict.threadRootCommentId);
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

  return { pushOutcome, missingThreadAction };
}
