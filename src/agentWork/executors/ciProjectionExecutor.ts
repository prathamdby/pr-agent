import type { DatabaseSync } from "node:sqlite";
import type { InstallationSurface } from "../installationSurface.ts";
import {
  type Config,
  REVIEW_SUMMARY_SENTINEL,
  TRIAGE_SUMMARY_SENTINEL,
  VERIFICATION_PUBLISH_LENS,
  isAnyReviewLens,
  LEGACY_REVIEW_SUMMARY_SENTINELS,
} from "../../settings/index.ts";
import { logDebug, logWarn } from "../../evlog.ts";
import { type PrConversationComment, type PrSurface } from "../../github/prSurface.ts";
import {
  injectVerificationFailureIntoCiCell,
  renderVerificationFailureBlock,
  applyCiProjectionBodyUpdate,
  decideCiProjectionBodyUpdate,
  renderCiRollupMarker,
  replaceCiRollupMarkerIfNewer,
  renderCiSummaryCell,
  shouldRenderCiSummaryRow,
  formatReviewActionLineCiStatus,
} from "../../review/ci/ciSummaryCell.ts";
import type { CiSummaryAuthor } from "../../review/ci/ciAuthor.ts";
import { ciSummaryFromFacts, headCiFactsAreComplete } from "../../review/ci/ciFacts.ts";
import {
  parseReviewMetaFromCommentBody,
  parseProgressRevisionState,
} from "../../review/run/commentMarkers.ts";
import { captureCiStateChanged } from "../../analytics/workCompleted.ts";
import { authorHeadCiIfFactsChanged } from "../ciAuthoring.ts";
import {
  asPrNumbers,
  clearHeadCiProjectionRepair,
  headCiListingPhase,
  listPrNumbersForHeadFromRuns,
  listTerminalReviewsForHead,
  loadHeadCiProjectionRow,
  newestHeadShaForPr,
  refreshHeadCiFromSnapshot,
  requestHeadCiProjection,
  seedHeadCiFromSnapshot,
  storeHeadCiPrNumbers,
  type HeadCiProjectionRow,
} from "../../state/prHeadCiState.ts";
import {
  latestPublishStep,
  progressCommentOwner,
  workRunStatus,
  type FeaturePublication,
} from "../../state/featurePublication.ts";
import { isRateLimitCircuitOpen, readRateLimitCircuit } from "../../state/rateLimitCircuits.ts";
import { prResourceKey, type CiProjectionJobData } from "../types.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import {
  loadGithubCapabilityObservation,
  loadGithubCiSourceAvailability,
  recordGithubCiSourceRead,
  recordGithubCapabilityDenial,
  saveGithubCapabilityObservation,
  nextGithubCapabilityObservationGeneration,
  type GithubCiSourceAvailability,
} from "../../state/githubCapabilities.ts";
import {
  capabilityObservationUnconfirmed,
  createReviewCapabilityPolicy,
  unknownInstallationCapabilities,
} from "../../github/installationCapabilities.ts";
import type { CiStatusSourcesResult } from "../../github/ciStatus.ts";
import { ciSourcesComplete } from "../../review/ci/ciFacts.ts";
import { passthroughMutationBoundary } from "./featureCapabilities.ts";
import type { FeatureSessionFactory, ReviewSurfacePublisher } from "./featureExecution.ts";

export type CiProjectionDependencies = {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly installationSurface: InstallationSurface;
  readonly publication: FeaturePublication;
  readonly reviewPublisher?: ReviewSurfacePublisher;
  readonly createSession?: FeatureSessionFactory;
  readonly now: () => number;
};

const TERMINAL_OWN_CHECK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

const SUMMARY_SENTINELS = [REVIEW_SUMMARY_SENTINEL, ...LEGACY_REVIEW_SUMMARY_SENTINELS] as const;

const PENDING_CI_REFRESH_RETRY_SECONDS = 5;

export type CiProjectionSurfaceFactory = (prNumber: number) => Promise<PrSurface>;

export type CiProjectionPrResult = "current" | "updated" | "retry" | "irrelevant";

async function resolvePrNumbers(params: {
  readonly db: DatabaseSync;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly stored: unknown;
  readonly listPulls: () => Promise<readonly { readonly number: number }[]>;
}) {
  const stored = asPrNumbers(params.stored);
  const fromWork = listPrNumbersForHeadFromRuns(params.db, params);
  const pulls = await params.listPulls();
  return ((pinnedReturn: number[] | Promise<number[]>) => pinnedReturn)([
    ...new Set([...stored, ...fromWork, ...pulls.map((pull) => pull.number).filter((n) => n > 0)]),
  ]);
}

async function reconcileOwnVerdicts(params: {
  readonly deps: CiProjectionDependencies;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
}) {
  const publisher = params.deps.reviewPublisher;
  if (publisher === undefined) return;
  const items = listTerminalReviewsForHead(params.deps.db, {
    prKey: prResourceKey(params.owner, params.repo, params.prNumber),
    prNumber: params.prNumber,
    headSha: params.headSha,
  });
  for (const item of items) {
    if (!isAnyReviewLens(item.reviewLens)) continue;
    try {
      await publisher.repairOwnVerdictIfOpen({
        publication: params.deps.publication,
        prSurface: params.prSurface,
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        commitStatusEnabled: params.deps.cfg.features.commitStatus,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens: item.reviewLens,
        headSha: params.headSha,
      });
    } catch (error) {
      logWarn("ci_projection_own_verdict_failed", {
        workItemId: item.id,
        resourceKey: item.resourceKey,
        message: errorMessage(error),
      });
    }
  }
}

function verificationFailureActive(db: DatabaseSync, resourceKey: string, headSha: string) {
  const detail = latestPublishStep(
    db,
    resourceKey,
    VERIFICATION_PUBLISH_LENS,
    "verification_failure",
  );
  if (detail == null) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (detail.active === false) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(detail.headSha === headSha);
}

function editCommentOnce(params: {
  readonly publication: FeaturePublication;
  readonly prSurface: PrSurface;
  readonly resourceKey: string;
  readonly commentId: number;
  readonly body: string;
  readonly operation: string;
}) {
  return params.publication.once({
    decodeResult: () => undefined,
    allowsUndefinedResult: true,
    prKey: params.resourceKey,
    resourceTarget: `comment:${params.commentId}`,
    blocksOverwrite: true,
    operationKey: `ci_projection:${params.operation}:${params.commentId}`,
    mutationKind: "github.ci_projection_comment_edit",
    mutate: () => params.prSurface.editComment(params.commentId, params.body),
  });
}

function renderProjectedCell(row: HeadCiProjectionRow, injectFailure: boolean) {
  const rendered = ciSummaryFromFacts(row.checks, row.version, row.authored, {
    checkRunsComplete: headCiFactsAreComplete(row.rollup),
    sourceAvailability: row.sourceAvailability,
  });
  if (!shouldRenderCiSummaryRow(rendered.summary))
    return ((pinnedReturn: string | null) => pinnedReturn)(null);
  let cell = renderCiSummaryCell(rendered.summary, row.headSha, rendered.version);
  if (injectFailure)
    cell = injectVerificationFailureIntoCiCell(cell, renderVerificationFailureBlock());
  return ((pinnedReturn: string | null) => pinnedReturn)(cell);
}

function projectedActionPhrase(row: HeadCiProjectionRow) {
  const rendered = ciSummaryFromFacts(row.checks, row.version, row.authored, {
    checkRunsComplete: headCiFactsAreComplete(row.rollup),
    sourceAvailability: row.sourceAvailability,
  });
  return ((pinnedReturn: string) => pinnedReturn)(formatReviewActionLineCiStatus(rendered.summary));
}

async function patchTriageRollupComments(params: {
  readonly publication: FeaturePublication;
  readonly comments: readonly PrConversationComment[];
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly version: number;
  readonly rollup: HeadCiProjectionRow["rollup"];
}) {
  const nextMarker = renderCiRollupMarker(params.headSha, params.version, params.rollup);
  const targets = params.comments.filter((comment) =>
    comment.body.startsWith(TRIAGE_SUMMARY_SENTINEL),
  );
  let updated = false;
  for (const comment of targets) {
    const writeBody = replaceCiRollupMarkerIfNewer(
      comment.body,
      nextMarker,
      params.headSha,
      params.version,
    );
    if (writeBody == null) continue;
    try {
      await editCommentOnce({
        publication: params.publication,
        prSurface: params.prSurface,
        resourceKey: prResourceKey(params.owner, params.repo, params.prNumber),
        commentId: comment.id,
        body: writeBody,
        operation: `triage_rollup:${params.headSha}:${params.version}`,
      });
      updated = true;
    } catch (error) {
      logWarn("ci_projection_triage_rollup_failed", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        commentId: comment.id,
        message: errorMessage(error),
      });
      return ((
        pinnedReturn: ("updated" | "current" | "retry") | Promise<"updated" | "current" | "retry">,
      ) => pinnedReturn)("retry");
    }
  }
  return ((
    pinnedReturn: ("updated" | "current" | "retry") | Promise<"updated" | "current" | "retry">,
  ) => pinnedReturn)(updated ? "updated" : "current");
}

function findHeadSummaryComments(comments: readonly PrConversationComment[], headSha: string) {
  return ((pinnedReturn: PrConversationComment[]) => pinnedReturn)(
    comments.filter((comment) => {
      if (!SUMMARY_SENTINELS.some((sentinel) => comment.body.startsWith(sentinel))) return false;
      const meta = parseReviewMetaFromCommentBody(comment.body);
      return meta?.headSha === headSha;
    }),
  );
}

async function findSupersededSummaryComment(params: {
  readonly db: DatabaseSync;
  readonly prSurface: PrSurface;
  readonly comments: readonly PrConversationComment[];
  readonly headSha: string;
}) {
  const latest = params.comments
    .filter((comment) => SUMMARY_SENTINELS.some((sentinel) => comment.body.startsWith(sentinel)))
    .at(-1);
  if (latest == null)
    return ((
      pinnedReturn:
        | (PrConversationComment | "retry" | null)
        | Promise<PrConversationComment | "retry" | null>,
    ) => pinnedReturn)(null);
  const meta = parseReviewMetaFromCommentBody(latest.body);
  if (meta == null || meta.headSha === params.headSha)
    return ((
      pinnedReturn:
        | (PrConversationComment | "retry" | null)
        | Promise<PrConversationComment | "retry" | null>,
    ) => pinnedReturn)(null);

  const workItemId = parseProgressRevisionState(latest.body)?.workItemId;
  if (workItemId == null)
    return ((
      pinnedReturn:
        | (PrConversationComment | "retry" | null)
        | Promise<PrConversationComment | "retry" | null>,
    ) => pinnedReturn)(null);
  const ownerStatus = workRunStatus(params.db, workItemId);
  if (ownerStatus === undefined || !TERMINAL_OWN_CHECK_STATUSES.has(ownerStatus))
    return ((
      pinnedReturn:
        | (PrConversationComment | "retry" | null)
        | Promise<PrConversationComment | "retry" | null>,
    ) => pinnedReturn)(null);

  let prHead: string;
  try {
    prHead = await params.prSurface.getHeadSha();
  } catch (error) {
    logWarn("ci_projection_pr_head_failed", {
      headSha: params.headSha,
      commentId: latest.id,
      message: errorMessage(error),
    });
    return ((
      pinnedReturn:
        | (PrConversationComment | "retry" | null)
        | Promise<PrConversationComment | "retry" | null>,
    ) => pinnedReturn)("retry");
  }
  return ((
    pinnedReturn:
      | (PrConversationComment | "retry" | null)
      | Promise<PrConversationComment | "retry" | null>,
  ) => pinnedReturn)(prHead === params.headSha ? latest : null);
}

function aggregatePrResults(results: readonly CiProjectionPrResult[]) {
  if (results.some((result) => result === "retry"))
    return ((pinnedReturn: CiProjectionPrResult) => pinnedReturn)("retry");
  if (results.some((result) => result === "updated"))
    return ((pinnedReturn: CiProjectionPrResult) => pinnedReturn)("updated");
  if (results.length > 0 && results.every((result) => result === "irrelevant"))
    return ((pinnedReturn: CiProjectionPrResult) => pinnedReturn)("irrelevant");
  if (results.some((result) => result === "current"))
    return ((pinnedReturn: CiProjectionPrResult) => pinnedReturn)("current");
  return ((pinnedReturn: CiProjectionPrResult) => pinnedReturn)("irrelevant");
}

async function projectOnePr(params: {
  readonly deps: CiProjectionDependencies;
  readonly data: CiProjectionJobData;
  readonly row: HeadCiProjectionRow;
  readonly prNumber: number;
  readonly prSurface: PrSurface;
}) {
  const resourceKey = prResourceKey(params.data.owner, params.data.repo, params.prNumber);
  const { db, publication } = params.deps;
  const newest = newestHeadShaForPr(db, resourceKey);
  const staleHead = newest != null && newest !== params.data.headSha;
  if (staleHead) {
    logDebug("ci_projection_skipped_stale_head", {
      owner: params.data.owner,
      repo: params.data.repo,
      pr: params.prNumber,
      headSha: params.data.headSha,
      newest,
    });
  }

  if (!staleHead) {
    await reconcileOwnVerdicts({
      deps: params.deps,
      prSurface: params.prSurface,
      owner: params.data.owner,
      repo: params.data.repo,
      prNumber: params.prNumber,
      headSha: params.data.headSha,
    });
  }

  const injectFailure = verificationFailureActive(db, resourceKey, params.data.headSha);
  const nextCell = renderProjectedCell(params.row, injectFailure);
  const actionPhrase = projectedActionPhrase(params.row);

  let comments: readonly PrConversationComment[];
  try {
    comments = (await params.prSurface.listConversationComments()).comments;
  } catch (error) {
    logWarn("ci_projection_list_comments_failed", {
      owner: params.data.owner,
      repo: params.data.repo,
      pr: params.prNumber,
      message: errorMessage(error),
    });
    return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
      "retry",
    );
  }

  const triageResult = await patchTriageRollupComments({
    publication,
    comments,
    prSurface: params.prSurface,
    owner: params.data.owner,
    repo: params.data.repo,
    prNumber: params.prNumber,
    headSha: params.data.headSha,
    version: params.row.version,
    rollup: params.row.rollup,
  });
  if (triageResult === "retry")
    return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
      "retry",
    );

  const noGateResult = staleHead
    ? "irrelevant"
    : triageResult === "updated"
      ? "updated"
      : "current";
  if (nextCell == null)
    return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
      noGateResult,
    );

  let targets = staleHead ? [] : findHeadSummaryComments(comments, params.data.headSha);
  let supersededHead = false;
  if (targets.length === 0) {
    const superseded = await findSupersededSummaryComment({
      db,
      prSurface: params.prSurface,
      comments,
      headSha: params.data.headSha,
    });
    if (superseded === "retry")
      return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
        "retry",
      );
    if (superseded == null)
      return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
        noGateResult,
      );
    targets = [superseded];
    supersededHead = true;
  }

  let sawUpdate = triageResult === "updated";
  let sawCurrent = triageResult === "current";
  for (const comment of targets) {
    const decision = decideCiProjectionBodyUpdate(
      comment.body,
      params.data.headSha,
      params.row.version,
      { supersededHead },
    );
    if (decision.kind === "reject") continue;
    if (decision.kind === "current") {
      sawCurrent = true;
      continue;
    }

    const firstRevision = parseProgressRevisionState(comment.body);
    const firstApply = applyCiProjectionBodyUpdate(
      comment.body,
      nextCell,
      params.data.headSha,
      params.row.version,
      { actionPhrase, supersededHead },
    );
    if (firstApply == null || firstApply.kind === "current") {
      sawCurrent = true;
      continue;
    }

    let latest: PrConversationComment | undefined;
    try {
      const reread = (await params.prSurface.listConversationComments()).comments;
      latest = reread.find((entry) => entry.id === comment.id);
    } catch (error) {
      logWarn("ci_projection_reread_failed", {
        owner: params.data.owner,
        repo: params.data.repo,
        pr: params.prNumber,
        commentId: comment.id,
        message: errorMessage(error),
      });
      return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
        "retry",
      );
    }
    if (latest == null) continue;
    const secondRevision = parseProgressRevisionState(latest.body);
    if (
      firstRevision?.revision !== secondRevision?.revision ||
      firstRevision?.workItemId !== secondRevision?.workItemId
    ) {
      logDebug("ci_projection_progress_revision_moved", {
        owner: params.data.owner,
        repo: params.data.repo,
        pr: params.prNumber,
        commentId: comment.id,
      });
      return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
        "retry",
      );
    }

    const writeApply = applyCiProjectionBodyUpdate(
      latest.body,
      nextCell,
      params.data.headSha,
      params.row.version,
      { actionPhrase, supersededHead },
    );
    if (writeApply == null || writeApply.kind === "current") {
      sawCurrent = true;
      continue;
    }

    try {
      await editCommentOnce({
        publication,
        prSurface: params.prSurface,
        resourceKey,
        commentId: comment.id,
        body: writeApply.body,
        operation: `cell:${params.data.headSha}:${params.row.version}:${secondRevision?.revision ?? 0}`,
      });
    } catch (error) {
      logWarn("ci_projection_edit_failed", {
        owner: params.data.owner,
        repo: params.data.repo,
        pr: params.prNumber,
        commentId: comment.id,
        message: errorMessage(error),
      });
      return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
        "retry",
      );
    }

    sawUpdate = true;
    const owner = progressCommentOwner(db, resourceKey, "review");
    if (owner != null) {
      publication.record({
        workId: owner.workId,
        prKey: resourceKey,
        lens: "review",
        step: "ci_cell",
        detail: {
          headSha: params.data.headSha,
          version: params.row.version,
          commentId: comment.id,
          githubId: comment.id,
        },
      });
    }
    logDebug("ci_projection_patched", {
      owner: params.data.owner,
      repo: params.data.repo,
      pr: params.prNumber,
      commentId: comment.id,
      version: params.row.version,
    });
  }

  if (sawUpdate)
    return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
      "updated",
    );
  if (sawCurrent)
    return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
      "current",
    );
  return ((pinnedReturn: CiProjectionPrResult | Promise<CiProjectionPrResult>) => pinnedReturn)(
    "irrelevant",
  );
}

function captureListingRollupChange(
  data: CiProjectionJobData,
  previousRollup: HeadCiProjectionRow["rollup"],
  row: HeadCiProjectionRow,
) {
  if (previousRollup === row.rollup) return;
  captureCiStateChanged({
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    headSha: data.headSha,
    fromRollup: previousRollup,
    toRollup: row.rollup,
    version: row.version,
  });
}

async function applyGithubCiListingIfNeeded(params: {
  readonly deps: CiProjectionDependencies;
  readonly data: CiProjectionJobData;
  readonly row: HeadCiProjectionRow | null;
  readonly prNumbers: readonly number[];
  readonly probeSurface: PrSurface;
  readonly createSurface: CiProjectionSurfaceFactory;
  readonly availability?: GithubCiSourceAvailability;
}) {
  const phase = headCiListingPhase(params.row);
  if (phase === "none")
    return ((pinnedReturn: (HeadCiProjectionRow | null) | Promise<HeadCiProjectionRow | null>) =>
      pinnedReturn)(params.row);

  const surface =
    params.prNumbers.length > 0
      ? await params.createSurface(params.prNumbers[0] ?? 0)
      : params.probeSurface;
  let snapshot: Awaited<ReturnType<PrSurface["getCiStatus"]>> & Partial<CiStatusSourcesResult>;
  try {
    snapshot = await surface.getCiStatus(params.data.headSha);
  } catch (error) {
    const message = errorMessage(error);
    if (phase === "seed") {
      logWarn("ci_projection_seed_failed", {
        owner: params.data.owner,
        repo: params.data.repo,
        headSha: params.data.headSha,
        message,
      });
      return ((pinnedReturn: (HeadCiProjectionRow | null) | Promise<HeadCiProjectionRow | null>) =>
        pinnedReturn)(null);
    }
    logWarn("ci_projection_pending_refresh_failed", {
      owner: params.data.owner,
      repo: params.data.repo,
      headSha: params.data.headSha,
      message,
    });
    requestHeadCiProjection(
      params.deps.db,
      params.data,
      { kind: "after", seconds: PENDING_CI_REFRESH_RETRY_SECONDS },
      params.deps.now(),
    );
    return ((pinnedReturn: (HeadCiProjectionRow | null) | Promise<HeadCiProjectionRow | null>) =>
      pinnedReturn)(params.row);
  }

  const listing = {
    owner: params.data.owner,
    repo: params.data.repo,
    headSha: params.data.headSha,
    checkRuns: snapshot.checkRuns,
    legacyStatuses: snapshot.legacyStatuses,
    installationId: params.data.installationId,
    githubAppId: params.deps.cfg.github.appId,
    checkRunsComplete:
      snapshot.checkRunsComplete !== false && snapshot.legacyStatusesComplete !== false,
  };

  let listedRow: HeadCiProjectionRow;
  if (phase === "seed") {
    const seeded = seedHeadCiFromSnapshot(params.deps.db, listing, params.deps.now());
    captureListingRollupChange(params.data, seeded.previousRollup, seeded.row);
    listedRow = seeded.row;
  } else {
    const refreshed = refreshHeadCiFromSnapshot(params.deps.db, listing, params.deps.now());
    captureListingRollupChange(params.data, refreshed.previousRollup, refreshed.row);
    listedRow = refreshed.row;
  }
  if (params.availability == null)
    return ((pinnedReturn: (HeadCiProjectionRow | null) | Promise<HeadCiProjectionRow | null>) =>
      pinnedReturn)(listedRow);
  for (const source of ["checks", "statuses"] as const) {
    const detail = snapshot.sources?.[source];
    recordGithubCiSourceRead(params.deps.db, {
      ...params.data,
      now: params.deps.now(),
      source,
      generation: params.availability.generation,
      access:
        detail?.access ??
        (params.availability[source].access === "denied" ? "denied" : "available"),
      complete:
        detail?.complete ??
        (source === "checks"
          ? snapshot.checkRunsComplete !== false
          : snapshot.legacyStatusesComplete !== false),
    });
  }
  const availability = loadGithubCiSourceAvailability(params.deps.db, params.data);
  const latest = loadHeadCiProjectionRow(params.deps.db, params.data);
  const scopedRow = withSourceAvailability(latest ?? listedRow, availability);
  if (
    Object.values(snapshot.sources ?? {}).some((source) => source.access === "unknown") &&
    headCiListingPhase(scopedRow) !== "none"
  ) {
    requestHeadCiProjection(
      params.deps.db,
      params.data,
      { kind: "after", seconds: PENDING_CI_REFRESH_RETRY_SECONDS },
      params.deps.now(),
    );
  }
  return ((pinnedReturn: (HeadCiProjectionRow | null) | Promise<HeadCiProjectionRow | null>) =>
    pinnedReturn)(scopedRow);
}

function withSourceAvailability(
  row: HeadCiProjectionRow,
  sourceAvailability: GithubCiSourceAvailability,
) {
  return ((pinnedReturn: HeadCiProjectionRow) => pinnedReturn)({
    ...row,
    sourceAvailability,
    rollup:
      !ciSourcesComplete(sourceAvailability) && (row.rollup === "passing" || row.rollup === "none")
        ? "unknown"
        : row.rollup,
  });
}

export async function runCiProjectionJob(
  deps: CiProjectionDependencies,
  data: CiProjectionJobData,
  options?: {
    readonly createSurface?: CiProjectionSurfaceFactory;
    readonly author?: CiSummaryAuthor;
  },
) {
  const { cfg, db } = deps;
  if (isRateLimitCircuitOpen(db, data.installationId, deps.now())) {
    const circuit = readRateLimitCircuit(db, data.installationId);
    const openUntil = circuit?.openUntilMs ?? deps.now() + 60_000;
    const startAfter = Math.max(1, Math.ceil((openUntil - deps.now()) / 1000));
    requestHeadCiProjection(db, data, { kind: "after", seconds: startAfter }, deps.now());
    logDebug("ci_projection_deferred_rate_limit", {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      startAfter,
    });
    return;
  }

  const scope = { installationId: data.installationId, owner: data.owner, repo: data.repo };
  let observation = loadGithubCapabilityObservation(db, scope);
  let installation: Awaited<ReturnType<InstallationSurface["token"]>> | undefined;
  if (
    (observation == null || capabilityObservationUnconfirmed(observation.capabilities)) &&
    options?.createSurface == null
  ) {
    const generation = String(nextGithubCapabilityObservationGeneration(db));
    const preflight = await deps.installationSurface.preflight({ cfg, ...scope, generation });
    saveGithubCapabilityObservation(db, {
      ...scope,
      observation: preflight.observation,
      now: deps.now(),
    });
    installation = preflight.installation;
    observation = loadGithubCapabilityObservation(db, scope);
  }
  let scopedAvailability =
    observation == null ? undefined : loadGithubCiSourceAvailability(db, data);
  let capabilityPolicy: ReturnType<typeof createReviewCapabilityPolicy> | undefined;
  if (observation != null) {
    const unknown = unknownInstallationCapabilities(
      { appId: cfg.github.appId, ...scope },
      String(observation.generation),
    );
    const availability = { ...unknown.availability, ...observation.capabilities };
    const scopedOperations = {
      ...availability,
      checksRead: scopedAvailability?.checks.access ?? availability.checksRead,
      statusesRead: scopedAvailability?.statuses.access ?? availability.statusesRead,
    };
    const generation = observation.generation;
    capabilityPolicy = createReviewCapabilityPolicy(
      {
        scope: { appId: cfg.github.appId, ...scope },
        generation: String(generation),
        availability: scopedOperations,
      },
      async (operation) => {
        recordGithubCapabilityDenial(db, { ...scope, generation, operation, now: deps.now() });
      },
    );
    if (
      capabilityPolicy.access("pullRequestsRead") === "denied" ||
      capabilityPolicy.access("commentsWrite") === "denied"
    ) {
      if (clearHeadCiProjectionRepair(db, data, deps.now())) {
        logWarn("ci_projection_repair_unreachable", {
          owner: data.owner,
          repo: data.repo,
          headSha: data.headSha,
          reason: "capability_denied",
        });
      }
      return;
    }
  }
  const createSurface: CiProjectionSurfaceFactory =
    options?.createSurface ??
    (async (prNumber) => {
      return deps.installationSurface.create({
        cfg,
        installationId: data.installationId,
        owner: data.owner,
        repo: data.repo,
        prNumber,
        installation,
        capabilities: capabilityPolicy,
        mutationBoundary: passthroughMutationBoundary(),
      });
    });

  let row = loadHeadCiProjectionRow(db, data);
  const probeSurface = await createSurface(asPrNumbers(row?.prNumbers)[0] ?? 0);
  const prNumbers = await resolvePrNumbers({
    db,
    owner: data.owner,
    repo: data.repo,
    headSha: data.headSha,
    stored: row?.prNumbers,
    listPulls: () => probeSurface.listPullsForHead(data.headSha),
  });
  if (prNumbers.length > 0) {
    storeHeadCiPrNumbers(db, { ...data, prNumbers }, deps.now());
  }
  if (observation != null) {
    scopedAvailability = loadGithubCiSourceAvailability(db, data);
    row = loadHeadCiProjectionRow(db, data);
    if (row != null) row = withSourceAvailability(row, scopedAvailability);
  }

  const listed = await applyGithubCiListingIfNeeded({
    deps,
    data,
    row,
    prNumbers,
    probeSurface,
    createSurface,
    availability: scopedAvailability,
  });
  if (listed == null) return;
  let projected = listed;

  try {
    if (capabilityPolicy?.access("actionsRead") === "denied") {
      logDebug("ci_projection_actions_unavailable", {
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
      });
    } else {
      const authorSurface =
        prNumbers.length > 0 ? await createSurface(prNumbers[0] ?? 0) : probeSurface;
      projected = await authorHeadCiIfFactsChanged({
        cfg,
        db,
        prSurface: authorSurface,
        row: projected,
        author: options?.author,
        ...(deps.createSession !== undefined ? { createSession: deps.createSession } : {}),
      });
    }
  } catch (error) {
    logWarn("ci_projection_author_failed", {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      message: errorMessage(error),
    });
  }

  if (prNumbers.length === 0) {
    logDebug("ci_projection_no_prs", {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      version: projected.version,
    });
    if (projected.projectionRepairPending) {
      logWarn("ci_projection_repair_unreachable", {
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        reason: "no_prs",
      });
      clearHeadCiProjectionRepair(db, data, deps.now());
    }
    return;
  }

  const prResults: CiProjectionPrResult[] = [];
  for (const prNumber of prNumbers) {
    const prSurface = await createSurface(prNumber);
    prResults.push(
      await projectOnePr({
        deps,
        data,
        row: projected,
        prNumber,
        prSurface,
      }),
    );
  }

  const aggregate = aggregatePrResults(prResults);
  const latest = loadHeadCiProjectionRow(db, data);
  const versionMoved = latest != null && latest.version > projected.version;
  if (aggregate === "retry" || versionMoved) {
    requestHeadCiProjection(db, data, { kind: "debounced" }, deps.now());
    return;
  }

  if (
    latest?.projectionRepairPending === true &&
    (aggregate === "current" || aggregate === "updated" || aggregate === "irrelevant")
  ) {
    clearHeadCiProjectionRepair(db, data, deps.now());
    logDebug("ci_projection_repair_cleared", {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      result: aggregate,
    });
  }
}
