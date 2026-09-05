import type { Pool, PoolClient } from "pg";
import {
  claimSummaryCommentCreation,
  getProgressCommentOwner,
  getProgressCommentRevision,
  getProgressStubPostedAtMs,
  getSummaryCommentGithubId,
  recordPublishStep as recordAgentWorkPublishStep,
} from "../../agentWork/repository.js";
import { logWarn } from "../../evlog.js";
import type { IssueCommentRef, PrSurface } from "../../github/prSurface.js";
import { REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS } from "../../settings/index.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import { preserveCiSummaryRowInCommentBody } from "../ci/renderCiSummary.js";
import { parseProgressRevisionState, withProgressRevisionComment } from "../run/progressComment.js";

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
  // Authoritative ownership lives on the progress publish record (reassigned at intake).
  // Stale writers whose work item no longer owns the record must not overwrite.
  if (
    progressOwner != null &&
    params.workItemId != null &&
    progressOwner.workItemId !== params.workItemId
  ) {
    if (currentComment == null && params.hintCommentId == null) {
      logWarn("review_progress_skipped_foreign_owner", {
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
        workItemId: params.workItemId,
        ownerWorkItemId: progressOwner.workItemId,
        progressGeneration: progressOwner.generation,
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
  // comment is behind. A newer claim still wins without holding the lock across HTTP.
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
  // concurrent older tick cannot pass the check after we unlock.
  if (params.workItemId != null) {
    await recordAgentWorkPublishStep(client, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      step: "progress_comment",
      leaseEpoch: params.leaseEpoch ?? null,
      detail: {
        progressRevision: params.progressRevision,
        ...(stubPostedAtMs != null ? { stubPostedAtMs } : {}),
      },
    });
  }

  return {
    kind: "write",
    body: withProgressRevisionComment(
      preserveCiSummaryRowInCommentBody(currentComment?.body ?? "", params.body),
      params.progressRevision,
      params.workItemId,
    ),
    hintCommentId: currentComment?.id ?? params.hintCommentId,
    stubPostedAtMs,
  };
}

export async function upsertSummaryCommentWithCreationClaim(
  params: Omit<SummaryCommentUpsertParams, "pool"> & { readonly pool: Pool },
): Promise<SummaryCommentUpsertResult> {
  if (params.progressRevision == null) {
    return upsertSummaryCommentWithoutRevision(params);
  }

  const currentComment = await params.prSurface.findProgressComment(params.sentinel);

  const client = await params.pool.connect();
  const lockKey = JSON.stringify([params.resourceKey, params.reviewLens]);
  let lockAcquired = false;
  let outcome:
    | { readonly kind: "success"; readonly value: PreparedRevisionUpsert }
    | { readonly kind: "error"; readonly error: unknown };
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    lockAcquired = true;
    outcome = {
      kind: "success",
      value: await prepareSummaryCommentAtRevision(
        { ...params, progressRevision: params.progressRevision, currentComment },
        client,
      ),
    };
  } catch (error) {
    outcome = { kind: "error", error };
  }

  let unlockError: unknown;
  if (lockAcquired) {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
    } catch (error) {
      unlockError = error;
      logWarn("review_progress_unlock_failed", {
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  client.release(unlockError === undefined ? undefined : true);
  if (outcome.kind === "error") throw outcome.error;
  if (unlockError !== undefined) throw unlockError;
  if (outcome.value.kind === "skipped") return outcome.value.result;

  const result = await upsertSummaryCommentWithoutRevision({
    ...params,
    pool: params.pool,
    body: outcome.value.body,
    hintCommentId: outcome.value.hintCommentId,
  });
  if (params.workItemId != null) {
    await recordAgentWorkPublishStep(params.pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      step: "progress_comment",
      githubId: result.id,
      leaseEpoch: params.leaseEpoch ?? null,
      detail: {
        progressRevision: params.progressRevision,
        updated: result.updated,
        ...(outcome.value.stubPostedAtMs != null
          ? { stubPostedAtMs: outcome.value.stubPostedAtMs }
          : {}),
      },
    });
  }
  return result;
}
