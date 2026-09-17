import type { Config } from "../../config.js";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { logDebug, logWarn } from "../../evlog.js";
import {
  createPrSurface,
  type PrConversationComment,
  type PrSurface,
} from "../../github/prSurface.js";
import {
  getSharedRateLimitCircuit,
  isSharedRateLimitCircuitOpen,
} from "../../github/sharedRateLimitCircuit.js";
import {
  injectVerificationFailureIntoCiCell,
  renderVerificationFailureBlock,
} from "../../review/ci/verificationFailureBlock.js";
import {
  applyCiProjectionBodyUpdate,
  decideCiProjectionBodyUpdate,
} from "../../review/ci/ciSummaryCell.js";
import {
  renderCiRollupMarker,
  replaceCiRollupMarkerIfNewer,
} from "../../review/ci/ciRollupMarker.js";
import type { CiSummaryAuthor } from "../../review/ci/authorCiSummary.js";
import { ciSummaryFromFacts, headCiFactsAreComplete } from "../../review/ci/ciFromHeadState.js";
import { renderCiSummaryCell, shouldRenderCiSummaryRow } from "../../review/ci/renderCiSummary.js";
import { parseReviewMetaFromCommentBody } from "../../review/ci/reviewMetaParse.js";
import { formatReviewActionLineCiStatus } from "../../review/ci/ciActionPhrase.js";
import { parseProgressRevisionState } from "../../review/run/progressComment.js";
import {
  REVIEW_SUMMARY_SENTINEL,
  TRIAGE_SUMMARY_SENTINEL,
  VERIFICATION_PUBLISH_LENS,
} from "../../settings/index.js";
import {
  isAnyReviewLens,
  LEGACY_REVIEW_SUMMARY_SENTINELS,
} from "../../settings/legacyReviewLenses.js";
import { captureCiStateChanged } from "../../analytics/workCompleted.js";
import { authorHeadCiIfFactsChanged } from "../ciAuthoring.js";
import { mintInstallationToken } from "../durableJob.js";
import { closeOwnVerdict } from "../closeOwnVerdict.js";
import {
  enqueueCiProjectionAfter,
  enqueueCiProjectionDebouncedStandalone,
} from "../intake/queueing.js";
import {
  asPrNumbers,
  clearProjectionRepairPending,
  headCiNeedsSeed,
  listPrNumbersForHeadFromWorkItems,
  listTerminalReviewsForHead,
  loadPrHeadCiState,
  newestHeadShaForResource,
  seedPrHeadCiStateFromSnapshot,
  storePrNumbersForHead,
  type PrHeadCiStateRow,
} from "../prHeadCiState.js";
import {
  asTerminalOwnCheckStatus,
  isOwnCheckOpen,
  resolveOwnVerdictForTerminalReview,
} from "../ownCheckReconcile.js";
import {
  getCompletedPublishStepDetail,
  getLatestCompletedPublishStepDetail,
  getProgressCommentOwner,
  recordPublishStep,
} from "../repository.js";
import { prResourceKey, type CiProjectionJobData } from "../types.js";

const SUMMARY_SENTINELS = [REVIEW_SUMMARY_SENTINEL, ...LEGACY_REVIEW_SUMMARY_SENTINELS] as const;

export type CiProjectionSurfaceFactory = (prNumber: number) => Promise<PrSurface>;

export type CiProjectionPrResult = "current" | "updated" | "retry" | "irrelevant";

async function resolvePrNumbers(params: {
  readonly pool: Pool;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly stored: unknown;
  readonly listPulls: () => Promise<readonly { readonly number: number }[]>;
}): Promise<number[]> {
  const stored = asPrNumbers(params.stored);
  const fromWork = await listPrNumbersForHeadFromWorkItems(
    params.pool,
    params.owner,
    params.repo,
    params.headSha,
  );
  const pulls = await params.listPulls();
  return [
    ...new Set([...stored, ...fromWork, ...pulls.map((pull) => pull.number).filter((n) => n > 0)]),
  ];
}

async function reconcileOwnVerdicts(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
}): Promise<void> {
  const items = await listTerminalReviewsForHead(
    params.pool,
    params.owner,
    params.repo,
    params.prNumber,
    params.headSha,
  );
  for (const item of items) {
    if (!isAnyReviewLens(item.reviewLens)) continue;
    const checkDetail = await getCompletedPublishStepDetail(
      params.pool,
      item.id,
      item.resourceKey,
      item.reviewLens,
      "check_run",
    );
    if (!isOwnCheckOpen(checkDetail)) continue;
    const status = asTerminalOwnCheckStatus(item.status);
    if (status == null) continue;
    try {
      await closeOwnVerdict({
        pool: params.pool,
        prSurface: params.prSurface,
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens: item.reviewLens,
        headSha: params.headSha,
        leaseEpoch: null,
        commitStatusEnabled: params.cfg.features.commitStatus,
        outcome: await resolveOwnVerdictForTerminalReview({
          pool: params.pool,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens: item.reviewLens,
          status,
        }),
      });
    } catch (error) {
      logWarn("ci_projection_own_verdict_failed", {
        workItemId: item.id,
        resourceKey: item.resourceKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function verificationFailureActive(
  pool: Pool,
  resourceKey: string,
  headSha: string,
): Promise<boolean> {
  const detail = await getLatestCompletedPublishStepDetail(
    pool,
    resourceKey,
    VERIFICATION_PUBLISH_LENS,
    "verification_failure",
  );
  if (detail == null) return false;
  if (detail.active === false) return false;
  return detail.headSha === headSha;
}

function renderProjectedCell(row: PrHeadCiStateRow, injectFailure: boolean): string | null {
  const rendered = ciSummaryFromFacts(row.checks, row.version, row.authored, {
    checkRunsComplete: headCiFactsAreComplete(row.rollup),
  });
  if (!shouldRenderCiSummaryRow(rendered.summary)) return null;
  let cell = renderCiSummaryCell(rendered.summary, row.headSha, rendered.version);
  if (injectFailure)
    cell = injectVerificationFailureIntoCiCell(cell, renderVerificationFailureBlock());
  return cell;
}

function projectedActionPhrase(row: PrHeadCiStateRow): string {
  const rendered = ciSummaryFromFacts(row.checks, row.version, row.authored, {
    checkRunsComplete: headCiFactsAreComplete(row.rollup),
  });
  return formatReviewActionLineCiStatus(rendered.summary);
}

async function patchTriageRollupComments(params: {
  readonly comments: readonly PrConversationComment[];
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly version: number;
  readonly rollup: PrHeadCiStateRow["rollup"];
}): Promise<"updated" | "current" | "retry"> {
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
      await params.prSurface.editComment(comment.id, writeBody);
      updated = true;
    } catch (error) {
      logWarn("ci_projection_triage_rollup_failed", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        commentId: comment.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return "retry";
    }
  }
  return updated ? "updated" : "current";
}

function findHeadSummaryComments(
  comments: readonly PrConversationComment[],
  headSha: string,
): PrConversationComment[] {
  return comments.filter((comment) => {
    if (!SUMMARY_SENTINELS.some((sentinel) => comment.body.startsWith(sentinel))) return false;
    const meta = parseReviewMetaFromCommentBody(comment.body);
    return meta?.headSha === headSha;
  });
}

function aggregatePrResults(results: readonly CiProjectionPrResult[]): CiProjectionPrResult {
  if (results.some((result) => result === "retry")) return "retry";
  if (results.some((result) => result === "updated")) return "updated";
  if (results.length > 0 && results.every((result) => result === "irrelevant")) return "irrelevant";
  if (results.some((result) => result === "current")) return "current";
  return "irrelevant";
}

async function projectOnePr(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly data: CiProjectionJobData;
  readonly row: PrHeadCiStateRow;
  readonly prNumber: number;
  readonly prSurface: PrSurface;
}): Promise<CiProjectionPrResult> {
  const resourceKey = prResourceKey(params.data.owner, params.data.repo, params.prNumber);
  const newest = await newestHeadShaForResource(params.pool, resourceKey);
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
      cfg: params.cfg,
      pool: params.pool,
      prSurface: params.prSurface,
      owner: params.data.owner,
      repo: params.data.repo,
      prNumber: params.prNumber,
      headSha: params.data.headSha,
    });
  }

  const injectFailure = await verificationFailureActive(
    params.pool,
    resourceKey,
    params.data.headSha,
  );
  const nextCell = staleHead ? null : renderProjectedCell(params.row, injectFailure);
  const actionPhrase = staleHead ? null : projectedActionPhrase(params.row);

  let comments: readonly PrConversationComment[];
  try {
    comments = await params.prSurface.listConversationComments();
  } catch (error) {
    logWarn("ci_projection_list_comments_failed", {
      owner: params.data.owner,
      repo: params.data.repo,
      pr: params.prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
    return "retry";
  }

  const triageResult = await patchTriageRollupComments({
    comments,
    prSurface: params.prSurface,
    owner: params.data.owner,
    repo: params.data.repo,
    prNumber: params.prNumber,
    headSha: params.data.headSha,
    version: params.row.version,
    rollup: params.row.rollup,
  });
  if (triageResult === "retry") return "retry";

  if (nextCell == null) {
    return staleHead ? "irrelevant" : triageResult === "updated" ? "updated" : "current";
  }

  const targets = findHeadSummaryComments(comments, params.data.headSha);
  if (targets.length === 0) {
    return triageResult === "updated" ? "updated" : "current";
  }

  let sawUpdate = triageResult === "updated";
  let sawCurrent = triageResult === "current";
  for (const comment of targets) {
    const decision = decideCiProjectionBodyUpdate(
      comment.body,
      params.data.headSha,
      params.row.version,
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
      { actionPhrase },
    );
    if (firstApply == null || firstApply.kind === "current") {
      sawCurrent = true;
      continue;
    }

    let latest: PrConversationComment | undefined;
    try {
      const reread = await params.prSurface.listConversationComments();
      latest = reread.find((entry) => entry.id === comment.id);
    } catch (error) {
      logWarn("ci_projection_reread_failed", {
        owner: params.data.owner,
        repo: params.data.repo,
        pr: params.prNumber,
        commentId: comment.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return "retry";
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
      return "retry";
    }

    const writeApply = applyCiProjectionBodyUpdate(
      latest.body,
      nextCell,
      params.data.headSha,
      params.row.version,
      { actionPhrase },
    );
    if (writeApply == null || writeApply.kind === "current") {
      sawCurrent = true;
      continue;
    }

    try {
      await params.prSurface.editComment(comment.id, writeApply.body);
    } catch (error) {
      logWarn("ci_projection_edit_failed", {
        owner: params.data.owner,
        repo: params.data.repo,
        pr: params.prNumber,
        commentId: comment.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return "retry";
    }

    sawUpdate = true;
    const owner = await getProgressCommentOwner(params.pool, resourceKey, "review");
    if (owner != null) {
      await recordPublishStep(params.pool, {
        workItemId: owner.workItemId,
        resourceKey,
        reviewLens: "review",
        step: "ci_cell",
        githubId: comment.id,
        leaseEpoch: null,
        detail: {
          headSha: params.data.headSha,
          version: params.row.version,
          commentId: comment.id,
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

  if (sawUpdate) return "updated";
  if (sawCurrent) return "current";
  return "irrelevant";
}

/**
 * Renders `pr_head_ci_state` onto every review summary for the head.
 * Seeds when `seeded_at` is null with one `getCiStatus` read. Unleased writer.
 */
export async function executeCiProjectionJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  data: CiProjectionJobData,
  options?: {
    readonly createSurface?: CiProjectionSurfaceFactory;
    readonly author?: CiSummaryAuthor;
  },
): Promise<void> {
  if (await isSharedRateLimitCircuitOpen(pool, data.installationId)) {
    const circuit = await getSharedRateLimitCircuit(pool, data.installationId);
    const openUntil = circuit?.openUntil.getTime() ?? Date.now() + 60_000;
    const startAfter = Math.max(1, Math.ceil((openUntil - Date.now()) / 1000));
    await enqueueCiProjectionAfter(boss, data, startAfter);
    logDebug("ci_projection_deferred_rate_limit", {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      startAfter,
    });
    return;
  }

  const createSurface: CiProjectionSurfaceFactory =
    options?.createSurface ??
    (async (prNumber) => {
      const installation = await mintInstallationToken(cfg, data.installationId);
      return createPrSurface({
        cfg,
        installationId: data.installationId,
        owner: data.owner,
        repo: data.repo,
        prNumber,
        installation,
      });
    });

  let row = await loadPrHeadCiState(pool, data.owner, data.repo, data.headSha);
  const probeSurface = await createSurface(asPrNumbers(row?.prNumbers)[0] ?? 0);
  const prNumbers = await resolvePrNumbers({
    pool,
    owner: data.owner,
    repo: data.repo,
    headSha: data.headSha,
    stored: row?.prNumbers,
    listPulls: () => probeSurface.listPullsForHead(data.headSha),
  });
  if (prNumbers.length > 0) {
    await storePrNumbersForHead(pool, data.owner, data.repo, data.headSha, prNumbers);
  }

  if (headCiNeedsSeed(row)) {
    const seedSurface = await createSurface(prNumbers[0] ?? 0);
    let snapshot: Awaited<ReturnType<PrSurface["getCiStatus"]>>;
    try {
      snapshot = await seedSurface.getCiStatus(data.headSha);
    } catch (error) {
      logWarn("ci_projection_seed_failed", {
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const seeded = await seedPrHeadCiStateFromSnapshot(pool, {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      checkRuns: snapshot.checkRuns,
      legacyStatuses: snapshot.legacyStatuses,
      githubAppId: cfg.githubAppId,
      checkRunsComplete: snapshot.checkRunsComplete,
    });
    row = seeded.row;
    if (seeded.previousRollup !== row.rollup) {
      captureCiStateChanged({
        installationId: data.installationId,
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        fromRollup: seeded.previousRollup,
        toRollup: row.rollup,
        version: row.version,
      });
    }
  }

  if (row == null) return;

  try {
    const authorSurface =
      prNumbers.length > 0 ? await createSurface(prNumbers[0] ?? 0) : probeSurface;
    row = await authorHeadCiIfFactsChanged({
      cfg,
      pool,
      prSurface: authorSurface,
      row,
      author: options?.author,
    });
  } catch (error) {
    logWarn("ci_projection_author_failed", {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (prNumbers.length === 0) {
    logDebug("ci_projection_no_prs", {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      version: row.version,
    });
    if (row.projectionRepairPending) {
      logWarn("ci_projection_repair_unreachable", {
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        reason: "no_prs",
      });
      await clearProjectionRepairPending(pool, data.owner, data.repo, data.headSha);
    }
    return;
  }

  const prResults: CiProjectionPrResult[] = [];
  for (const prNumber of prNumbers) {
    const prSurface = await createSurface(prNumber);
    prResults.push(
      await projectOnePr({
        cfg,
        pool,
        boss,
        data,
        row,
        prNumber,
        prSurface,
      }),
    );
  }

  const aggregate = aggregatePrResults(prResults);
  const latest = await loadPrHeadCiState(pool, data.owner, data.repo, data.headSha);
  const versionMoved = latest != null && latest.version > row.version;
  if (aggregate === "retry" || versionMoved) {
    await enqueueCiProjectionDebouncedStandalone(boss, data);
    return;
  }

  if (
    latest?.projectionRepairPending === true &&
    (aggregate === "current" || aggregate === "updated" || aggregate === "irrelevant")
  ) {
    await clearProjectionRepairPending(pool, data.owner, data.repo, data.headSha);
    logDebug("ci_projection_repair_cleared", {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      result: aggregate,
    });
  }
}
