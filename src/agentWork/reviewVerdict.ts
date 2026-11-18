import { decodeCheckRef } from "../github/prSurfaceResults.ts";
import type { Pool, PoolClient } from "pg";
import { logWarn } from "../evlog.ts";
import { isMissingActionsPermissionError } from "../github/actionsLogs.ts";
import { isDuplicateCheckRunCreationError } from "../github/githubErrors.ts";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.ts";
import type { PrSurface } from "../github/prSurface.ts";
import type { InstallationOperation } from "../github/installationCapabilities.ts";
import type { ReviewCheckRunConclusion } from "../github/reviewPublish.ts";
import {
  checkRunFindingsSummary,
  FINDING_INVENTORY_UNAVAILABLE_NOTE,
} from "../review/statusCopy.ts";
import type {
  FindingCheck,
  FindingCheckConclusion,
} from "../review/findingIdentity/findingLifecycle.ts";
import type { ReviewCoverage } from "../review/orchestrator/orchestratorTypes.ts";
import {
  type AnyReviewLens,
  DEFERRED_HEAD_SHA,
  REVIEW_CHECK_RUN_RESERVATION_STALE_MS,
  REVIEW_CHECK_RUN_WAIT_FOR_ID_MS,
  REVIEW_CHECK_RUN_WAIT_POLL_MS,
} from "../settings/index.ts";
import {
  getReviewCheckRunGithubId,
  recordReviewCheckRun,
  releaseUnstartedReviewCheckRunReservation,
  reserveReviewCheckRun,
  getSummaryCommentGithubId,
} from "./publishRecordRepository.ts";
import { getWorkItemCore } from "./workItemStateRepository.ts";
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
} from "./publishRecordRepository.ts";
import {
  createPublishContext,
  reviewCheckOperationKey,
  throwIfExecutionAborted,
  publishOnce,
  reviewCommitStatusOperationKey,
} from "./publishOnce.ts";
import type { WorkStatus } from "./types.ts";
import { errorMessage } from "../errors/errorMessage.ts";
import { getOperationIntent, reconcileOperationIntent } from "./operationIntentRepository.ts";
import { isRecord } from "../util/typeGuards.ts";
import { fenceForEpoch } from "./writeFence.ts";

function hasAccess(surface: PrSurface, operation: InstallationOperation) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    surface.capabilities == null || surface.capabilities.access(operation) === "available",
  );
}

function acceptedIntent(
  intent: { readonly status: string; readonly detail: Record<string, unknown> } | null,
) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    intent != null &&
      (Object.hasOwn(intent.detail, "__result") ||
        (intent.status === "reconciled" && intent.detail.reconciledFromPublishRecord !== true)),
  );
}

export const REVIEW_CHECK_RUN_CANCELLED_SUMMARY = "Review was cancelled before completion.";

function leaseEpochParam(epoch: number | null | undefined) {
  return ((pinnedReturn: { readonly leaseEpoch: number } | Record<string, never>) => pinnedReturn)(
    epoch == null ? {} : { leaseEpoch: epoch },
  );
}

export async function waitForReviewCheckRunGithubId(
  pool: Pool,
  workItemId: string,
  reviewLens: AnyReviewLens,
  options?: { timeoutMs?: number; pollMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? REVIEW_CHECK_RUN_WAIT_FOR_ID_MS;
  const pollMs = options?.pollMs ?? REVIEW_CHECK_RUN_WAIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await getReviewCheckRunGithubId(pool, workItemId, reviewLens);
    if (id != null)
      return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(id);
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(
    getReviewCheckRunGithubId(pool, workItemId, reviewLens),
  );
}

function logCheckRunWarning(
  event: string,
  error: unknown,
  fields: Record<string, string | number | undefined>,
) {
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

export function reviewCheckRunName() {
  return ((pinnedReturn: string) => pinnedReturn)("PR Agent Review");
}

export function reviewCheckDetailsUrl(
  owner: string,
  repo: string,
  prNumber: number,
  summaryCommentId?: string | number | null,
) {
  if (summaryCommentId == null)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${summaryCommentId}`,
  );
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
) {
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
  if (reserved)
    return ((pinnedReturn: CheckRunReservationOutcome | Promise<CheckRunReservationOutcome>) =>
      pinnedReturn)({ kind: "reserved" });
  return ((pinnedReturn: CheckRunReservationOutcome | Promise<CheckRunReservationOutcome>) =>
    pinnedReturn)(recoverStaleReservationOrWaitForPeer(pool, params, name));
}

async function recoverStaleReservationOrWaitForPeer(
  pool: Pool,
  params: EnsureReviewCheckRunParams,
  name: string,
) {
  const existingAfterReserve = await getReviewCheckRunGithubId(
    pool,
    params.workItemId,
    params.reviewLens,
  );
  if (existingAfterReserve != null)
    return ((pinnedReturn: CheckRunReservationOutcome | Promise<CheckRunReservationOutcome>) =>
      pinnedReturn)({ kind: "existing", githubId: existingAfterReserve });

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
    return ((pinnedReturn: CheckRunReservationOutcome | Promise<CheckRunReservationOutcome>) =>
      pinnedReturn)({ kind: "resolved", githubId });
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
  if (reservedAfterRecovery)
    return ((pinnedReturn: CheckRunReservationOutcome | Promise<CheckRunReservationOutcome>) =>
      pinnedReturn)({ kind: "reserved" });

  const githubId = await getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
  return ((pinnedReturn: CheckRunReservationOutcome | Promise<CheckRunReservationOutcome>) =>
    pinnedReturn)({ kind: "resolved", githubId });
}

async function createGithubCheckRunOnSurface(pool: Pool, params: EnsureReviewCheckRunParams) {
  const name = reviewCheckRunName();
  const operationKey = reviewCheckOperationKey(params.workItemId);
  try {
    throwIfExecutionAborted(params.signal, { workItemId: params.workItemId, operationKey });
    return ((pinnedReturn: (GithubCheckRunRef | null) | Promise<GithubCheckRunRef | null>) =>
      pinnedReturn)(
      await publishOnce<GithubCheckRunRef>({
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
      }),
    );
  } catch (createError) {
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
    return ((pinnedReturn: (GithubCheckRunRef | null) | Promise<GithubCheckRunRef | null>) =>
      pinnedReturn)(null);
  }
}

async function cancelOrphanedCheckRunAfterRecordFailure(
  params: EnsureReviewCheckRunParams,
  name: string,
  check: GithubCheckRunRef,
  recordError: unknown,
) {
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
) {
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
    return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(null);
  }
  return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(check.id);
}

async function ensureReviewCheckRunStarted(pool: Pool, params: EnsureReviewCheckRunParams) {
  const existing = await getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
  if (existing != null)
    return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(existing);
  const record = await getOwnVerdictCloseRecord(pool, params);
  if (record?.checkState === "skipped-for-this-run")
    return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(null);
  if (!hasAccess(params.prSurface, "checksWrite") || !hasAccess(params.prSurface, "checksRead"))
    return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(null);

  const name = reviewCheckRunName();
  const reservation = await reserveReviewCheckRunSlot(pool, params, name);
  if (reservation.kind !== "reserved")
    return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(
      reservation.githubId,
    );

  const check = await createGithubCheckRunOnSurface(pool, params);
  if (check == null)
    return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(null);

  return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(
    recordCreatedCheckRunOrCleanup(pool, params, name, check),
  );
}

async function applyReviewCheckRunCompletion(
  client: Pool | PoolClient,
  params: ReviewVerdictParams,
  checkRunId: number,
  selected: SelectedOwnVerdict,
) {
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
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
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
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(true);
}

async function completeSelectedCheck(client: Pool | PoolClient, params: ReviewVerdictParams) {
  const record = await getOwnVerdictCloseRecord(client, params);
  if (record?.legacyClosed || record?.checkApplied)
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(true);
  if (record?.selected == null)
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  if (record.checkState === "skipped-for-this-run")
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
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
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(true);
  }
  if (
    (parent?.status === "outcome_unknown" && parent.detail.unknownResolution === "terminal") ||
    (child?.status === "outcome_unknown" && child.detail.unknownResolution === "terminal")
  )
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
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
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  }
  const applied = await applyReviewCheckRunCompletion(client, params, id, selected);
  if (!applied)
    await recordOwnVerdictSurfaceState(client, { ...params, selected }, "check", "unresolved");
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(applied);
}

export type ReviewCommitStatusState = "pending" | "success" | "failure" | "error";

export type OwnVerdictOutcome =
  | (FindingCheck & { readonly kind: "published"; readonly summary?: string })
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

const PUBLISHED_COMMIT_STATUS = {
  failure: "failure",
  neutral: "error",
  success: "success",
} as const satisfies Record<FindingCheckConclusion, OwnVerdictSurfaces["commitStatus"]>;

export function ownVerdictSurfaces(outcome: OwnVerdictOutcome) {
  switch (outcome.kind) {
    case "published":
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)({
        checkRun: outcome.conclusion,
        commitStatus: PUBLISHED_COMMIT_STATUS[outcome.conclusion],
        summary:
          outcome.summary ??
          (outcome.conclusion === "neutral"
            ? FINDING_INVENTORY_UNAVAILABLE_NOTE
            : checkRunFindingsSummary(outcome.blockingCount)),
      });
    case "partial":
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)({
        checkRun: "neutral",
        commitStatus: "error",
        summary: outcome.note,
      });
    case "cancelled":
    case "superseded":
    case "stale_head":
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)({
        checkRun: "cancelled",
        commitStatus: "error",
        summary: outcome.summary ?? DEFAULT_SUMMARIES[outcome.kind],
      });
    case "crashed":
    case "not_published":
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)({
        checkRun: "action_required",
        commitStatus: "error",
        summary: outcome.summary ?? DEFAULT_SUMMARIES[outcome.kind],
      });
    default: {
      const _exhaustive: never = outcome;
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)(_exhaustive);
    }
  }
}

function isTerminalWorkStatus(status: WorkStatus) {
  switch (status) {
    case "queued":
    case "running":
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
    case "superseded":
    case "cancelled":
    case "completed":
    case "failed":
      return ((pinnedReturn: boolean) => pinnedReturn)(true);
    default: {
      const _exhaustive: never = status;
      return ((pinnedReturn: boolean) => pinnedReturn)(_exhaustive);
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
  readonly leaseEpoch?: number | null;
  readonly signal?: AbortSignal;
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

async function writeOwnCommitStatus(params: OwnCommitStatusParams) {
  if (params.headSha === DEFERRED_HEAD_SHA || params.headSha.length === 0)
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  const operationKey = reviewCommitStatusOperationKey(
    params.resourceKey,
    params.headSha,
    params.state,
  );
  const retained = await getOperationIntent(params.pool, params.workItemId, operationKey);
  if (!acceptedIntent(retained) && !hasAccess(params.prSurface, "statusesWrite"))
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  if (
    !acceptedIntent(retained) &&
    (await hasUnresolvedDelegatedOwnStatus(params.pool, params.workItemId, operationKey))
  )
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
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
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(true);
  } catch (error) {
    logWarn("review_commit_status_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      headSha: params.headSha,
      state: params.state,
      message: errorMessage(error),
    });
    return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(false);
  }
}

async function closeReviewVerdict(params: CloseReviewVerdictParams) {
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
) {
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

export function ownCheckCloseIsTerminal(
  intent: { readonly status: string; readonly detail: Record<string, unknown> } | null | undefined,
) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    intent?.status === "outcome_unknown" && intent.detail.unknownResolution === "terminal",
  );
}

export async function ownCheckCloseIntents(
  client: Pool | PoolClient,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly reviewLens: AnyReviewLens;
  },
) {
  const parent = await getOperationIntent(
    client,
    params.workItemId,
    ownVerdictCloseOperationKey(params),
  );
  const child = await getDelegatedOwnVerdictFinish(client, params);
  return ((
    pinnedReturn:
      | readonly (
          | { readonly status: string; readonly detail: Record<string, unknown> }
          | null
          | undefined
        )[]
      | Promise<
          readonly (
            | { readonly status: string; readonly detail: Record<string, unknown> }
            | null
            | undefined
          )[]
        >,
  ) => pinnedReturn)([parent, child]);
}

export function isOwnCheckOpen(
  detail: Record<string, unknown> | null,
  closeIntents?: readonly (
    | { readonly status: string; readonly detail: Record<string, unknown> }
    | null
    | undefined
  )[],
) {
  if (closeIntents?.some((intent) => ownCheckCloseIsTerminal(intent)))
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (detail == null) return ((pinnedReturn: boolean) => pinnedReturn)(true);
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
    return ((pinnedReturn: boolean) => pinnedReturn)(!checkResolved || !statusResolved);
  }
  if (detail.status === "in_progress") return ((pinnedReturn: boolean) => pinnedReturn)(true);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    typeof detail.conclusion !== "string" || detail.conclusion.length === 0,
  );
}

export function asTerminalOwnCheckStatus(status: string) {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
      return ((pinnedReturn: TerminalOwnCheckStatus | null) => pinnedReturn)(status);
    default:
      return ((pinnedReturn: TerminalOwnCheckStatus | null) => pinnedReturn)(null);
  }
}

function storedBlockingCount(detail: Record<string, unknown>) {
  const count = detail.ownBlockingCount;
  return ((pinnedReturn: number) => pinnedReturn)(
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 1,
  );
}

export function summaryCommentVerdictMeta(params: {
  readonly kind: "published" | "partial";
  readonly note?: string;
  readonly conclusion: FindingCheckConclusion;
  readonly partialReason?: "unjudged" | "specialists" | "unread";
  readonly blockingCount?: number;
  readonly checkFailSeverity: "P0" | "P1" | "P2" | "P3";
}) {
  const check = {
    ownCheckFailing: params.conclusion === "failure",
    ...(params.conclusion === "neutral" ? { ownCheckIncomplete: true as const } : {}),
    ...(params.blockingCount != null &&
    Number.isSafeInteger(params.blockingCount) &&
    params.blockingCount >= 0
      ? { ownBlockingCount: params.blockingCount }
      : {}),
  };
  const recorded = { ...check, ownCheckFailSeverity: params.checkFailSeverity };
  if (params.kind === "partial") {
    return ((pinnedReturn: {
      readonly ownVerdictKind: "published" | "partial";
      readonly ownVerdictNote?: string;
      readonly ownPartialReason?: "unjudged" | "specialists" | "unread";
      readonly ownCheckFailing: boolean;
      readonly ownCheckIncomplete?: true;
      readonly ownBlockingCount?: number;
      readonly ownCheckFailSeverity: "P0" | "P1" | "P2" | "P3";
    }) => pinnedReturn)({
      ownVerdictKind: "partial",
      ...(params.note != null && params.note.length > 0 ? { ownVerdictNote: params.note } : {}),
      ...(params.partialReason != null ? { ownPartialReason: params.partialReason } : {}),
      ...recorded,
    });
  }
  return ((pinnedReturn: {
    readonly ownVerdictKind: "published" | "partial";
    readonly ownVerdictNote?: string;
    readonly ownPartialReason?: "unjudged" | "specialists" | "unread";
    readonly ownCheckFailing: boolean;
    readonly ownCheckIncomplete?: true;
    readonly ownBlockingCount?: number;
    readonly ownCheckFailSeverity: "P0" | "P1" | "P2" | "P3";
  }) => pinnedReturn)({
    ownVerdictKind: "published",
    ...(params.partialReason != null ? { ownPartialReason: params.partialReason } : {}),
    ...recorded,
  });
}

export type GithubReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export function githubReviewEventFromCloseOutcome(outcome: OwnVerdictOutcome) {
  switch (outcome.kind) {
    case "published":
      switch (outcome.conclusion) {
        case "failure":
          return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("REQUEST_CHANGES");
        case "success":
          return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("APPROVE");
        case "neutral":
          return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("COMMENT");
        default: {
          const _exhaustive: never = outcome.conclusion;
          return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)(_exhaustive);
        }
      }
    case "partial":
      return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("COMMENT");
    case "cancelled":
    case "superseded":
    case "stale_head":
    case "crashed":
    case "not_published":
      return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)(undefined);
    default: {
      const _exhaustive: never = outcome;
      return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)(_exhaustive);
    }
  }
}

export function closeOutcomeForCoverage(
  coverage: ReviewCoverage | undefined,
  check: FindingCheck | undefined,
) {
  if (coverage?.kind === "partial") {
    if (check?.conclusion === "failure") {
      return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
        kind: "published",
        conclusion: "failure",
        blockingCount: check.blockingCount,
      });
    }
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
      kind: "partial",
      note: coverage.note,
    });
  }
  if (check != null)
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({ kind: "published", ...check });
  return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({ kind: "not_published" });
}

export function ownVerdictFromSummaryDetail(detail: Record<string, unknown> | null) {
  if (detail == null)
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({ kind: "not_published" });
  if (
    (detail.ownPartialReason === "unjudged" ||
      detail.ownPartialReason === "unread" ||
      detail.ownPartialReason === "specialists") &&
    detail.ownCheckFailing === true
  ) {
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
      kind: "published",
      conclusion: "failure",
      blockingCount: storedBlockingCount(detail),
    });
  }
  if (detail.ownVerdictKind === "partial") {
    const note =
      typeof detail.ownVerdictNote === "string" && detail.ownVerdictNote.length > 0
        ? detail.ownVerdictNote
        : "Partial specialist coverage.";
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({ kind: "partial", note });
  }
  if (detail.ownCheckFailing === true)
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
      kind: "published",
      conclusion: "failure",
      blockingCount: storedBlockingCount(detail),
    });
  if (detail.ownCheckIncomplete === true)
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
      kind: "published",
      conclusion: "neutral",
      blockingCount: 0,
    });
  return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
    kind: "published",
    conclusion: "success",
    blockingCount: 0,
  });
}

async function resolveOwnVerdictForTerminalReview(params: {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly reviewLens: AnyReviewLens;
  readonly status: TerminalOwnCheckStatus;
}) {
  switch (params.status) {
    case "failed":
      return ((pinnedReturn: OwnVerdictOutcome | Promise<OwnVerdictOutcome>) => pinnedReturn)({
        kind: "crashed",
      });
    case "cancelled":
      return ((pinnedReturn: OwnVerdictOutcome | Promise<OwnVerdictOutcome>) => pinnedReturn)({
        kind: "cancelled",
      });
    case "superseded":
      return ((pinnedReturn: OwnVerdictOutcome | Promise<OwnVerdictOutcome>) => pinnedReturn)({
        kind: "superseded",
      });
    case "completed": {
      const summary = await createPublishContext(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
      }).completed("summary_comment");
      if (summary == null)
        return ((pinnedReturn: OwnVerdictOutcome | Promise<OwnVerdictOutcome>) => pinnedReturn)({
          kind: "not_published",
        });
      return ((pinnedReturn: OwnVerdictOutcome | Promise<OwnVerdictOutcome>) => pinnedReturn)(
        ownVerdictFromSummaryDetail(summary),
      );
    }
    default: {
      const _exhaustive: never = params.status;
      return ((pinnedReturn: OwnVerdictOutcome | Promise<OwnVerdictOutcome>) => pinnedReturn)(
        _exhaustive,
      );
    }
  }
}

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
  const close = async (outcome: OwnVerdictOutcome) => {
    await closeReviewVerdict({ ...params, outcome, detailsUrl: await detailsUrl() });
  };
  return {
    async pending() {
      const checkId = await ensureReviewCheckRunStarted(params.pool, params);
      if (params.commitStatusEnabled)
        await writeOwnCommitStatus({
          ...params,
          state: "pending",
          description: "PR Agent review is in progress.",
          targetUrl: await detailsUrl(),
        });
      return ((pinnedReturn: (number | null) | Promise<number | null>) => pinnedReturn)(checkId);
    },
    close,
    async repairIfOpen() {
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
      const closeIntents = await ownCheckCloseIntents(params.pool, params);
      if (record?.selected == null && !isOwnCheckOpen(detail, closeIntents)) return;
      const core = await getWorkItemCore(params.pool, params.workItemId);
      const status = core == null ? null : asTerminalOwnCheckStatus(core.status);
      if (status == null) return;
      await close(await resolveOwnVerdictForTerminalReview({ ...params, status }));
    },
  };
}
