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
import { nonErrorThrown } from "../../errors/appError.js";
import { isJsonObject, isJsonString, type JsonValue } from "../../util/jsonValue.js";
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
  readonly executionEpoch: number;
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

type TriagePriorPush = {
  readonly pushed: boolean;
  readonly degraded: boolean;
};

export type StoredTriagePushDetail = {
  readonly pushed: boolean;
  readonly degraded: boolean;
  readonly pushedHeadSha?: string;
  readonly payload: TriagePayload;
  readonly commits: readonly TriageCommittedDetail[];
};

function parseStoredCommit(value: JsonValue): TriageCommittedDetail | null {
  if (!isJsonObject(value)) return null;
  return isJsonString(value.sha) && isJsonString(value.subject) && isJsonString(value.diff)
    ? { sha: value.sha, subject: value.subject, diff: value.diff }
    : null;
}

export function parseStoredTriagePushDetail(detail: JsonValue): StoredTriagePushDetail | null {
  if (!isJsonObject(detail)) return null;
  const payload = v.safeParse(TriagePayloadSchema, detail.payload);
  if (!payload.success || !Array.isArray(detail.commits)) return null;
  const commits: TriageCommittedDetail[] = [];
  for (const item of detail.commits) {
    const parsed = parseStoredCommit(item);
    if (parsed == null) return null;
    commits.push(parsed);
  }
  const staleHead = detail.staleHead === true;
  return {
    payload: payload.output,
    commits,
    pushed: !staleHead,
    degraded: staleHead,
    pushedHeadSha: isJsonString(detail.pushedHeadSha) ? detail.pushedHeadSha : undefined,
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

function shouldResolveTriageThread(verdict: TriageVerdict, pushed: boolean): boolean {
  switch (verdict.verdict) {
    case "skipped":
      return false;
    case "fixed":
      return pushed;
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
    "prSurface" | "pool" | "workItemId" | "resourceKey" | "executionEpoch"
  > & {
    readonly body: string;
  },
): Promise<void> {
  const result = await withOperationIntent({
    client: params.pool,
    workItemId: params.workItemId,
    executionEpoch: params.executionEpoch,
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
    executionEpoch: params.executionEpoch,
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
    const err =
      error instanceof Error
        ? error
        : nonErrorThrown("triage.publish_report_only_non_error_thrown");
    captureTriageFailure(analytics, "publish_report_only", err);
    throw err;
  }
}

export async function publishTriage(params: PublishTriageParams): Promise<{ degraded: boolean }> {
  const analytics: TriageAnalyticsRef = {
    installationId: params.installationId,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    workItemId: params.workItemId,
    scope: params.scope,
  };
  let pushed = params.priorPush?.pushed ?? false;
  let degraded = params.priorPush?.degraded ?? false;
  let stalePush = params.priorPush?.degraded ?? false;
  let missingThreadAction = false;
  const committedShas = params.checkout.listCommittedShas();
  if (!params.priorPush && committedShas.length > 0) {
    try {
      await withOperationIntent({
        client: params.pool,
        workItemId: params.workItemId,
        executionEpoch: params.executionEpoch,
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
      pushed = true;
      await recordPublishStep(params.pool, {
        workItemId: params.workItemId,
        executionEpoch: params.executionEpoch,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: {
          pushedShas: committedShas,
          baseHeadSha: params.headSha,
          pushedHeadSha: committedShas.at(-1) ?? params.headSha,
          commits: params.checkout.listCommittedDetails(),
          payload: params.payload,
        },
      });
    } catch (error) {
      if (!(error instanceof StaleHeadPushError)) {
        const err =
          error instanceof Error ? error : nonErrorThrown("triage.publish_push_non_error_thrown");
        captureTriageFailure(analytics, "publish_push", err);
        throw err;
      }
      degraded = true;
      stalePush = true;
      captureTriageEvent(analytics, "triage degraded", {
        step: "publish_push",
        reason: "stale_head",
      });
      await recordPublishStep(params.pool, {
        workItemId: params.workItemId,
        executionEpoch: params.executionEpoch,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: {
          staleHead: true,
          attemptedShas: committedShas,
          baseHeadSha: params.headSha,
          commits: params.checkout.listCommittedDetails(),
          payload: params.payload,
        },
      });
    }
  } else if (!params.priorPush) {
    await recordPublishStep(params.pool, {
      workItemId: params.workItemId,
      executionEpoch: params.executionEpoch,
      resourceKey: params.resourceKey,
      reviewLens: TRIAGE_PUBLISH_LENS,
      step: "triage_push",
      detail: {
        pushedShas: [],
        baseHeadSha: params.headSha,
        pushedHeadSha: params.headSha,
        commits: [],
        payload: params.payload,
      },
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
    if (!shouldResolveTriageThread(verdict, pushed)) continue;
    const thread = threadById.get(verdict.threadRootCommentId);
    const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
    if (!thread || !resolution) {
      degraded = true;
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
          executionEpoch: params.executionEpoch,
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
        const err =
          error instanceof Error ? error : nonErrorThrown("triage.thread_reply_non_error_thrown");
        captureTriageFailure(analytics, "thread_reply", err, {
          thread_root_comment_id: verdict.threadRootCommentId,
        });
        throw err;
      }
      actedThreadIds.add(verdict.threadRootCommentId);
      await recordActedThreadIds(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_thread_actions",
        actedThreadIds: [...actedThreadIds],
        executionEpoch: params.executionEpoch,
      });
    }
    try {
      await withOperationIntent({
        client: params.pool,
        workItemId: params.workItemId,
        executionEpoch: params.executionEpoch,
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
      const err =
        error instanceof Error ? error : nonErrorThrown("triage.thread_resolve_non_error_thrown");
      captureTriageFailure(analytics, "thread_resolve", err, {
        thread_root_comment_id: verdict.threadRootCommentId,
      });
      throw err;
    }
  }

  try {
    await upsertTriageReport({
      ...params,
      body: renderTriageReport({
        headSha: params.headSha,
        inventory: params.inventory,
        payload: params.payload,
        commits: pushed ? params.checkout.listCommittedDetails() : [],
        previouslyResolvedCount: params.previouslyResolvedCount,
        notice: [
          stalePush ? TRIAGE_STALE_HEAD_NOTICE : undefined,
          missingThreadAction ? TRIAGE_THREAD_RESOLUTION_NOTICE : undefined,
        ]
          .filter((notice) => notice != null)
          .join("\n\n"),
        scope: params.scope,
        threadRootCommentId: params.threadRootCommentId,
      }),
    });
  } catch (error) {
    const err =
      error instanceof Error ? error : nonErrorThrown("triage.publish_report_non_error_thrown");
    captureTriageFailure(analytics, "publish_report", err);
    throw err;
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

  return { degraded };
}
