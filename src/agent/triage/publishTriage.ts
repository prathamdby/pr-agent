import type { TriageScope } from "../../agentWork/types.js";
import type { Pool } from "pg";
import * as v from "valibot";
import type { PrSurface } from "../../github/prSurface.js";
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

async function replyToThread(
  params: Pick<PublishTriageParams, "prSurface" | "prNumber"> & {
    readonly thread: BotFindingThread;
    readonly verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>;
  },
): Promise<void> {
  await params.prSurface.replyAt(
    {
      kind: "inlineReviewThread",
      prNumber: params.prNumber,
      inReplyToCommentId: params.thread.rootCommentId,
    },
    replyBody(params.verdict),
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
  const result = await withOperationIntent({
    client: params.pool,
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    operationKey: triageReportOperationKey(params.resourceKey),
    mutationKind: "github.triage_report",
    detail: {
      step: "triage_report",
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
    },
    mutate: () =>
      params.prSurface.upsertProgressComment(
        redactReviewText(params.body),
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
      await withOperationIntent({
        client: params.pool,
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        signal: params.signal,
        operationKey: triagePushOperationKey(params.resourceKey),
        mutationKind: "github.triage_push",
        detail: {
          step: "triage_push",
          resourceKey: params.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
        },
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
        await withOperationIntent({
          client: params.pool,
          workItemId: params.workItemId,
          leaseEpoch: params.leaseEpoch,
          operationKey: triageThreadOperationKey(verdict.threadRootCommentId),
          mutationKind: "github.triage_thread_reply",
          detail: {
            step: "triage_thread_actions",
            resourceKey: params.resourceKey,
            reviewLens: TRIAGE_PUBLISH_LENS,
            threadRootCommentId: verdict.threadRootCommentId,
          },
          mutate: () => replyToThread({ ...params, thread, verdict }),
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
      await withOperationIntent({
        client: params.pool,
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        operationKey: `${triageThreadOperationKey(verdict.threadRootCommentId)}:resolve`,
        mutationKind: "github.triage_thread_resolve",
        detail: {
          step: "triage_thread_actions",
          resourceKey: params.resourceKey,
          reviewLens: TRIAGE_PUBLISH_LENS,
          threadRootCommentId: verdict.threadRootCommentId,
        },
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
