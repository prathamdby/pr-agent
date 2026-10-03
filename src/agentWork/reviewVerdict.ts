import type { Pool, PoolClient } from "pg";
import { logWarn } from "../evlog.js";
import { isMissingActionsPermissionError } from "../github/actionsLogs.js";
import { isDuplicateCheckRunCreationError } from "../github/githubErrors.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import type { PrSurface } from "../github/prSurface.js";
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
  const id =
    record.githubId ??
    (await getReviewCheckRunGithubId(client, params.workItemId, params.reviewLens));
  if (id == null) return false;
  return applyReviewCheckRunCompletion(client, params, id, record.selected);
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
  const status = {
    state: params.state,
    description: params.description,
    targetUrl: params.targetUrl,
  };
  try {
    await publishOnce<void>({
      client: params.pool,
      workItemId: params.workItemId,
      operationKey: reviewCommitStatusOperationKey(
        params.resourceKey,
        params.headSha,
        params.state,
      ),
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
        const current = await params.prSurface.getCiStatus(params.headSha);
        const found = current.legacyStatuses.some(
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
    const record = await claimOwnVerdict(client, {
      ...params,
      leaseEpoch,
      selected: {
        conclusion: surfaces.checkRun,
        summary: surfaces.summary,
        ...(params.detailsUrl == null ? {} : { detailsUrl: params.detailsUrl }),
        status: {
          headSha: params.headSha,
          enabled: params.commitStatusEnabled,
          state: surfaces.commitStatus,
        },
      },
    });
    const selected = record?.selected;
    if (record == null || selected == null) return;
    if (!record.checkApplied) await completeSelectedCheck(client, { ...params, leaseEpoch });
    if (!ownVerdictStatusApplicable(selected) || record.statusApplied || selected.status == null)
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
      if (checkId != null && params.commitStatusEnabled)
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
      const detail = await createPublishContext(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
      }).completed("check_run");
      if (!isOwnCheckOpen(detail)) return;
      const core = await getWorkItemCore(params.pool, params.workItemId);
      const status = core == null ? null : asTerminalOwnCheckStatus(core.status);
      if (status == null) return;
      await close(await resolveOwnVerdictForTerminalReview({ ...params, status }));
    },
  };
}
