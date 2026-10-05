import { decodeCheckRef } from "../github/prSurfaceResults.js";
import type { Pool, PoolClient } from "pg";
import { logWarn } from "../evlog.js";
import { isMissingActionsPermissionError } from "../github/actionsLogs.js";
import { isDuplicateCheckRunCreationError } from "../github/githubErrors.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import type { PrSurface } from "../github/prSurface.js";
import type { InstallationOperation } from "../github/installationCapabilities.js";
import type { ReviewCheckRunConclusion } from "../github/reviewPublish.js";
import { checkRunFindingsSummary } from "../review/statusCopy.js";
import { isCheckFailingSeverity, type ReviewFinding } from "../review/reviewSchema.js";
import {
  type AnyReviewLens,
  DEFERRED_HEAD_SHA,
  REVIEW_CHECK_RUN_RESERVATION_STALE_MS,
  REVIEW_CHECK_RUN_WAIT_FOR_ID_MS,
  REVIEW_CHECK_RUN_WAIT_POLL_MS,
} from "../settings/index.js";
import {
  getReviewCheckRunGithubId,
  recordReviewCheckRun,
  releaseUnstartedReviewCheckRunReservation,
  reserveReviewCheckRun,
  getSummaryCommentGithubId,
} from "./publishRecordRepository.js";
import { getWorkItemCore } from "./workItemStateRepository.js";
import {
  claimOwnVerdict,
  getDelegatedOwnVerdictFinish,
  getOwnVerdictCloseRecord,
  ownVerdictCloseOperationKey,
  recordOwnVerdictSurfaceApplied,
  withOwnVerdictClose,
  ownVerdictStatusApplicable,
  hasOwnVerdictSurfaceAcceptance,
  hasUnresolvedDelegatedOwnStatus,
  recordOwnVerdictSurfaceState,
  type SelectedOwnVerdict,
} from "./publishRecordRepository.js";
import {
  createPublishContext,
  reviewCheckOperationKey,
  throwIfExecutionAborted,
  publishOnce,
  reviewCommitStatusOperationKey,
} from "./publishOnce.js";
import type { WorkStatus } from "./types.js";
import { errorMessage } from "../errors/errorMessage.js";
import { getOperationIntent, reconcileOperationIntent } from "./operationIntentRepository.js";
import { isRecord } from "../util/typeGuards.js";
import { fenceForEpoch } from "./writeFence.js";

function hasAccess(surface: PrSurface, operation: InstallationOperation): boolean {
  return surface.capabilities == null || surface.capabilities.access(operation) === "available";
}

function acceptedIntent(
  intent: { readonly status: string; readonly detail: Record<string, unknown> } | null,
): boolean {
  return (
    intent != null &&
    (Object.hasOwn(intent.detail, "__result") ||
      (intent.status === "reconciled" && intent.detail.reconciledFromPublishRecord !== true))
  );
}

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
    message: errorMessage(error),
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
    // The signal stays out of publishOnce: its after-mutate check would
    // drop the stash for a check GitHub already accepted.
    return await publishOnce<GithubCheckRunRef>({
      decodeResult: decodeCheckRef,
      fence: fenceForEpoch(params.leaseEpoch),
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
        if (!hasAccess(params.prSurface, "checksRead"))
          throw new Error("Check acceptance cannot be read with current installation access");
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
    message: errorMessage(recordError),
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

async function ensureReviewCheckRunStarted(
  pool: Pool,
  params: EnsureReviewCheckRunParams,
): Promise<number | null> {
  const existing = await getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
  if (existing != null) return existing;
  const record = await getOwnVerdictCloseRecord(pool, params);
  if (record?.checkState === "skipped-for-this-run") return null;
  if (!hasAccess(params.prSurface, "checksWrite") || !hasAccess(params.prSurface, "checksRead"))
    return null;

  const name = reviewCheckRunName();
  const reservation = await reserveReviewCheckRunSlot(pool, params, name);
  if (reservation.kind !== "reserved") return reservation.githubId;

  const check = await createGithubCheckRunOnSurface(pool, params);
  if (check == null) return null;

  return recordCreatedCheckRunOrCleanup(pool, params, name, check);
}

async function applyReviewCheckRunCompletion(
  client: Pool | PoolClient,
  params: ReviewVerdictParams,
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
    await publishOnce<void>({
      fence: fenceForEpoch(params.leaseEpoch),
      client,
      workItemId: params.workItemId,
      operationKey,
      mutationKind: "github.review_check_run_close",
      delegation: { resourceKey: params.resourceKey, reviewLens: params.reviewLens },
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
      message: errorMessage(e),
    });
  }
  return true;
}

async function completeSelectedCheck(
  client: Pool | PoolClient,
  params: ReviewVerdictParams,
): Promise<boolean> {
  const record = await getOwnVerdictCloseRecord(client, params);
  if (record?.legacyClosed || record?.checkApplied) return true;
  if (record?.selected == null) return false;
  if (record.checkState === "skipped-for-this-run") return false;
  const selected = record.selected;
  const parent = await getOperationIntent(
    client,
    params.workItemId,
    ownVerdictCloseOperationKey(params),
  );
  const child = await getDelegatedOwnVerdictFinish(client, params);
  if (acceptedIntent(parent) || acceptedIntent(child)) {
    if (parent != null)
      await reconcileOperationIntent(client, {
        workItemId: params.workItemId,
        operationKey: ownVerdictCloseOperationKey(params),
        leaseEpoch: params.leaseEpoch,
        status: "reconciled",
        detail: { __result: null },
      });
    await recordOwnVerdictSurfaceApplied(client, { ...params, selected }, "check");
    return true;
  }
  let id =
    record.githubId ??
    (await getReviewCheckRunGithubId(client, params.workItemId, params.reviewLens));
  const applicable = id != null || (await hasOwnVerdictSurfaceAcceptance(client, params, "check"));
  if (id == null && applicable) {
    const start = await getOperationIntent(
      client,
      params.workItemId,
      reviewCheckOperationKey(params.workItemId),
    );
    const result = start?.detail.__result;
    let recovered: GithubCheckRunRef | null =
      isRecord(result) &&
      typeof result.id === "number" &&
      Number.isSafeInteger(result.id) &&
      result.id > 0
        ? { id: result.id, url: typeof result.url === "string" ? result.url : null }
        : null;
    if (recovered == null && hasAccess(params.prSurface, "checksRead")) {
      try {
        recovered = await params.prSurface.findReviewCheck(params.headSha, params.workItemId);
      } catch (error) {
        logCheckRunWarning("review_check_run_recovery_failed", error, {
          owner: params.owner,
          repo: params.repo,
          pr: params.prNumber,
        });
      }
    }
    if (recovered != null) {
      await recordReviewCheckRun(client, {
        ...params,
        githubId: recovered.id,
        detail: {
          status: "in_progress",
          headSha: params.headSha,
          externalId: params.workItemId,
          name: reviewCheckRunName(),
          htmlUrl: recovered.url,
        },
      });
      id = recovered.id;
    }
  }
  const available = hasAccess(params.prSurface, "checksWrite");
  if (!available || id == null) {
    await recordOwnVerdictSurfaceState(
      client,
      { ...params, selected },
      "check",
      applicable ? (available ? "unresolved" : "blocked") : "skipped-for-this-run",
    );
    return false;
  }
  const applied = await applyReviewCheckRunCompletion(client, params, id, selected);
  if (!applied)
    await recordOwnVerdictSurfaceState(client, { ...params, selected }, "check", "unresolved");
  return applied;
}

export type ReviewCommitStatusState = "pending" | "success" | "failure" | "error";

export type OwnVerdictOutcome =
  | {
      readonly kind: "published";
      readonly findings: readonly Pick<ReviewFinding, "severity">[];
      readonly summary?: string;
    }
  | { readonly kind: "partial"; readonly note: string }
  | { readonly kind: "cancelled"; readonly summary?: string }
  | { readonly kind: "superseded"; readonly summary?: string }
  | { readonly kind: "stale_head"; readonly summary?: string }
  | { readonly kind: "crashed"; readonly summary?: string }
  | { readonly kind: "not_published"; readonly summary?: string };

export type OwnVerdictSurfaces = {
  readonly checkRun: ReviewCheckRunConclusion;
  readonly commitStatus: Exclude<ReviewCommitStatusState, "pending">;
  readonly summary: string;
};

const DEFAULT_SUMMARIES = {
  cancelled: REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
  superseded: "Review publish was skipped because the work was superseded or cancelled.",
  stale_head: "Review was rescheduled for a newer pull request head.",
  crashed: "PR Agent could not complete the review after retries.",
  not_published: "PR Agent could not publish a structured review.",
} as const;

export function ownVerdictSurfaces(outcome: OwnVerdictOutcome): OwnVerdictSurfaces {
  switch (outcome.kind) {
    case "published": {
      const check = reviewCheckRunOutcome(outcome.findings);
      return {
        checkRun: check.conclusion,
        commitStatus: check.conclusion === "failure" ? "failure" : "success",
        summary: outcome.summary ?? check.summary,
      };
    }
    case "partial":
      return { checkRun: "neutral", commitStatus: "error", summary: outcome.note };
    case "cancelled":
    case "superseded":
    case "stale_head":
      return {
        checkRun: "cancelled",
        commitStatus: "error",
        summary: outcome.summary ?? DEFAULT_SUMMARIES[outcome.kind],
      };
    case "crashed":
    case "not_published":
      return {
        checkRun: "action_required",
        commitStatus: "error",
        summary: outcome.summary ?? DEFAULT_SUMMARIES[outcome.kind],
      };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function isTerminalWorkStatus(status: WorkStatus): boolean {
  switch (status) {
    case "queued":
    case "running":
      return false;
    case "superseded":
    case "cancelled":
    case "completed":
    case "failed":
      return true;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export type ReviewVerdictParams = {
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly reviewLens: AnyReviewLens;
  readonly headSha: string;
  readonly commitStatusEnabled: boolean;
  /** Null and omitted epochs are terminal-only for close, including acknowledgement. */
  readonly leaseEpoch?: number | null;
  readonly signal?: AbortSignal;
  /** A just-written notice can precede its durable record; null retains no-link output. */
  readonly summaryCommentId?: string | number | null;
};
type CloseReviewVerdictParams = ReviewVerdictParams & {
  readonly outcome: OwnVerdictOutcome;
  readonly detailsUrl?: string;
};

type OwnCommitStatusParams = {
  readonly pool: Pool | PoolClient;
  readonly prSurface: PrSurface;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly state: ReviewCommitStatusState;
  readonly description: string;
  readonly targetUrl?: string;
  readonly leaseEpoch?: number | null;
};

async function writeOwnCommitStatus(params: OwnCommitStatusParams): Promise<boolean> {
  if (params.headSha === DEFERRED_HEAD_SHA || params.headSha.length === 0) return false;
  const operationKey = reviewCommitStatusOperationKey(
    params.resourceKey,
    params.headSha,
    params.state,
  );
  const retained = await getOperationIntent(params.pool, params.workItemId, operationKey);
  // Exact saved acceptance is authority even after access is revoked.
  if (!acceptedIntent(retained) && !hasAccess(params.prSurface, "statusesWrite")) return false;
  if (
    !acceptedIntent(retained) &&
    (await hasUnresolvedDelegatedOwnStatus(params.pool, params.workItemId, operationKey))
  )
    return false;
  const status = {
    state: params.state,
    description: params.description,
    targetUrl: params.targetUrl,
  };
  try {
    await publishOnce<void>({
      fence: fenceForEpoch(params.leaseEpoch),
      client: params.pool,
      workItemId: params.workItemId,
      operationKey,
      mutationKind: "github.review_commit_status",
      leaseEpoch: params.leaseEpoch,
      allowsUndefinedResult: true,
      detail: {
        step: "commit_status",
        resourceKey: params.resourceKey,
        headSha: params.headSha,
        context: "pr-agent/review",
        ...status,
      },
      recover: async () => {
        if (acceptedIntent(retained)) return { kind: "reconciled" as const, value: undefined };
        if (!hasAccess(params.prSurface, "statusesRead"))
          throw new Error(
            "Commit status acceptance cannot be read with current installation access",
          );
        if (
          params.prSurface.getReviewCommitStatuses == null &&
          params.prSurface.capabilities != null
        )
          throw new Error("Statuses-only acceptance recovery is unavailable on this surface");
        const statuses =
          params.prSurface.getReviewCommitStatuses != null
            ? await params.prSurface.getReviewCommitStatuses(params.headSha)
            : (await params.prSurface.getCiStatus(params.headSha)).legacyStatuses;
        const found = statuses.some(
          (legacy) =>
            legacy.context === "pr-agent/review" &&
            legacy.state === status.state &&
            legacy.description === status.description &&
            legacy.targetUrl === (status.targetUrl ?? null),
        );
        return found
          ? { kind: "reconciled" as const, value: undefined }
          : { kind: "absent" as const };
      },
      isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
      mutate: () => params.prSurface.setReviewCommitStatus(params.headSha, status),
    });
    return true;
  } catch (error) {
    logWarn("review_commit_status_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      headSha: params.headSha,
      state: params.state,
      message: errorMessage(error),
    });
    return false;
  }
}

async function closeReviewVerdict(params: CloseReviewVerdictParams): Promise<void> {
  const leaseEpoch = params.leaseEpoch ?? null;
  if (leaseEpoch === null) {
    const core = await getWorkItemCore(params.pool, params.workItemId);
    if (core == null || !isTerminalWorkStatus(core.status)) return;
  }

  const surfaces = ownVerdictSurfaces(params.outcome);
  await withOwnVerdictClose(params.pool, { ...params, leaseEpoch }, async (client) => {
    const statusEnabled =
      params.commitStatusEnabled ||
      (await hasOwnVerdictSurfaceAcceptance(client, params, "status"));
    const record = await claimOwnVerdict(client, {
      ...params,
      leaseEpoch,
      selected: {
        conclusion: surfaces.checkRun,
        summary: surfaces.summary,
        ...(params.detailsUrl == null ? {} : { detailsUrl: params.detailsUrl }),
        status: {
          headSha: params.headSha,
          enabled: statusEnabled,
          state: surfaces.commitStatus,
        },
      },
    });
    const selected = record?.selected;
    if (record == null || selected == null) return;
    if (!record.checkApplied) await completeSelectedCheck(client, { ...params, leaseEpoch });
    if (
      !ownVerdictStatusApplicable(selected) ||
      record.statusApplied ||
      record.statusState === "skipped-for-this-run" ||
      selected.status == null
    )
      return;
    const applied = await writeOwnCommitStatus({
      pool: client,
      prSurface: params.prSurface,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: selected.status.headSha,
      state: selected.status.state,
      description: selected.summary,
      targetUrl: selected.detailsUrl,
      leaseEpoch,
    });
    if (applied)
      await recordOwnVerdictSurfaceApplied(client, { ...params, leaseEpoch, selected }, "status");
    else {
      const available = hasAccess(params.prSurface, "statusesWrite");
      const applicable = await hasOwnVerdictSurfaceAcceptance(client, params, "status");
      await recordOwnVerdictSurfaceState(
        client,
        { ...params, leaseEpoch, selected },
        "status",
        available ? "unresolved" : applicable ? "blocked" : "skipped-for-this-run",
      );
    }
  });
}

export async function closeReviewVerdictsForWorkItems(
  pool: Pool,
  params: {
    readonly prSurface: PrSurface;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly workItemIds: readonly string[];
    readonly commitStatusEnabled: boolean;
    readonly outcome: OwnVerdictOutcome;
  },
): Promise<void> {
  await Promise.all(
    params.workItemIds.map(async (workItemId) => {
      try {
        const core = await getWorkItemCore(pool, workItemId);
        if (core == null || core.type !== "review" || core.reviewLens == null) return;
        await reviewVerdict({
          pool,
          prSurface: params.prSurface,
          owner: params.owner,
          repo: params.repo,
          prNumber: params.prNumber,
          workItemId,
          resourceKey: core.resourceKey,
          reviewLens: core.reviewLens,
          headSha: core.headSha,
          commitStatusEnabled: params.commitStatusEnabled,
          leaseEpoch: null,
        }).close(params.outcome);
      } catch (error) {
        logWarn("review_check_run_cancel_item_failed", {
          owner: params.owner,
          repo: params.repo,
          pr: params.prNumber,
          workItemId,
          message: errorMessage(error),
        });
      }
    }),
  );
}

export type TerminalOwnCheckStatus = "completed" | "failed" | "cancelled" | "superseded";

/** GitHub finish is in `detail`, not `publish_records.status`. */
export function isOwnCheckOpen(detail: Record<string, unknown> | null): boolean {
  if (detail == null) return true;
  if (isRecord(detail.selectedOwnVerdict)) {
    const checkResolved =
      detail.ownCheckApplied === true || detail.ownCheckState === "skipped-for-this-run";
    const status = detail.selectedOwnVerdict.status;
    const statusApplicable =
      isRecord(status) &&
      status.enabled === true &&
      typeof status.headSha === "string" &&
      status.headSha.length > 0 &&
      status.headSha !== DEFERRED_HEAD_SHA;
    const statusResolved =
      !statusApplicable ||
      detail.ownStatusApplied === true ||
      detail.ownStatusState === "skipped-for-this-run";
    return !checkResolved || !statusResolved;
  }
  if (detail.status === "in_progress") return true;
  return typeof detail.conclusion !== "string" || detail.conclusion.length === 0;
}

export function asTerminalOwnCheckStatus(status: string): TerminalOwnCheckStatus | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
      return status;
    default:
      return null;
  }
}

export function summaryCommentVerdictMeta(params: {
  readonly kind: "published" | "partial";
  readonly note?: string;
  readonly findings: readonly Pick<ReviewFinding, "severity">[];
}): {
  readonly ownVerdictKind: "published" | "partial";
  readonly ownVerdictNote?: string;
  readonly ownCheckFailing: boolean;
} {
  const ownCheckFailing = params.findings.some((finding) =>
    isCheckFailingSeverity(finding.severity),
  );
  if (params.kind === "partial") {
    return {
      ownVerdictKind: "partial",
      ...(params.note != null && params.note.length > 0 ? { ownVerdictNote: params.note } : {}),
      ownCheckFailing,
    };
  }
  return { ownVerdictKind: "published", ownCheckFailing };
}

export function ownVerdictFromSummaryDetail(
  detail: Record<string, unknown> | null,
): OwnVerdictOutcome {
  if (detail == null) return { kind: "not_published" };
  if (detail.ownVerdictKind === "partial") {
    const note =
      typeof detail.ownVerdictNote === "string" && detail.ownVerdictNote.length > 0
        ? detail.ownVerdictNote
        : "Partial specialist coverage.";
    return { kind: "partial", note };
  }
  const findings: readonly Pick<ReviewFinding, "severity">[] =
    detail.ownCheckFailing === true ? [{ severity: "P1" }] : [];
  return { kind: "published", findings };
}

export async function resolveOwnVerdictForTerminalReview(params: {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly reviewLens: AnyReviewLens;
  readonly status: TerminalOwnCheckStatus;
}): Promise<OwnVerdictOutcome> {
  switch (params.status) {
    case "failed":
      return { kind: "crashed" };
    case "cancelled":
      return { kind: "cancelled" };
    case "superseded":
      return { kind: "superseded" };
    case "completed": {
      const summary = await createPublishContext(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
      }).completed("summary_comment");
      if (summary == null) return { kind: "not_published" };
      return ownVerdictFromSummaryDetail(summary);
    }
    default: {
      const _exhaustive: never = params.status;
      return _exhaustive;
    }
  }
}

/** Owns start, first-output selection, both acceptance receipts, and terminal repair. */
export function reviewVerdict(params: ReviewVerdictParams) {
  const detailsUrl = async () =>
    reviewCheckDetailsUrl(
      params.owner,
      params.repo,
      params.prNumber,
      params.summaryCommentId === undefined
        ? await getSummaryCommentGithubId(params.pool, params.resourceKey, params.reviewLens)
        : params.summaryCommentId,
    );
  const close = async (outcome: OwnVerdictOutcome): Promise<void> => {
    await closeReviewVerdict({ ...params, outcome, detailsUrl: await detailsUrl() });
  };
  return {
    async pending(): Promise<number | null> {
      const checkId = await ensureReviewCheckRunStarted(params.pool, params);
      if (params.commitStatusEnabled)
        await writeOwnCommitStatus({
          ...params,
          state: "pending",
          description: "PR Agent review is in progress.",
          targetUrl: await detailsUrl(),
        });
      return checkId;
    },
    close,
    async repairIfOpen(): Promise<void> {
      const record = await getOwnVerdictCloseRecord(params.pool, params);
      if (record?.legacyClosed) return;
      if (record?.selected != null) {
        const checkResolved = record.checkApplied || record.checkState === "skipped-for-this-run";
        const statusResolved =
          !ownVerdictStatusApplicable(record.selected) ||
          record.statusApplied ||
          record.statusState === "skipped-for-this-run";
        if (checkResolved && statusResolved) return;
      }
      const detail = await createPublishContext(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
      }).completed("check_run");
      if (record?.selected == null && !isOwnCheckOpen(detail)) return;
      const core = await getWorkItemCore(params.pool, params.workItemId);
      const status = core == null ? null : asTerminalOwnCheckStatus(core.status);
      if (status == null) return;
      await close(await resolveOwnVerdictForTerminalReview({ ...params, status }));
    },
  };
}
