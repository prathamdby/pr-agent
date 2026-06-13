import type { Pool } from "pg";
import { installationOctokit } from "../github/appAuth.js";
import { upsertReviewSummaryComment } from "../github/reviewPublish.js";
import {
  resolveReviewThread,
  type ReviewThreadResolution,
} from "../github/reviewThreadResolution.js";
import { redactReviewText } from "../review/reviewPublicOutput.js";
import type { BotFindingThread } from "../review/reviewPriorFeedback.js";
import {
  TriagePayloadSchema,
  type TriagePayload,
  type TriageVerdict,
} from "../review/triageSchema.js";
import {
  TRIAGE_PUBLISH_LENS,
  TRIAGE_STALE_HEAD_NOTICE,
  TRIAGE_SUMMARY_SENTINEL,
} from "../settings/index.js";
import { recordPublishStep } from "../agentWork/repository.js";
import { StaleHeadPushError, type WritablePrCheckout } from "../prWorkspace/writablePrCheckout.js";
import { renderTriageReport } from "./triageRender.js";

type PublishTriageParams = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
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
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function actedThreadIdsFromDetail(detail: unknown): number[] {
  if (!detail || typeof detail !== "object" || !("actedThreadIds" in detail)) return [];
  const value = detail.actedThreadIds;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => Number.isInteger(item));
}

async function loadActedThreadIds(pool: Pool, resourceKey: string): Promise<number[]> {
  const row = await pool.query<{ detail: unknown }>(
    `SELECT detail
       FROM publish_records
      WHERE resource_key = $1
        AND review_lens = $2
        AND step = 'triage_thread_actions'
        AND status = 'completed'
      LIMIT 1`,
    [resourceKey, TRIAGE_PUBLISH_LENS],
  );
  return actedThreadIdsFromDetail(row.rows[0]?.detail);
}

async function recordActedThreadIds(
  pool: Pool,
  params: Pick<PublishTriageParams, "workItemId" | "resourceKey"> & {
    readonly actedThreadIds: readonly number[];
  },
): Promise<void> {
  await recordPublishStep(pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: TRIAGE_PUBLISH_LENS,
    step: "triage_thread_actions",
    detail: { actedThreadIds: params.actedThreadIds },
  });
}

function replyBody(
  verdict: Extract<TriageVerdict, { verdict: "fixed" | "already-resolved" }>,
): string {
  if (verdict.verdict === "fixed") {
    return redactReviewText(
      `**Triage**: fixed in ${shortSha(verdict.commitSha)} - ${verdict.evidence}`,
    );
  }
  return redactReviewText(`**Triage**: already resolved - ${verdict.evidence}`);
}

async function replyAndResolve(
  params: Pick<
    PublishTriageParams,
    "token" | "tokenExpiresAtTs" | "owner" | "repo" | "prNumber"
  > & {
    readonly thread: BotFindingThread;
    readonly resolution: ReviewThreadResolution;
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
  await resolveReviewThread(params.token, params.resolution.threadNodeId, params.tokenExpiresAtTs);
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
    params.body,
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
  await upsertTriageReport(params);
}

export async function publishTriage(params: PublishTriageParams): Promise<{ degraded: boolean }> {
  let pushed = params.priorPush?.pushed ?? false;
  let degraded = params.priorPush?.degraded ?? false;
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
          commits: params.checkout.listCommittedDetails(),
          payload: params.payload,
        },
      });
    } catch (error) {
      if (!(error instanceof StaleHeadPushError)) throw error;
      degraded = true;
      await recordPublishStep(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: TRIAGE_PUBLISH_LENS,
        step: "triage_push",
        detail: {
          staleHead: true,
          attemptedShas: committedShas,
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
      detail: { pushedShas: [], commits: [], payload: params.payload },
    });
  }

  const actedThreadIds = new Set(await loadActedThreadIds(params.pool, params.resourceKey));
  const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
  for (const verdict of params.payload.verdicts) {
    if (verdict.verdict !== "fixed" && verdict.verdict !== "already-resolved") continue;
    if (verdict.verdict === "fixed" && !pushed) continue;
    if (actedThreadIds.has(verdict.threadRootCommentId)) continue;
    const thread = threadById.get(verdict.threadRootCommentId);
    const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
    if (!thread || !resolution || resolution.isResolved) continue;
    await replyAndResolve({ ...params, thread, resolution, verdict });
    actedThreadIds.add(verdict.threadRootCommentId);
    await recordActedThreadIds(params.pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      actedThreadIds: [...actedThreadIds],
    });
  }

  await upsertTriageReport({
    ...params,
    body: renderTriageReport({
      headSha: params.headSha,
      inventory: params.inventory,
      payload: params.payload,
      commits: pushed ? params.checkout.listCommittedDetails() : [],
      previouslyResolvedCount: params.previouslyResolvedCount,
      notice: degraded ? TRIAGE_STALE_HEAD_NOTICE : undefined,
    }),
  });
  return { degraded };
}
