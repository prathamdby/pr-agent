import type { TriageScope } from "../../agentWork/types.js";
import type { Pool } from "pg";
import { installationOctokit } from "../../github/appAuth.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import {
  resolveReviewThread,
  type ReviewThreadResolution,
} from "../../github/reviewThreadResolution.js";
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
  loadActedThreadIds,
  recordActedThreadIds,
} from "../../agentWork/threadActionCheckpoint.js";
import {
  captureTriageEvent,
  captureTriageFailure,
  type TriageAnalyticsRef,
} from "../../agentWork/triageAnalytics.js";
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
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
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

function parseStoredCommit(value: unknown): TriageCommittedDetail | null {
  if (typeof value !== "object" || value == null) return null;
  const entry = value as Record<string, unknown>;
  return typeof entry.sha === "string" &&
    typeof entry.subject === "string" &&
    typeof entry.diff === "string"
    ? { sha: entry.sha, subject: entry.subject, diff: entry.diff }
    : null;
}

export function parseStoredTriagePushDetail(detail: unknown): StoredTriagePushDetail | null {
  if (typeof detail !== "object" || detail == null) return null;
  const entry = detail as Record<string, unknown>;
  const payload = TriagePayloadSchema.safeParse(entry.payload);
  if (!payload.success || !Array.isArray(entry.commits)) return null;
  const commits = entry.commits.map(parseStoredCommit);
  if (commits.some((commit) => commit == null)) return null;
  const staleHead = entry.staleHead === true;
  return {
    payload: payload.data,
    commits: commits as TriageCommittedDetail[],
    pushed: !staleHead,
    degraded: staleHead,
    pushedHeadSha: typeof entry.pushedHeadSha === "string" ? entry.pushedHeadSha : undefined,
  };
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
  params: Pick<
    PublishTriageParams,
    "token" | "tokenExpiresAtTs" | "owner" | "repo" | "prNumber"
  > & {
    readonly thread: BotFindingThread;
    readonly verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>;
  },
): Promise<void> {
  const octokit = installationOctokit(params.token, params.tokenExpiresAtTs);
  await octokit.rest.pulls.createReplyForReviewComment({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
    comment_id: params.thread.rootCommentId,
    body: replyBody(params.verdict),
  });
}

async function upsertTriageReport(
  params: Pick<
    PublishTriageParams,
    | "token"
    | "tokenExpiresAtTs"
    | "owner"
    | "repo"
    | "prNumber"
    | "pool"
    | "workItemId"
    | "resourceKey"
  > & {
    readonly body: string;
  },
): Promise<void> {
  const result = await upsertReviewSummaryComment(
    params.token,
    params.owner,
    params.repo,
    params.prNumber,
    redactReviewText(params.body),
    TRIAGE_SUMMARY_SENTINEL,
    undefined,
    params.tokenExpiresAtTs,
  );
  await recordPublishStep(params.pool, {
    workItemId: params.workItemId,
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
      await params.checkout.push();
      pushed = true;
      await recordPublishStep(params.pool, {
        workItemId: params.workItemId,
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
        captureTriageFailure(analytics, "publish_push", error);
        throw error;
      }
      degraded = true;
      stalePush = true;
      captureTriageEvent(analytics, "triage degraded", {
        step: "publish_push",
        reason: "stale_head",
      });
      await recordPublishStep(params.pool, {
        workItemId: params.workItemId,
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
    if (verdict.verdict !== "fixed" && verdict.verdict !== "already-resolved") continue;
    if (verdict.verdict === "fixed" && !pushed) continue;
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
    if (!actedThreadIds.has(verdict.threadRootCommentId) && thread.hasTriageReply !== true) {
      try {
        await replyToThread({ ...params, thread, verdict });
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
      });
    }
    try {
      await resolveReviewThread(params.token, resolution.threadNodeId, params.tokenExpiresAtTs);
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
    captureTriageFailure(analytics, "publish_report", error);
    throw error;
  }
  return { degraded };
}
