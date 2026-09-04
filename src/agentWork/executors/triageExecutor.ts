import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import { getAppBotIdentity, type BotIdentity } from "../../github/appAuth.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { ReviewThreadResolution } from "../../github/reviewThreadResolution.js";
import { warnReviewThreadResolutionDegraded } from "../../github/reviewThreadResolution.js";
import {
  resolveReviewThreadRootId,
  type BotFindingThread,
} from "../../review/run/reviewPriorFeedback.js";
import { runFullPrTriage } from "../../agent/triage/triageRun.js";
import {
  previewApprovalSets,
  remapBulkPayload,
  replayPreviewHunks,
} from "../../agent/triage/previewApproval.js";
import {
  assertTriagePullRequestWritable,
  TriageCancelledError,
  TriageClosedPullRequestError,
} from "../../agent/triage/triageErrors.js";
import {
  parseStoredTriagePreviewDetail,
  parseStoredTriagePushDetail,
  publishTriage,
  publishTriagePreview,
  publishTriageReportOnly,
  type PublishTriageResult,
  type StoredTriagePreviewDetail,
  type StoredTriagePushDetail,
} from "../../agent/triage/publishTriage.js";
import {
  captureTriageEvent,
  captureTriageFailure,
  type TriageAnalyticsRef,
} from "../triageAnalytics.js";
import {
  TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  TRIAGE_BULK_PREVIEW_STALE,
  TRIAGE_BULK_REQUIRES_PREVIEW,
  TRIAGE_CLOSED_PR_NOTICE,
  TRIAGE_FAILURE_MESSAGE,
  TRIAGE_FORK_PR_NOTICE,
  TRIAGE_NO_ELIGIBLE_FINDINGS,
  TRIAGE_PUBLISH_LENS,
  TRIAGE_QUEUE,
  TRIAGE_THREAD_NOT_ELIGIBLE,
  TRIAGE_SUMMARY_SENTINEL,
} from "../../settings/index.js";
import {
  buildTriageCommitAttribution,
  gitPersonFromGithubUser,
  type GitPerson,
  type WritablePrCheckout,
  withWritablePrCheckout,
} from "../../prWorkspace/index.js";
import {
  getCompletedPublishStepDetail,
  getCompletedPublishStepDetailWithoutNewerStep,
  getLatestCompletedPublishStepDetail,
  hasCompletedPublishStep,
  listTriageEligibleInlineReviews,
  shouldSkipWork,
} from "../repository.js";
import {
  resolveWorkItemHead,
  runDurableWorkItem,
  type DurableExecutionResult,
} from "../durableJob.js";
import {
  triageMode,
  type TriageJobData,
  type TriageWorkPayload,
  type AgentWorkItem,
} from "../types.js";

type TriageWorkItem = Extract<AgentWorkItem, { type: "triage" }>;

type TriageExecuteResult = Extract<DurableExecutionResult, { kind: "completed" }>;

type PullRequestBranchInfo = {
  readonly headRef: string;
  readonly sameRepo: boolean;
};

type EmptyInventoryOutcome = "all_resolved" | "thread_not_eligible" | "no_eligible_findings";

const EMPTY_INVENTORY_MESSAGES: Record<EmptyInventoryOutcome, string> = {
  all_resolved: TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  thread_not_eligible: TRIAGE_THREAD_NOT_ELIGIBLE,
  no_eligible_findings: TRIAGE_NO_ELIGIBLE_FINDINGS,
};

type TriageReportContext = {
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly threadRootCommentId: number | undefined;
};

type InventoryAndScope = {
  readonly botIdentity: BotIdentity;
  readonly threads: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly inventory: readonly BotFindingThread[];
  readonly scopedThreadRootId: number | undefined;
  readonly reportContext: TriageReportContext;
};

async function loadPullRequestBranchInfo(prSurface: PrSurface): Promise<PullRequestBranchInfo> {
  return prSurface.getPullRequestBranchInfo();
}

function triageAnalyticsRef(
  item: Pick<AgentWorkItem, "installationId" | "owner" | "repo" | "prNumber" | "id">,
  scope: TriageWorkPayload["scope"],
): TriageAnalyticsRef {
  return {
    installationId: item.installationId,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    workItemId: item.id,
    scope,
  };
}

function reportOnlyBody(params: {
  readonly message: string;
  readonly headSha: string;
  readonly inventoryCount: number;
  readonly previouslyResolvedCount: number;
  readonly scope: TriageWorkPayload["scope"];
  readonly threadRootCommentId?: number;
}): string {
  const lines = [
    TRIAGE_SUMMARY_SENTINEL,
    "",
    params.scope === "thread" ? "Scoped to 1 finding." : "Full PR triage.",
  ];
  if (params.threadRootCommentId != null) {
    lines.push(`Thread root: \`${params.threadRootCommentId}\``);
  }
  lines.push(
    "",
    params.message,
    "",
    `Evaluated head: \`${params.headSha}\``,
    `Inventory items: ${params.inventoryCount}`,
    `Previously resolved: ${params.previouslyResolvedCount}`,
  );
  return lines.join("\n");
}

function triageReportContext(
  payload: TriageWorkPayload,
  threadRootCommentId?: number,
): TriageReportContext {
  return {
    scope: payload.scope ?? "all",
    threadRootCommentId: payload.scope === "thread" ? threadRootCommentId : undefined,
  };
}

async function resolveScopedThreadRootId(params: {
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly anchorCommentId: number;
  readonly analytics: TriageAnalyticsRef;
}): Promise<number> {
  try {
    const commentGraph = await params.prSurface.fetchReviewCommentParentGraph();
    return (
      resolveReviewThreadRootId(commentGraph, params.anchorCommentId) ?? params.anchorCommentId
    );
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logWarn("triage_thread_root_resolution_failed", {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      anchorCommentId: params.anchorCommentId,
      message: errorObj.message,
    });
    captureTriageEvent(params.analytics, "triage thread root resolution fallback", {
      step: "thread_root_resolution",
      fallback: "original_anchor_comment",
      thread_anchor_comment_id: params.anchorCommentId,
    });
    return params.anchorCommentId;
  }
}

function checkoutFromStoredPush(
  headRef: string,
  headSha: string,
  detail: StoredTriagePushDetail,
): WritablePrCheckout {
  return {
    dir: "",
    headRef,
    baseSha: headSha,
    commit: async () => {
      throw new AppError({
        code: "triage.invalid_stored_push",
        message: "Stored triage push cannot create new commits",
      });
    },
    push: async () => undefined,
    listCommittedShas: () => detail.commits.map((commit) => commit.sha),
    listCommittedDetails: () => [...detail.commits],
  };
}

function storedPushMatchesInventory(
  detail: StoredTriagePushDetail,
  headSha: string,
  inventory: readonly BotFindingThread[],
): boolean {
  if (detail.pushOutcome === "stale" || detail.pushOutcome === "closed") return false;
  if (detail.pushedHeadSha?.toLowerCase() !== headSha.toLowerCase()) return false;
  const verdictIds = new Set(detail.payload.verdicts.map((verdict) => verdict.threadRootCommentId));
  if (verdictIds.size !== inventory.length) return false;
  return inventory.every((thread) => verdictIds.has(thread.rootCommentId));
}

function completedFromPublish(publish: PublishTriageResult): TriageExecuteResult {
  return publish.pushOutcome === "stale" ||
    publish.pushOutcome === "closed" ||
    publish.missingThreadAction ||
    publish.partialBulk === true
    ? { kind: "completed", degraded: true }
    : { kind: "completed" };
}

async function ensureTriageNotCancelled(
  pool: Pool,
  item: Pick<AgentWorkItem, "id">,
): Promise<void> {
  if (await shouldSkipWork(pool, item)) throw new TriageCancelledError();
}

async function ensureTriageWriteAllowed(params: {
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
}): Promise<void> {
  await ensureTriageNotCancelled(params.pool, params.item);
  await assertTriagePullRequestWritable(params.prSurface);
}

function resolveEmptyInventoryOutcome(params: {
  readonly scope: TriageWorkPayload["scope"];
  readonly scopedThreadRootId: number | undefined;
  readonly threads: readonly BotFindingThread[];
}): EmptyInventoryOutcome {
  if (params.scope === "thread") {
    const threadMatchesKnownFinding =
      params.scopedThreadRootId != null &&
      params.threads.some((thread) => thread.rootCommentId === params.scopedThreadRootId);
    return threadMatchesKnownFinding ? "all_resolved" : "thread_not_eligible";
  }
  return params.threads.length === 0 ? "no_eligible_findings" : "all_resolved";
}

async function handleForkPrReport(params: {
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
  readonly leaseEpoch: number | null;
}): Promise<TriageExecuteResult> {
  await ensureTriageNotCancelled(params.pool, params.item);
  captureTriageEvent(params.analytics, "triage report only", { outcome: "fork_pr" });
  await publishTriageReportOnly({
    pool: params.pool,
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    installationId: params.item.installationId,
    prSurface: params.prSurface,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
    headSha: params.headSha,
    inventory: [],
    previouslyResolvedCount: 0,
    leaseEpoch: params.leaseEpoch,
    body: reportOnlyBody({
      message: TRIAGE_FORK_PR_NOTICE,
      headSha: params.headSha,
      inventoryCount: 0,
      previouslyResolvedCount: 0,
      scope: params.scope,
    }),
  });
  return { kind: "completed" };
}

async function resolveInventoryAndScope(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
}): Promise<InventoryAndScope> {
  const payload = params.item.payload;
  const botIdentity = await getAppBotIdentity(params.cfg);
  const eligibleReviews = await listTriageEligibleInlineReviews(
    params.pool,
    params.item.resourceKey,
  );
  const [threads, resolutionResult] = await Promise.all([
    params.prSurface.fetchBotFindingThreads(
      botIdentity.userId,
      eligibleReviews,
      params.cfg.maintainerDecisionAssociations,
    ),
    params.prSurface.listInlineReviewThreads(),
  ]);
  warnReviewThreadResolutionDegraded(resolutionResult, {
    type: "triage",
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    owner: params.item.owner,
    repo: params.item.repo,
    pr: params.item.prNumber,
  });
  const resolutionByRootCommentId = resolutionResult.byRootCommentId;
  captureTriageEvent(params.analytics, "triage inventory discovered", {
    thread_count: threads.length,
    eligible_review_count: eligibleReviews.size,
  });
  const previouslyResolvedCount = threads.filter(
    (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved === true,
  ).length;
  const allUnresolved = threads.filter(
    (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved !== true,
  );
  let scopedThreadRootId: number | undefined;
  let inventory = allUnresolved;
  if (params.scope === "thread") {
    if (payload.threadAnchorCommentId != null) {
      scopedThreadRootId =
        payload.needsThreadRootResolution === true
          ? await resolveScopedThreadRootId({
              prSurface: params.prSurface,
              owner: params.item.owner,
              repo: params.item.repo,
              prNumber: params.item.prNumber,
              anchorCommentId: payload.threadAnchorCommentId,
              analytics: params.analytics,
            })
          : payload.threadAnchorCommentId;
      inventory =
        scopedThreadRootId != null
          ? allUnresolved.filter((thread) => thread.rootCommentId === scopedThreadRootId)
          : [];
    } else {
      inventory = [];
    }
  }
  return {
    botIdentity,
    threads,
    resolutionByRootCommentId,
    previouslyResolvedCount,
    inventory,
    scopedThreadRootId,
    reportContext: triageReportContext(payload, scopedThreadRootId),
  };
}

async function publishEmptyInventoryReport(params: {
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
  readonly threads: readonly BotFindingThread[];
  readonly inventory: readonly BotFindingThread[];
  readonly previouslyResolvedCount: number;
  readonly scopedThreadRootId: number | undefined;
  readonly reportContext: TriageReportContext;
  readonly leaseEpoch: number | null;
}): Promise<TriageExecuteResult> {
  await ensureTriageNotCancelled(params.pool, params.item);
  const outcome = resolveEmptyInventoryOutcome({
    scope: params.scope,
    scopedThreadRootId: params.scopedThreadRootId,
    threads: params.threads,
  });
  const message = EMPTY_INVENTORY_MESSAGES[outcome];
  captureTriageEvent(params.analytics, "triage report only", {
    outcome,
    previously_resolved_count: params.previouslyResolvedCount,
  });
  await publishTriageReportOnly({
    pool: params.pool,
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    installationId: params.item.installationId,
    prSurface: params.prSurface,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
    headSha: params.headSha,
    inventory: params.inventory,
    previouslyResolvedCount: params.previouslyResolvedCount,
    leaseEpoch: params.leaseEpoch,
    ...params.reportContext,
    body: reportOnlyBody({
      message,
      headSha: params.headSha,
      inventoryCount: params.scope === "thread" ? params.inventory.length : params.threads.length,
      previouslyResolvedCount: params.previouslyResolvedCount,
      scope: params.scope,
      threadRootCommentId: params.scopedThreadRootId,
    }),
  });
  return { kind: "completed" };
}

async function tryResumeStoredPush(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly headRef: string;
  readonly analytics: TriageAnalyticsRef;
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly reportContext: TriageReportContext;
  readonly leaseEpoch: number | null;
  readonly signal: AbortSignal;
}): Promise<TriageExecuteResult | null> {
  let storedPushDetail = await getCompletedPublishStepDetail(
    params.pool,
    params.item.id,
    params.item.resourceKey,
    "triage",
    "triage_push",
  );
  if (storedPushDetail == null) {
    storedPushDetail = await getCompletedPublishStepDetailWithoutNewerStep(
      params.pool,
      params.item.resourceKey,
      "triage",
      "triage_push",
      "triage_report",
    );
  }
  if (storedPushDetail == null) return null;

  const parsed = parseStoredTriagePushDetail(storedPushDetail);
  if (!parsed) {
    const error = new AppError({
      code: "triage.invalid_stored_push",
      message: "Stored triage_push detail is invalid",
    });
    captureTriageFailure(params.analytics, "parse_stored_push", error);
    throw error;
  }
  if (
    parsed.pushOutcome === "stale" ||
    !storedPushMatchesInventory(parsed, params.headSha, params.inventory)
  ) {
    return null;
  }

  captureTriageEvent(params.analytics, "triage resumed", {
    inventory_count: params.inventory.length,
    commit_count: parsed.commits.length,
    push_outcome: parsed.pushOutcome,
  });
  await ensureTriageNotCancelled(params.pool, params.item);
  const publish = await publishTriage({
    pool: params.pool,
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    installationId: params.item.installationId,
    prSurface: params.prSurface,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
    headSha: params.headSha,
    checkout: checkoutFromStoredPush(params.headRef, params.headSha, parsed),
    inventory: params.inventory,
    resolutionByRootCommentId: params.resolutionByRootCommentId,
    payload: parsed.payload,
    previouslyResolvedCount: params.previouslyResolvedCount,
    priorPush: parsed,
    findingHistoryCfg: params.cfg,
    leaseEpoch: params.leaseEpoch,
    signal: params.signal,
    ...params.reportContext,
  });
  const result = completedFromPublish(publish);
  if (result.degraded) {
    captureTriageEvent(params.analytics, "triage degraded", {
      step: "publish_resume",
      push_outcome: publish.pushOutcome,
      missing_thread_action: publish.missingThreadAction,
    });
  } else {
    captureTriageEvent(params.analytics, "triage published", {
      inventory_count: params.inventory.length,
      resumed: true,
      push_outcome: publish.pushOutcome,
    });
  }
  return result;
}

/**
 * Resolve the /triage command issuer to a git person.
 * Falls back to null (App authorship) for missing id, bot/app commenter, or lookup failure.
 * Private profile email still yields human path via id-based noreply.
 */
async function resolveTriggererGitPerson(params: {
  readonly prSurface: PrSurface;
  readonly commenterId?: number;
  readonly botIdentity: BotIdentity;
  readonly analytics: TriageAnalyticsRef;
}): Promise<GitPerson | null> {
  if (params.commenterId == null) return null;
  if (params.commenterId === params.botIdentity.userId) return null;
  try {
    const data = await params.prSurface.lookupGitHubUser(params.commenterId);
    if (data == null) return null;
    return gitPersonFromGithubUser(data);
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logWarn("triage_commit_identity_lookup_failed", {
      commenterId: params.commenterId,
      message: errorObj.message,
    });
    captureTriageEvent(params.analytics, "triage commit identity fallback", {
      step: "commit_identity",
      fallback: "app",
      reason: "lookup_failed",
    });
    return null;
  }
}

async function runFreshTriageAgent(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly headRef: string;
  readonly botIdentity: BotIdentity;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly reportContext: TriageReportContext;
  readonly leaseEpoch: number | null;
  readonly signal: AbortSignal;
  readonly mode: "apply" | "preview";
}): Promise<TriageExecuteResult> {
  const triggerer = await resolveTriggererGitPerson({
    prSurface: params.prSurface,
    commenterId: params.item.payload.commenterId,
    botIdentity: params.botIdentity,
    analytics: params.analytics,
  });
  const commitAttribution = buildTriageCommitAttribution({
    botIdentity: params.botIdentity,
    triggerer,
  });
  captureTriageEvent(params.analytics, "triage commit identity resolved", {
    step: "commit_identity",
    source: commitAttribution.source,
  });
  const { token } = await params.prSurface.gitCredentialAuth();
  const preview = params.mode === "preview";
  return withWritablePrCheckout(
    {
      owner: params.item.owner,
      repo: params.item.repo,
      headRef: params.headRef,
      headSha: params.headSha,
      installationToken: token,
      botIdentity: params.botIdentity,
      commitAttribution,
      beforeCommit: preview
        ? () => ensureTriageNotCancelled(params.pool, params.item)
        : () =>
            ensureTriageWriteAllowed({
              pool: params.pool,
              item: params.item,
              prSurface: params.prSurface,
            }),
      beforePush: preview
        ? async () => {
            throw new AppError({
              code: "triage.preview_push_blocked",
              message: "Triage preview cannot push",
            });
          }
        : () =>
            ensureTriageWriteAllowed({
              pool: params.pool,
              item: params.item,
              prSurface: params.prSurface,
            }),
    },
    async (checkout) => {
      captureTriageEvent(params.analytics, "triage agent started", {
        inventory_count: params.inventory.length,
      });
      let result: Awaited<ReturnType<typeof runFullPrTriage>>;
      try {
        result = await runFullPrTriage({
          cfg: params.cfg,
          owner: params.item.owner,
          repo: params.item.repo,
          prNumber: params.item.prNumber,
          headSha: params.headSha,
          checkout,
          inventory: params.inventory,
          cwd: checkout.dir,
          scope: params.scope,
          refreshBeforeTool: async () => ensureTriageNotCancelled(params.pool, params.item),
          durability: {
            pool: params.pool,
            workItemId: params.item.id,
            installationId: params.item.installationId,
          },
        });
      } catch (error) {
        if (!(error instanceof TriageClosedPullRequestError)) throw error;
        await publishTriageReportOnly({
          pool: params.pool,
          workItemId: params.item.id,
          resourceKey: params.item.resourceKey,
          installationId: params.item.installationId,
          prSurface: params.prSurface,
          owner: params.item.owner,
          repo: params.item.repo,
          prNumber: params.item.prNumber,
          headSha: params.headSha,
          inventory: params.inventory,
          previouslyResolvedCount: params.previouslyResolvedCount,
          leaseEpoch: params.leaseEpoch,
          ...params.reportContext,
          body: reportOnlyBody({
            message: TRIAGE_CLOSED_PR_NOTICE,
            headSha: params.headSha,
            inventoryCount: params.inventory.length,
            previouslyResolvedCount: params.previouslyResolvedCount,
            scope: params.scope,
            threadRootCommentId: params.reportContext.threadRootCommentId,
          }),
        });
        return { kind: "completed", degraded: true };
      }
      await ensureTriageNotCancelled(params.pool, params.item);
      const commitByThreadRootCommentId = result.commitByThreadRootCommentId ?? new Map();
      if (!result.submitted || !result.payload) {
        const error = new AppError({
          code: "triage.missing_submit",
          message: "Triage run ended without submitTriage",
        });
        captureTriageFailure(params.analytics, "agent_run", error, {
          submitted: result.submitted,
        });
        throw error;
      }
      if (preview) {
        const detailBySha = new Map(
          checkout.listCommittedDetails().map((commit) => [commit.sha.toLowerCase(), commit]),
        );
        const hunks = [...commitByThreadRootCommentId.entries()].flatMap(
          ([threadRootCommentId, sha]) => {
            const detail = detailBySha.get(sha.toLowerCase());
            return detail == null
              ? []
              : [
                  {
                    threadRootCommentId,
                    subject: detail.subject,
                    diff: detail.diff,
                  },
                ];
          },
        );
        await publishTriagePreview({
          pool: params.pool,
          workItemId: params.item.id,
          resourceKey: params.item.resourceKey,
          installationId: params.item.installationId,
          prSurface: params.prSurface,
          owner: params.item.owner,
          repo: params.item.repo,
          prNumber: params.item.prNumber,
          headSha: params.headSha,
          inventory: params.inventory,
          previouslyResolvedCount: params.previouslyResolvedCount,
          leaseEpoch: params.leaseEpoch,
          hunks,
          payload: result.payload,
          ...params.reportContext,
        });
        captureTriageEvent(params.analytics, "triage preview published", {
          inventory_count: params.inventory.length,
          hunk_count: hunks.length,
        });
        return { kind: "completed" };
      }
      const publish = await publishTriage({
        pool: params.pool,
        workItemId: params.item.id,
        resourceKey: params.item.resourceKey,
        installationId: params.item.installationId,
        prSurface: params.prSurface,
        owner: params.item.owner,
        repo: params.item.repo,
        prNumber: params.item.prNumber,
        headSha: params.headSha,
        checkout,
        inventory: params.inventory,
        resolutionByRootCommentId: params.resolutionByRootCommentId,
        payload: result.payload,
        previouslyResolvedCount: params.previouslyResolvedCount,
        findingHistoryCfg: params.cfg,
        leaseEpoch: params.leaseEpoch,
        signal: params.signal,
        ...params.reportContext,
      });
      const completed = completedFromPublish(publish);
      if (completed.degraded) {
        captureTriageEvent(params.analytics, "triage degraded", {
          step: "publish",
          push_outcome: publish.pushOutcome,
          missing_thread_action: publish.missingThreadAction,
        });
      } else {
        captureTriageEvent(params.analytics, "triage published", {
          inventory_count: params.inventory.length,
          previously_resolved_count: params.previouslyResolvedCount,
          commit_count: checkout.listCommittedShas().length,
          push_outcome: publish.pushOutcome,
        });
      }
      return completed;
    },
  );
}

async function runBulkFromPreview(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly headRef: string;
  readonly botIdentity: BotIdentity;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
  readonly inventory: readonly BotFindingThread[];
  readonly approvedHunks: readonly {
    readonly threadRootCommentId: number;
    readonly subject: string;
    readonly diff: string;
  }[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly reportContext: TriageReportContext;
  readonly leaseEpoch: number | null;
  readonly signal: AbortSignal;
  readonly preview: StoredTriagePreviewDetail;
  readonly approvedIds: ReadonlySet<number>;
  readonly excludedIds: ReadonlySet<number>;
  readonly notInPreviewIds: ReadonlySet<number>;
}): Promise<TriageExecuteResult> {
  const triggerer = await resolveTriggererGitPerson({
    prSurface: params.prSurface,
    commenterId: params.item.payload.commenterId,
    botIdentity: params.botIdentity,
    analytics: params.analytics,
  });
  const commitAttribution = buildTriageCommitAttribution({
    botIdentity: params.botIdentity,
    triggerer,
  });
  const { token } = await params.prSurface.gitCredentialAuth();
  return withWritablePrCheckout(
    {
      owner: params.item.owner,
      repo: params.item.repo,
      headRef: params.headRef,
      headSha: params.headSha,
      installationToken: token,
      botIdentity: params.botIdentity,
      commitAttribution,
      beforeCommit: () =>
        ensureTriageWriteAllowed({
          pool: params.pool,
          item: params.item,
          prSurface: params.prSurface,
        }),
      beforePush: () =>
        ensureTriageWriteAllowed({
          pool: params.pool,
          item: params.item,
          prSurface: params.prSurface,
        }),
    },
    async (checkout) => {
      const replayed = await replayPreviewHunks({
        checkout,
        hunks: params.approvedHunks,
      });
      const payload = remapBulkPayload({
        payload: params.preview.payload,
        approvedIds: params.approvedIds,
        appliedCommits: replayed.commitByThreadRootCommentId,
      });
      await ensureTriageNotCancelled(params.pool, params.item);
      const publish = await publishTriage({
        pool: params.pool,
        workItemId: params.item.id,
        resourceKey: params.item.resourceKey,
        installationId: params.item.installationId,
        prSurface: params.prSurface,
        owner: params.item.owner,
        repo: params.item.repo,
        prNumber: params.item.prNumber,
        headSha: params.headSha,
        checkout,
        inventory: params.inventory,
        resolutionByRootCommentId: params.resolutionByRootCommentId,
        payload,
        previouslyResolvedCount: params.previouslyResolvedCount,
        findingHistoryCfg: params.cfg,
        leaseEpoch: params.leaseEpoch,
        signal: params.signal,
        bulkClassification: {
          excludedIds: params.excludedIds,
          notInPreviewIds: params.notInPreviewIds,
          commitByThreadRootCommentId: replayed.commitByThreadRootCommentId,
          commitErrors: replayed.commitErrors,
        },
        ...params.reportContext,
      });
      const completed = completedFromPublish(publish);
      if (replayed.commitErrors.length > 0 || publish.partialBulk === true) {
        return { kind: "completed", degraded: true };
      }
      if (completed.degraded) {
        captureTriageEvent(params.analytics, "triage degraded", {
          step: "publish",
          push_outcome: publish.pushOutcome,
          missing_thread_action: publish.missingThreadAction,
        });
      } else {
        captureTriageEvent(params.analytics, "triage published", {
          inventory_count: params.inventory.length,
          previously_resolved_count: params.previouslyResolvedCount,
          commit_count: checkout.listCommittedShas().length,
          push_outcome: publish.pushOutcome,
        });
      }
      return completed;
    },
  );
}

export async function executeTriageJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<TriageJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "triage",
    prActorLease: { queue: TRIAGE_QUEUE },
    resolveHeadSha: resolveWorkItemHead,
    execute: async (item, env) => {
      const scope = item.payload.scope ?? "all";
      const mode = triageMode(item.payload);
      const analytics = triageAnalyticsRef(item, scope);
      captureTriageEvent(analytics, "triage started");
      const { prSurface } = env;
      const headSha = env.headSha;
      await ensureTriageNotCancelled(pool, item);
      const branch = await loadPullRequestBranchInfo(prSurface);
      await ensureTriageNotCancelled(pool, item);
      if (!branch.sameRepo && mode !== "preview") {
        return handleForkPrReport({
          pool,
          item,
          prSurface,
          headSha,
          scope,
          analytics,
          leaseEpoch: env.leaseEpoch,
        });
      }

      let storedPreview: StoredTriagePreviewDetail | null = null;
      if (mode === "bulk") {
        storedPreview = parseStoredTriagePreviewDetail(
          await getLatestCompletedPublishStepDetail(
            pool,
            item.resourceKey,
            TRIAGE_PUBLISH_LENS,
            "triage_preview",
          ),
        );
        if (storedPreview == null) {
          await publishTriageReportOnly({
            pool,
            workItemId: item.id,
            resourceKey: item.resourceKey,
            installationId: item.installationId,
            prSurface,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            inventory: [],
            previouslyResolvedCount: 0,
            leaseEpoch: env.leaseEpoch,
            body: reportOnlyBody({
              message: TRIAGE_BULK_REQUIRES_PREVIEW,
              headSha,
              inventoryCount: 0,
              previouslyResolvedCount: 0,
              scope,
            }),
          });
          return { kind: "completed" };
        }
        if (storedPreview.headSha.toLowerCase() !== headSha.toLowerCase()) {
          await publishTriageReportOnly({
            pool,
            workItemId: item.id,
            resourceKey: item.resourceKey,
            installationId: item.installationId,
            prSurface,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            inventory: [],
            previouslyResolvedCount: 0,
            leaseEpoch: env.leaseEpoch,
            body: reportOnlyBody({
              message: TRIAGE_BULK_PREVIEW_STALE,
              headSha,
              inventoryCount: 0,
              previouslyResolvedCount: 0,
              scope,
            }),
          });
          return { kind: "completed" };
        }
      }

      const discovered = await resolveInventoryAndScope({
        cfg,
        pool,
        item,
        prSurface,
        scope,
        analytics,
      });
      await ensureTriageNotCancelled(pool, item);

      const currentInventory = discovered.inventory;
      const excludeIds = new Set(item.payload.excludeThreadRootCommentIds ?? []);
      const approval =
        mode === "bulk" && storedPreview != null
          ? previewApprovalSets({
              inventory: currentInventory,
              preview: storedPreview,
              excludeIds,
            })
          : null;

      if (currentInventory.length === 0) {
        return publishEmptyInventoryReport({
          pool,
          item,
          prSurface,
          headSha,
          scope,
          analytics,
          threads: discovered.threads,
          inventory: discovered.inventory,
          previouslyResolvedCount: discovered.previouslyResolvedCount,
          scopedThreadRootId: discovered.scopedThreadRootId,
          reportContext: discovered.reportContext,
          leaseEpoch: env.leaseEpoch,
        });
      }

      if (mode === "bulk" && approval != null && approval.approvedInventory.length === 0) {
        await publishTriageReportOnly({
          pool,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          installationId: item.installationId,
          prSurface,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          inventory: currentInventory,
          previouslyResolvedCount: discovered.previouslyResolvedCount,
          leaseEpoch: env.leaseEpoch,
          ...discovered.reportContext,
          body: reportOnlyBody({
            message: `No approved findings to apply. Excluded: ${
              [...approval.excludedIds].join(", ") || "none"
            }. Not in preview: ${[...approval.notInPreviewIds].join(", ") || "none"}.`,
            headSha,
            inventoryCount: currentInventory.length,
            previouslyResolvedCount: discovered.previouslyResolvedCount,
            scope,
          }),
        });
        return { kind: "completed" };
      }

      const doneStep = mode === "preview" ? "triage_preview" : "triage_report";
      if (await hasCompletedPublishStep(pool, item.id, item.resourceKey, "triage", doneStep)) {
        captureTriageEvent(analytics, "triage skipped", {
          reason: mode === "preview" ? "preview_already_published" : "report_already_published",
        });
        return { kind: "completed" };
      }

      await ensureTriageNotCancelled(pool, item);

      const resumeParams = {
        cfg,
        pool,
        item,
        prSurface,
        headSha,
        headRef: branch.headRef,
        analytics,
        inventory: approval?.approvedInventory ?? currentInventory,
        resolutionByRootCommentId: discovered.resolutionByRootCommentId,
        previouslyResolvedCount: discovered.previouslyResolvedCount,
        reportContext: discovered.reportContext,
        leaseEpoch: env.leaseEpoch,
        signal: env.signal,
      };

      if (mode !== "preview") {
        const resumed = await tryResumeStoredPush(resumeParams);
        if (resumed != null) return resumed;
      }

      switch (mode) {
        case "bulk":
          if (storedPreview == null || approval == null) {
            throw new AppError({
              code: "triage.invalid_preview",
              message: "Bulk apply reached execution without a parsed preview",
            });
          }
          return runBulkFromPreview({
            ...resumeParams,
            cfg,
            botIdentity: discovered.botIdentity,
            scope,
            inventory: currentInventory,
            approvedHunks: approval.approvedHunks,
            preview: storedPreview,
            approvedIds: approval.approvedIds,
            excludedIds: approval.excludedIds,
            notInPreviewIds: approval.notInPreviewIds,
          });
        case "preview":
        case "apply":
          return runFreshTriageAgent({
            ...resumeParams,
            inventory: currentInventory,
            cfg,
            botIdentity: discovered.botIdentity,
            scope,
            mode,
          });
        default: {
          const exhaustive: never = mode;
          return exhaustive;
        }
      }
    },
    onTerminalFailure: async (item, prSurface) => {
      if (!prSurface) return;
      const payload = item.payload;
      const analytics = triageAnalyticsRef(item, payload.scope ?? "all");
      if (
        await hasCompletedPublishStep(pool, item.id, item.resourceKey, "triage", "triage_report")
      ) {
        return;
      }
      captureTriageEvent(analytics, "triage terminal failure", {
        step: "failure_comment",
      });
      try {
        await prSurface.replyAt(
          { kind: "prConversation", prNumber: item.prNumber },
          TRIAGE_FAILURE_MESSAGE,
        );
      } catch (error) {
        captureTriageFailure(analytics, "failure_comment", error);
        throw error;
      }
    },
  });
}
