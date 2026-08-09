import type { Pool } from "pg";
import { logWarn } from "../evlog.js";
import { isMissingActionsPermissionError } from "../github/actionsLogs.js";
import { httpStatus } from "../github/httpStatus.js";
import type { PrSurface } from "../github/prSurface.js";
import type { ReviewCheckRunConclusion } from "../github/reviewPublish.js";
import { checkRunFindingsSummary } from "../github/statusCopy.js";
import { isCheckFailingSeverity, type ReviewFinding } from "../review/reviewSchema.js";
import type { AnyReviewLens } from "../settings/legacyReviewLenses.js";
import {
  REVIEW_CHECK_RUN_RESERVATION_STALE_MS,
  REVIEW_CHECK_RUN_WAIT_FOR_ID_MS,
  REVIEW_CHECK_RUN_WAIT_POLL_MS,
} from "../settings/index.js";
import {
  getReviewCheckRunGithubId,
  recordReviewCheckRun,
  releaseUnstartedReviewCheckRunReservation,
  reserveReviewCheckRun,
} from "./repository.js";

/** P0–P2 findings fail the check; empty or P3-only payloads pass. */
export function reviewCheckRunOutcome(findings: readonly Pick<ReviewFinding, "severity">[]): {
  conclusion: ReviewCheckRunConclusion;
  summary: string;
} {
  const bugCount = findings.filter((f) => isCheckFailingSeverity(f.severity)).length;
  return {
    conclusion: bugCount > 0 ? "failure" : "success",
    summary: checkRunFindingsSummary(bugCount),
  };
}

export async function waitForReviewCheckRunGithubId(
  pool: Pool,
  workItemId: string,
  reviewLens: AnyReviewLens,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<number | null> {
  const timeoutMs = options?.timeoutMs ?? REVIEW_CHECK_RUN_WAIT_FOR_ID_MS;
  const pollMs = options?.pollMs ?? REVIEW_CHECK_RUN_WAIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await getReviewCheckRunGithubId(pool, workItemId, reviewLens);
    if (id != null) return id;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return getReviewCheckRunGithubId(pool, workItemId, reviewLens);
}

function logCheckRunWarning(
  event: string,
  error: unknown,
  fields: Record<string, string | number | undefined>,
): void {
  if (isMissingActionsPermissionError(error)) return;
  logWarn(event, {
    ...fields,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function reviewCheckRunName(): string {
  return "PR Agent Review";
}

export function reviewCheckDetailsUrl(
  owner: string,
  repo: string,
  prNumber: number,
  summaryCommentId?: string | number | null,
): string | undefined {
  if (summaryCommentId == null) return undefined;
  return `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${summaryCommentId}`;
}

type EnsureReviewCheckRunParams = {
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  workItemId: string;
  resourceKey: string;
  reviewLens: AnyReviewLens;
};

type GithubCheckRunRef = { id: number; url: string | null };

type CheckRunReservationOutcome =
  | { readonly kind: "existing"; readonly githubId: number }
  | { readonly kind: "reserved" }
  | { readonly kind: "resolved"; readonly githubId: number | null };

async function reserveReviewCheckRunSlot(
  pool: Pool,
  params: EnsureReviewCheckRunParams,
  name: string,
): Promise<CheckRunReservationOutcome> {
  const reserved = await reserveReviewCheckRun(pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: params.reviewLens,
    detail: {
      status: "starting",
      headSha: params.headSha,
      name,
    },
  });
  if (reserved) return { kind: "reserved" };
  return recoverStaleReservationOrWaitForPeer(pool, params, name);
}

async function recoverStaleReservationOrWaitForPeer(
  pool: Pool,
  params: EnsureReviewCheckRunParams,
  name: string,
): Promise<CheckRunReservationOutcome> {
  const existingAfterReserve = await getReviewCheckRunGithubId(
    pool,
    params.workItemId,
    params.reviewLens,
  );
  if (existingAfterReserve != null) return { kind: "existing", githubId: existingAfterReserve };

  const released = await releaseUnstartedReviewCheckRunReservation(pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: params.reviewLens,
    staleBefore: new Date(Date.now() - REVIEW_CHECK_RUN_RESERVATION_STALE_MS),
  });
  if (!released) {
    const githubId = await waitForReviewCheckRunGithubId(
      pool,
      params.workItemId,
      params.reviewLens,
    );
    return { kind: "resolved", githubId };
  }

  const reservedAfterRecovery = await reserveReviewCheckRun(pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: params.reviewLens,
    detail: {
      status: "starting",
      headSha: params.headSha,
      name,
      recoveredStaleReservation: true,
    },
  });
  if (reservedAfterRecovery) return { kind: "reserved" };

  const githubId = await getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
  return { kind: "resolved", githubId };
}

async function createGithubCheckRunOnSurface(
  pool: Pool,
  params: EnsureReviewCheckRunParams,
): Promise<GithubCheckRunRef | null> {
  try {
    return await params.prSurface.startReviewCheck(
      params.headSha,
      params.workItemId,
      "PR Agent review is in progress.",
    );
  } catch (createError) {
    // Duplicate-name 422 recovery lives in prSurfaceImpl.startReviewCheck.
    await releaseUnstartedReviewCheckRunReservation(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
    });
    const event =
      httpStatus(createError) === 422
        ? "review_check_run_start_duplicate_unresolved"
        : "review_check_run_start_failed";
    logCheckRunWarning(event, createError, {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
    });
    return null;
  }
}

async function cancelOrphanedCheckRunAfterRecordFailure(
  params: EnsureReviewCheckRunParams,
  name: string,
  check: GithubCheckRunRef,
  recordError: unknown,
): Promise<void> {
  try {
    await params.prSurface.finishReviewCheck({
      checkRunId: check.id,
      conclusion: "cancelled",
      summary: "PR Agent could not persist this check run.",
      name,
    });
  } catch (cancelError) {
    logCheckRunWarning("review_check_run_orphan_cancel_failed", cancelError, {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId: check.id,
    });
  }
  logWarn("review_check_run_record_failed", {
    owner: params.owner,
    repo: params.repo,
    pr: params.prNumber,
    reviewLens: params.reviewLens,
    checkRunId: check.id,
    message: recordError instanceof Error ? recordError.message : String(recordError),
  });
}

async function recordCreatedCheckRunOrCleanup(
  pool: Pool,
  params: EnsureReviewCheckRunParams,
  name: string,
  check: GithubCheckRunRef,
): Promise<number | null> {
  try {
    await recordReviewCheckRun(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      githubId: check.id,
      detail: {
        status: "in_progress",
        headSha: params.headSha,
        name,
        htmlUrl: check.url,
      },
    });
  } catch (e) {
    await cancelOrphanedCheckRunAfterRecordFailure(params, name, check, e);
    await releaseUnstartedReviewCheckRunReservation(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
    });
    return null;
  }
  return check.id;
}

export async function ensureReviewCheckRunStarted(
  pool: Pool,
  params: EnsureReviewCheckRunParams,
): Promise<number | null> {
  const existing = await getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
  if (existing != null) return existing;

  const name = reviewCheckRunName();
  const reservation = await reserveReviewCheckRunSlot(pool, params, name);
  if (reservation.kind === "existing") return reservation.githubId;
  if (reservation.kind === "resolved") return reservation.githubId;

  const check = await createGithubCheckRunOnSurface(pool, params);
  if (check == null) return null;

  return recordCreatedCheckRunOrCleanup(pool, params, name, check);
}

export async function completeReviewCheckRun(
  pool: Pool,
  params: {
    prSurface: PrSurface;
    owner: string;
    repo: string;
    prNumber: number;
    workItemId: string;
    resourceKey: string;
    reviewLens: AnyReviewLens;
    conclusion: ReviewCheckRunConclusion;
    summary: string;
    detailsUrl?: string;
  },
): Promise<boolean> {
  const checkRunId = await waitForReviewCheckRunGithubId(
    pool,
    params.workItemId,
    params.reviewLens,
  );
  if (checkRunId == null) return false;

  const completedAt = new Date().toISOString();
  const name = reviewCheckRunName();
  try {
    await params.prSurface.finishReviewCheck({
      checkRunId,
      conclusion: params.conclusion,
      summary: params.summary,
      detailsUrl: params.detailsUrl,
      name,
    });
  } catch (e) {
    logCheckRunWarning("review_check_run_complete_failed", e, {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId,
      conclusion: params.conclusion,
    });
    return false;
  }

  try {
    await recordReviewCheckRun(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      githubId: checkRunId,
      detail: {
        status: "completed",
        conclusion: params.conclusion,
        completedAt,
        detailsUrl: params.detailsUrl,
      },
    });
  } catch (e) {
    logWarn("review_check_run_complete_record_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId,
      conclusion: params.conclusion,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return true;
}
