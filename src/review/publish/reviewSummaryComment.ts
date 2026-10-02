import { createPublishContext } from "../../agentWork/publishOnce.js";
import type { Pool, PoolClient } from "pg";
import { withSessionLock } from "../../db/sessionLock.js";
import {
  claimSummaryCommentCreation,
  getProgressCommentOwner,
  getProgressCommentRevision,
  getProgressStubPostedAtMs,
  getSummaryCommentGithubId,
} from "../../agentWork/publishRecordRepository.js";
import { logWarn } from "../../evlog.js";
import { AppError } from "../../errors/appError.js";
import type { IssueCommentRef, PrSurface } from "../../github/prSurface.js";
import {
  POSTGRES_LOCK_TIMEOUT_MS,
  REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS,
  type AnyReviewLens,
} from "../../settings/index.js";
import { parseProgressRevisionState, withProgressRevisionComment } from "../run/commentMarkers.js";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.js";

export type SummaryCommentCoordination = {
  pool: Pool;
  workItemId: string;
  resourceKey: string;
  leaseEpoch?: number | null;
};

export type RecordPublishStepFn = (
  step: "inline_review" | "summary_comment" | "labels",
  detail?: { githubId?: string | number; meta?: Record<string, unknown> },
) => Promise<void>;

export type RecordPublishStepWithCoordination = RecordPublishStepFn & {
  summaryCommentCoordination?: SummaryCommentCoordination;
};

export function attachSummaryCommentCoordination(
  recordPublishStep: RecordPublishStepFn,
  coordination: SummaryCommentCoordination,
): RecordPublishStepWithCoordination {
  return Object.assign(recordPublishStep, { summaryCommentCoordination: coordination });
}

async function resolveKnownSummaryCommentRef(
  prSurface: PrSurface,
  sentinel: string,
  hintCommentId: number | null | undefined,
): Promise<{ id: number; url: string } | null> {
  const resolved = await prSurface.resolveProgressComment(sentinel, hintCommentId);
  return resolved ? { id: resolved.id, url: resolved.url } : null;
}

type ProgressCommentRevision = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type TickRevision = Exclude<ProgressCommentRevision, 7>;

type SummaryCommentUpsertResult = {
  readonly id: number;
  readonly updated: boolean;
  readonly skipped?: true;
};

type SummaryCommentUpsertParams = {
  pool: Pool | PoolClient;
  workItemId?: string;
  leaseEpoch?: number | null;
  resourceKey: string;
  reviewLens: AnyReviewLens;
  prSurface: PrSurface;
  body: string;
  sentinel: string;
  hintCommentId?: number | null;
  progressRevision?: ProgressCommentRevision;
  ciHeadSha?: string;
  ciVersion?: number;
  shouldPublish?: (client: PoolClient) => Promise<boolean>;
};

type RevisionedUpsertParams = Omit<SummaryCommentUpsertParams, "pool" | "progressRevision"> & {
  readonly pool: Pool;
  readonly progressRevision: ProgressCommentRevision;
};

async function upsertSummaryCommentWithoutRevision(
  params: SummaryCommentUpsertParams,
): Promise<SummaryCommentUpsertResult> {
  const { pool, workItemId, resourceKey, reviewLens, prSurface, body, sentinel } = params;

  const storedId = await getSummaryCommentGithubId(pool, resourceKey, reviewLens);
  const hintId = params.hintCommentId ?? storedId ?? null;
  const knownFromStored = await resolveKnownSummaryCommentRef(prSurface, sentinel, hintId);
  if (knownFromStored) {
    return prSurface.upsertProgressComment(body, sentinel, knownFromStored);
  }

  if (workItemId == null) {
    const scanned = await prSurface.findProgressComment(sentinel);
    return prSurface.upsertProgressComment(body, sentinel, scanned);
  }

  const claimWon =
    params.leaseEpoch == null
      ? await claimSummaryCommentCreation(pool, workItemId, resourceKey, reviewLens)
      : await claimSummaryCommentCreation(
          pool,
          workItemId,
          resourceKey,
          reviewLens,
          params.leaseEpoch,
        );
  if (claimWon) {
    const scanned = await prSurface.findProgressComment(sentinel);
    return prSurface.upsertProgressComment(body, sentinel, scanned);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay =
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS[attempt - 1] ??
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS.at(-1) ??
        0;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    const polledId = await getSummaryCommentGithubId(pool, resourceKey, reviewLens);
    if (polledId == null) continue;
    const knownFromPoll = await resolveKnownSummaryCommentRef(prSurface, sentinel, polledId);
    if (knownFromPoll) {
      return prSurface.upsertProgressComment(body, sentinel, knownFromPoll);
    }
  }

  const scanned = await prSurface.findProgressComment(sentinel);
  return prSurface.upsertProgressComment(body, sentinel, scanned);
}

type PreparedRevisionUpsert =
  | { readonly kind: "skipped"; readonly result: SummaryCommentUpsertResult }
  | {
      readonly kind: "write";
      readonly body: string;
      readonly hintCommentId?: number | null;
      readonly stubPostedAtMs: number | null;
    };

function skippedRevisionResult(
  currentComment: IssueCommentRef | null,
  hintCommentId?: number | null,
): SummaryCommentUpsertResult {
  if (currentComment) {
    return { id: currentComment.id, updated: false, skipped: true };
  }
  if (hintCommentId != null) {
    return { id: hintCommentId, updated: false, skipped: true };
  }
  return { id: 0, updated: false, skipped: true };
}

async function prepareSummaryCommentAtRevision(
  params: Omit<SummaryCommentUpsertParams, "pool" | "progressRevision"> & {
    readonly progressRevision: ProgressCommentRevision;
    readonly currentComment: IssueCommentRef | null;
  },
  client: PoolClient,
): Promise<PreparedRevisionUpsert> {
  const [progressOwner, storedRevision] = await Promise.all([
    getProgressCommentOwner(client, params.resourceKey, params.reviewLens),
    getProgressCommentRevision(client, params.resourceKey, params.reviewLens),
  ]);
  const currentComment = params.currentComment;
  const bodyRevision = currentComment
    ? parseProgressRevisionState(currentComment.body ?? "")
    : null;
  if (params.shouldPublish && !(await params.shouldPublish(client))) {
    return { kind: "skipped", result: skippedRevisionResult(currentComment, params.hintCommentId) };
  }
  // Authoritative ownership lives on the progress publish record (reassigned at intake).
  // Stale writers whose work item no longer owns the record must not overwrite.
  if (
    progressOwner != null &&
    params.workItemId != null &&
    progressOwner.workItemId !== params.workItemId
  ) {
    if (params.progressRevision > 0 || (currentComment == null && params.hintCommentId == null)) {
      logWarn("review_progress_skipped_foreign_owner", {
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
        workItemId: params.workItemId,
        ownerWorkItemId: progressOwner.workItemId,
        progressGeneration: progressOwner.generation,
        progressRevision: params.progressRevision,
      });
    }
    return {
      kind: "skipped",
      result: skippedRevisionResult(currentComment, params.hintCommentId),
    };
  }
  const storedRevisionForRun =
    storedRevision != null && storedRevision.workItemId === params.workItemId
      ? storedRevision.revision
      : -1;
  const bodyRevisionForRun =
    bodyRevision != null && bodyRevision.workItemId === params.workItemId
      ? bodyRevision.revision
      : -1;
  // Body revision is the published watermark. Stored revision is the lock-time
  // claim, so a retry after claim-but-before-GitHub can still write when the
  // comment is behind. The lock serializes the visible write and durable record.
  if (currentComment && bodyRevisionForRun >= params.progressRevision) {
    return { kind: "skipped", result: { id: currentComment.id, updated: false, skipped: true } };
  }
  if (storedRevisionForRun > params.progressRevision) {
    return {
      kind: "skipped",
      result: skippedRevisionResult(currentComment, params.hintCommentId),
    };
  }

  const stubPostedAtMs =
    params.workItemId != null && params.progressRevision === 0
      ? Date.now()
      : params.workItemId != null
        ? await getProgressStubPostedAtMs(client, params.resourceKey, params.reviewLens)
        : null;

  // Claim this revision under the advisory lock before the GitHub write so a
  // crash before acceptance remains recoverable without an open transaction.
  if (params.workItemId != null) {
    await createPublishContext(client, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      step: "progress_comment",
      leaseEpoch: params.leaseEpoch ?? null,
      detail: {
        progressRevision: params.progressRevision,
        ...(stubPostedAtMs != null ? { stubPostedAtMs } : {}),
        ...(params.ciHeadSha != null
          ? { headSha: params.ciHeadSha, version: params.ciVersion ?? 0 }
          : {}),
      },
    }).record();
  }

  return {
    kind: "write",
    body: withProgressRevisionComment(params.body, params.progressRevision, params.workItemId),
    hintCommentId: currentComment?.id ?? params.hintCommentId,
    stubPostedAtMs,
  };
}

async function upsertSummaryCommentAtRevision(
  params: RevisionedUpsertParams,
): Promise<SummaryCommentUpsertResult> {
  const progressRevision = params.progressRevision;

  return withSessionLock(
    params.pool,
    { kind: "progress", resourceKey: params.resourceKey, reviewLens: params.reviewLens },
    {
      mode: "wait",
      deadline: performance.now() + POSTGRES_LOCK_TIMEOUT_MS,
      capacityError: (poolMax) =>
        Object.assign(
          new AppError({
            code: "review.progress_lock_capacity",
            message: "Progress publication needs a pool with at least two connections",
            context: { poolMax },
          }),
          { mutationAccepted: false },
        ),
      timeoutError: Object.assign(
        new AppError({
          code: "review.progress_lock_timeout",
          message: "Progress publication lock acquisition timed out",
          context: { timeoutMs: POSTGRES_LOCK_TIMEOUT_MS },
        }),
        { mutationAccepted: false },
      ),
      onAcquireError: (error) => {
        throw Object.assign(
          error instanceof AppError
            ? error
            : new AppError({
                code: "review.progress_lock_failed",
                message: "Progress publication lock acquisition failed",
                cause: error,
              }),
          { mutationAccepted: false },
        );
      },
      onUnlockError: (error) => {
        logWarn("review_progress_unlock_failed", {
          resourceKey: params.resourceKey,
          reviewLens: params.reviewLens,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    },
    async (client) => {
      const currentComment = await params.prSurface.findProgressComment(params.sentinel);
      const prepared = await prepareSummaryCommentAtRevision(
        { ...params, progressRevision, currentComment },
        client,
      );
      if (prepared.kind === "skipped") {
        return prepared.result;
      }
      const result = await upsertSummaryCommentWithoutRevision({
        ...params,
        pool: client,
        body: prepared.body,
        hintCommentId: prepared.hintCommentId,
      });
      if (params.workItemId != null) {
        await createPublishContext(client, {
          workItemId: params.workItemId,
          resourceKey: params.resourceKey,
          reviewLens: params.reviewLens,
          step: "progress_comment",
          githubId: result.id,
          leaseEpoch: params.leaseEpoch ?? null,
          detail: {
            progressRevision: params.progressRevision,
            updated: result.updated,
            ...(prepared.stubPostedAtMs != null ? { stubPostedAtMs: prepared.stubPostedAtMs } : {}),
            ...(params.ciHeadSha != null
              ? { headSha: params.ciHeadSha, version: params.ciVersion ?? 0 }
              : {}),
          },
        }).record();
      }
      return result;
    },
  );
}

export type ReviewSummaryCommentDeps = {
  readonly prSurface: PrSurface;
  readonly reviewLens: AnyReviewLens;
  /** Without a pool there is no record or lock to serialize against, so writes go straight to the surface. */
  readonly coordination?: {
    readonly pool: Pool;
    readonly resourceKey: string;
    readonly workItemId?: string;
    readonly leaseEpoch?: number | null;
  };
};

type ReviewSummaryCommentWrite = {
  readonly body: string;
  readonly hintCommentId?: number | null;
  readonly ciHeadSha?: string;
  readonly ciVersion?: number;
  /** Reused by the uncoordinated write; coordinated writes resolve the comment under the lock. */
  readonly knownExisting?: IssueCommentRef | null;
};

export type ReviewSummaryCommentTick = ReviewSummaryCommentWrite & {
  readonly progressRevision: TickRevision;
  readonly shouldPublish?: (client: PoolClient) => Promise<boolean>;
};

/**
 * The only writer of the review summary comment. Coordinated writes run in one
 * order: progress lock, owner and revision checks, creation claim, GitHub write,
 * result record. Revision 7 is terminal, so a later tick or ack stub cannot
 * overwrite a summary, cancelled notice, or failure notice.
 */
export function createReviewSummaryComment(deps: ReviewSummaryCommentDeps) {
  const write = (
    params: ReviewSummaryCommentWrite & {
      readonly shouldPublish?: ReviewSummaryCommentTick["shouldPublish"];
    },
    progressRevision: ProgressCommentRevision,
  ): Promise<SummaryCommentUpsertResult> => {
    const { coordination } = deps;
    if (coordination == null) {
      return deps.prSurface.upsertProgressComment(
        params.body,
        REVIEW_SUMMARY_SENTINEL,
        params.knownExisting ?? null,
      );
    }
    return upsertSummaryCommentAtRevision({
      pool: coordination.pool,
      resourceKey: coordination.resourceKey,
      workItemId: coordination.workItemId,
      leaseEpoch: coordination.leaseEpoch,
      reviewLens: deps.reviewLens,
      prSurface: deps.prSurface,
      body: params.body,
      sentinel: REVIEW_SUMMARY_SENTINEL,
      hintCommentId: params.hintCommentId,
      progressRevision,
      ciHeadSha: params.ciHeadSha,
      ciVersion: params.ciVersion,
      shouldPublish: params.shouldPublish,
    });
  };
  return {
    tick: (params: ReviewSummaryCommentTick) => write(params, params.progressRevision),
    conclude: (params: ReviewSummaryCommentWrite) => write(params, 7),
  };
}
