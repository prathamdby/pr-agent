import type { Pool, PoolClient } from "pg";
import { AppError } from "../errors/appError.js";
import { logWarn } from "../evlog.js";
import { isMissingActionsPermissionError } from "../github/actionsLogs.js";
import { isDuplicateCheckRunCreationError } from "../github/githubErrors.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import type { PrSurface } from "../github/prSurface.js";
import type { ReviewCheckRunConclusion } from "../github/reviewPublish.js";
import { checkRunFindingsSummary } from "../review/statusCopy.js";
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
import {
  claimOwnVerdict,
  getDelegatedOwnVerdictFinish,
  getOwnVerdictCloseRecord,
  ownVerdictCloseOperationKey,
  recordOwnVerdictSurfaceApplied,
  withOwnVerdictClose,
  type SelectedOwnVerdict,
} from "./publishRecordRepository.js";
import {
  mergeOperationIntentDetail,
  persistOperationIntent,
  reconcileOperationIntent,
} from "./operationIntentRepository.js";
import {
  reviewCheckOperationKey,
  throwIfExecutionAborted,
  withOperationIntent,
} from "./withOperationIntent.js";

export const REVIEW_CHECK_RUN_CANCELLED_SUMMARY = "Review was cancelled before completion.";

function leaseEpochParam(
  epoch: number | null | undefined,
): { readonly leaseEpoch: number } | Record<string, never> {
  return epoch == null ? {} : { leaseEpoch: epoch };
}

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
  // Missing Checks (403) is an install-permission miss. 404 is a missing run.
  if (
    isMissingActionsPermissionError(error) ||
    (error instanceof Error && isMissingActionsPermissionError(error.cause))
  ) {
    return;
  }
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
  leaseEpoch?: number | null;
  /** Gates starting a check only. An accepted check is still recorded after an abort. */
  signal?: AbortSignal;
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
    ...leaseEpochParam(params.leaseEpoch),
    detail: {
      status: "starting",
      headSha: params.headSha,
      name,
      externalId: params.workItemId,
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
    ...leaseEpochParam(params.leaseEpoch),
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
    ...leaseEpochParam(params.leaseEpoch),
    detail: {
      status: "starting",
      headSha: params.headSha,
      name,
      externalId: params.workItemId,
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
  const name = reviewCheckRunName();
  const operationKey = reviewCheckOperationKey(params.workItemId);
  try {
    throwIfExecutionAborted(params.signal, { workItemId: params.workItemId, operationKey });
    // The signal stays out of withOperationIntent: its after-mutate check would
    // drop the stash for a check GitHub already accepted.
    return await withOperationIntent<GithubCheckRunRef>({
      client: pool,
      workItemId: params.workItemId,
      operationKey,
      mutationKind: "github.review_check_run",
      ...leaseEpochParam(params.leaseEpoch),
      detail: {
        step: "check_run",
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
        headSha: params.headSha,
        externalId: params.workItemId,
        name,
      },
      recover: async () => {
        const found = await params.prSurface.findReviewCheck(params.headSha, params.workItemId);
        return found == null
          ? { kind: "absent" as const }
          : { kind: "reconciled" as const, value: found };
      },
      isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
      mutate: () =>
        params.prSurface.startReviewCheck(
          params.headSha,
          params.workItemId,
          "PR Agent review is in progress.",
        ),
    });
  } catch (createError) {
    // Proven duplicate recovery lives in prSurfaceImpl.startReviewCheck.
    await releaseUnstartedReviewCheckRunReservation(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      ...leaseEpochParam(params.leaseEpoch),
    });
    if (params.signal?.aborted) throw createError;
    const event = isDuplicateCheckRunCreationError(createError)
      ? "review_check_run_start_duplicate_unresolved"
      : "review_check_run_start_failed";
    logCheckRunWarning(event, createError, {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      ...leaseEpochParam(params.leaseEpoch),
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
      ...leaseEpochParam(params.leaseEpoch),
      detail: {
        status: "in_progress",
        headSha: params.headSha,
        name,
        externalId: params.workItemId,
        htmlUrl: check.url,
      },
    });
  } catch (e) {
    await cancelOrphanedCheckRunAfterRecordFailure(params, name, check, e);
    await releaseUnstartedReviewCheckRunReservation(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      ...leaseEpochParam(params.leaseEpoch),
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

type CompleteReviewCheckRunParams = {
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  workItemId: string;
  resourceKey: string;
  reviewLens: AnyReviewLens;
  leaseEpoch?: number | null;
  conclusion: ReviewCheckRunConclusion;
  summary: string;
  detailsUrl?: string;
  /** Only the combined writer passes the client while it owns the close mutex. */
  closeClient?: PoolClient;
};

async function applyReviewCheckRunCompletion(
  client: Pool | PoolClient,
  params: CompleteReviewCheckRunParams,
  checkRunId: number,
  selected: SelectedOwnVerdict,
): Promise<boolean> {
  const operationKey = ownVerdictCloseOperationKey(params);
  const output = {
    checkRunId,
    conclusion: selected.conclusion,
    summary: selected.summary,
    detailsUrl: selected.detailsUrl,
    name: reviewCheckRunName(),
  };
  const childEvidence = () => getDelegatedOwnVerdictFinish(client, params);
  let delegated = false;
  let provenNoAcceptance = false;
  try {
    const parent = await persistOperationIntent(client, {
      workItemId: params.workItemId,
      operationKey,
      mutationKind: "github.review_check_run_close",
      leaseEpoch: params.leaseEpoch,
      detail: {
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
        delegationEntered: false,
      },
    });
    if (parent.status === "failed")
      await mergeOperationIntentDetail(client, {
        workItemId: params.workItemId,
        operationKey,
        leaseEpoch: params.leaseEpoch,
        detail: { delegationEntered: false, __mutating: false },
      });
    if (
      parent.status === "pending" &&
      parent.detail.__mutating === true &&
      parent.detail.delegationEntered === false &&
      !Object.hasOwn(parent.detail, "__result")
    ) {
      await reconcileOperationIntent(client, {
        workItemId: params.workItemId,
        operationKey,
        leaseEpoch: params.leaseEpoch,
        status: "failed",
        detail: { __mutating: false },
      });
    }
    await withOperationIntent<void>({
      client,
      workItemId: params.workItemId,
      operationKey,
      mutationKind: "github.review_check_run_close",
      leaseEpoch: params.leaseEpoch,
      allowsUndefinedResult: true,
      recover: async () => {
        const child = await childEvidence();
        return child != null &&
          (Object.hasOwn(child.detail, "__result") ||
            (child.status === "reconciled" && child.detail.reconciledFromPublishRecord !== true))
          ? { kind: "reconciled", value: undefined }
          : { kind: "absent" };
      },
      isKnownNoAcceptanceError: (error) =>
        !delegated || provenNoAcceptance || isKnownNoAcceptanceMutationError(error),
      mutate: async () => {
        const marked = await mergeOperationIntentDetail(client, {
          workItemId: params.workItemId,
          operationKey,
          leaseEpoch: params.leaseEpoch,
          detail: { delegationEntered: true },
        });
        if (marked == null)
          throw new AppError({
            code: "operation_intent.reconcile_no_row",
            message: "Own verdict delegation marker returned no row",
            context: { workItemId: params.workItemId },
          });
        delegated = true;
        try {
          await params.prSurface.finishReviewCheck(output);
        } catch (error) {
          const child = await childEvidence();
          provenNoAcceptance =
            child?.status === "failed" && !Object.hasOwn(child.detail, "__result");
          throw error;
        }
      },
    });
  } catch (e) {
    logCheckRunWarning("review_check_run_complete_failed", e, {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId,
      conclusion: selected.conclusion,
    });
    return false;
  }

  try {
    await recordOwnVerdictSurfaceApplied(client, { ...params, selected }, "check");
  } catch (e) {
    logWarn("review_check_run_complete_record_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId,
      conclusion: selected.conclusion,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return true;
}

export async function completeReviewCheckRun(
  pool: Pool,
  params: CompleteReviewCheckRunParams,
): Promise<boolean> {
  if (params.closeClient != null) return completeSelectedCheck(params.closeClient, params);
  const checkRunId = await waitForReviewCheckRunGithubId(
    pool,
    params.workItemId,
    params.reviewLens,
  );
  if (checkRunId == null) return false;
  return (
    (await withOwnVerdictClose(pool, params, async (client) => {
      const record = await claimOwnVerdict(client, {
        ...params,
        selected: {
          conclusion: params.conclusion,
          summary: params.summary,
          ...(params.detailsUrl == null ? {} : { detailsUrl: params.detailsUrl }),
        },
      });
      if (record == null) return false;
      return completeSelectedCheck(client, params, checkRunId);
    })) ?? false
  );
}

async function completeSelectedCheck(
  client: Pool | PoolClient,
  params: CompleteReviewCheckRunParams,
  checkRunId?: number,
): Promise<boolean> {
  const record = await getOwnVerdictCloseRecord(client, params);
  if (record?.legacyClosed || record?.checkApplied) return true;
  if (record?.selected == null) return false;
  const id =
    record.githubId ??
    checkRunId ??
    (await getReviewCheckRunGithubId(client, params.workItemId, params.reviewLens));
  if (id == null) return false;
  return applyReviewCheckRunCompletion(client, params, id, record.selected);
}

/** Finish the review check as `cancelled` from the stored publish record. */
export async function cancelReviewCheckRun(
  pool: Pool,
  params: {
    prSurface: PrSurface;
    owner: string;
    repo: string;
    prNumber: number;
    workItemId: string;
    resourceKey: string;
    reviewLens: AnyReviewLens;
    leaseEpoch?: number | null;
    headSha?: string;
    detailsUrl?: string;
    summary?: string;
    closeClient?: PoolClient;
  },
): Promise<boolean> {
  if (params.closeClient != null)
    return completeSelectedCheck(params.closeClient, {
      ...params,
      conclusion: "cancelled",
      summary: params.summary ?? REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
    });
  const checkRunId = await getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
  if (checkRunId == null) return false;
  const completion = {
    prSurface: params.prSurface,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: params.reviewLens,
    ...leaseEpochParam(params.leaseEpoch),
    conclusion: "cancelled",
    summary: params.summary ?? REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
    detailsUrl: params.detailsUrl,
  } satisfies CompleteReviewCheckRunParams;
  return (
    (await withOwnVerdictClose(pool, params, async (client) => {
      const record = await claimOwnVerdict(client, {
        ...params,
        selected: {
          conclusion: completion.conclusion,
          summary: completion.summary,
          ...(completion.detailsUrl == null ? {} : { detailsUrl: completion.detailsUrl }),
        },
      });
      if (record == null) return false;
      return completeSelectedCheck(client, completion, checkRunId);
    })) ?? false
  );
}
