import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import { getAppBotIdentity, installationOctokit, type BotIdentity } from "../../github/appAuth.js";
import {
  listReviewThreadResolution,
  type ReviewThreadResolution,
} from "../../github/reviewThreadResolution.js";
import {
  fetchBotFindingThreads,
  fetchReviewCommentParentGraph,
  resolveReviewThreadRootId,
  type BotFindingThread,
} from "../../review/run/reviewPriorFeedback.js";
import { runFullPrTriage } from "../../agent/triage/triageRun.js";
import {
  parseStoredTriagePushDetail,
  publishTriage,
  publishTriageReportOnly,
  type StoredTriagePushDetail,
} from "../../agent/triage/publishTriage.js";
import {
  captureTriageEvent,
  captureTriageFailure,
  type TriageAnalyticsRef,
} from "../triageAnalytics.js";
import {
  TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  TRIAGE_FAILURE_MESSAGE,
  TRIAGE_FORK_PR_NOTICE,
  TRIAGE_NO_ELIGIBLE_FINDINGS,
  TRIAGE_THREAD_NOT_ELIGIBLE,
  TRIAGE_SUMMARY_SENTINEL,
} from "../../settings/index.js";
import { type WritablePrCheckout, withWritablePrCheckout } from "../../prWorkspace/index.js";
import {
  getCompletedPublishStepDetail,
  getCompletedPublishStepDetailWithoutNewerStep,
  hasCompletedPublishStep,
  listTriageEligibleInlineReviews,
} from "../repository.js";
import { resolveWorkItemHead, runDurableWorkItem } from "../durableJob.js";
import { type TriageJobData, type TriageWorkPayload, type AgentWorkItem } from "../types.js";

type TriageWorkItem = Extract<AgentWorkItem, { type: "triage" }>;

type TriageExecuteResult = {
  readonly degraded?: boolean;
};

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

async function loadPullRequestBranchInfo(params: {
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): Promise<PullRequestBranchInfo> {
  const octokit = installationOctokit(params.token, params.tokenExpiresAtTs);
  const { data } = await octokit.rest.pulls.get({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
  });
  return {
    headRef: data.head.ref,
    sameRepo: data.head.repo?.full_name === data.base.repo?.full_name,
  };
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
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly anchorCommentId: number;
  readonly analytics: TriageAnalyticsRef;
}): Promise<number> {
  try {
    const commentGraph = await fetchReviewCommentParentGraph(
      params.token,
      params.owner,
      params.repo,
      params.prNumber,
    );
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
  if (detail.pushed && detail.pushedHeadSha?.toLowerCase() !== headSha.toLowerCase()) return false;
  const verdictIds = new Set(detail.payload.verdicts.map((verdict) => verdict.threadRootCommentId));
  if (verdictIds.size !== inventory.length) return false;
  return inventory.every((thread) => verdictIds.has(thread.rootCommentId));
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
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly headSha: string;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
}): Promise<TriageExecuteResult> {
  captureTriageEvent(params.analytics, "triage report only", { outcome: "fork_pr" });
  await publishTriageReportOnly({
    pool: params.pool,
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    installationId: params.item.installationId,
    token: params.token,
    tokenExpiresAtTs: params.tokenExpiresAtTs,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
    headSha: params.headSha,
    inventory: [],
    previouslyResolvedCount: 0,
    body: reportOnlyBody({
      message: TRIAGE_FORK_PR_NOTICE,
      headSha: params.headSha,
      inventoryCount: 0,
      previouslyResolvedCount: 0,
      scope: params.scope,
    }),
  });
  return {};
}

async function resolveInventoryAndScope(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
}): Promise<InventoryAndScope> {
  const payload = params.item.payload;
  const botIdentity = await getAppBotIdentity(params.cfg);
  const eligibleReviews = await listTriageEligibleInlineReviews(
    params.pool,
    params.item.resourceKey,
  );
  const [threads, resolutionByRootCommentId] = await Promise.all([
    fetchBotFindingThreads(
      params.token,
      params.item.owner,
      params.item.repo,
      params.item.prNumber,
      botIdentity.userId,
      eligibleReviews,
    ),
    listReviewThreadResolution(
      params.token,
      params.item.owner,
      params.item.repo,
      params.item.prNumber,
      params.tokenExpiresAtTs,
    ),
  ]);
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
              token: params.token,
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
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly headSha: string;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
  readonly threads: readonly BotFindingThread[];
  readonly inventory: readonly BotFindingThread[];
  readonly previouslyResolvedCount: number;
  readonly scopedThreadRootId: number | undefined;
  readonly reportContext: TriageReportContext;
}): Promise<TriageExecuteResult> {
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
    token: params.token,
    tokenExpiresAtTs: params.tokenExpiresAtTs,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
    headSha: params.headSha,
    inventory: params.inventory,
    previouslyResolvedCount: params.previouslyResolvedCount,
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
  return {};
}

async function tryResumeStoredPush(params: {
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly analytics: TriageAnalyticsRef;
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly reportContext: TriageReportContext;
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
  if (!parsed.pushed || !storedPushMatchesInventory(parsed, params.headSha, params.inventory)) {
    return null;
  }

  captureTriageEvent(params.analytics, "triage resumed", {
    inventory_count: params.inventory.length,
    commit_count: parsed.commits.length,
  });
  const publish = await publishTriage({
    pool: params.pool,
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    installationId: params.item.installationId,
    token: params.token,
    tokenExpiresAtTs: params.tokenExpiresAtTs,
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
    ...params.reportContext,
  });
  if (publish.degraded) {
    captureTriageEvent(params.analytics, "triage degraded", { step: "publish_resume" });
  } else {
    captureTriageEvent(params.analytics, "triage published", {
      inventory_count: params.inventory.length,
      resumed: true,
    });
  }
  return publish.degraded ? { degraded: true } : {};
}

async function runFreshTriageAgent(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly botIdentity: BotIdentity;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly analytics: TriageAnalyticsRef;
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly reportContext: TriageReportContext;
}): Promise<TriageExecuteResult> {
  return withWritablePrCheckout(
    {
      owner: params.item.owner,
      repo: params.item.repo,
      headRef: params.headRef,
      headSha: params.headSha,
      installationToken: params.token,
      botIdentity: params.botIdentity,
    },
    async (checkout) => {
      captureTriageEvent(params.analytics, "triage agent started", {
        inventory_count: params.inventory.length,
      });
      const result = await runFullPrTriage({
        cfg: params.cfg,
        owner: params.item.owner,
        repo: params.item.repo,
        prNumber: params.item.prNumber,
        headSha: params.headSha,
        checkout,
        inventory: params.inventory,
        cwd: checkout.dir,
        scope: params.scope,
      });
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
      const publish = await publishTriage({
        pool: params.pool,
        workItemId: params.item.id,
        resourceKey: params.item.resourceKey,
        installationId: params.item.installationId,
        token: params.token,
        tokenExpiresAtTs: params.tokenExpiresAtTs,
        owner: params.item.owner,
        repo: params.item.repo,
        prNumber: params.item.prNumber,
        headSha: params.headSha,
        checkout,
        inventory: params.inventory,
        resolutionByRootCommentId: params.resolutionByRootCommentId,
        payload: result.payload,
        previouslyResolvedCount: params.previouslyResolvedCount,
        ...params.reportContext,
      });
      if (publish.degraded) {
        captureTriageEvent(params.analytics, "triage degraded", { step: "publish" });
      } else {
        captureTriageEvent(params.analytics, "triage published", {
          inventory_count: params.inventory.length,
          previously_resolved_count: params.previouslyResolvedCount,
          commit_count: checkout.listCommittedShas().length,
        });
      }
      return publish.degraded ? { degraded: true } : {};
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
    resolveHeadSha: resolveWorkItemHead,
    execute: async (item, env) => {
      const scope = item.payload.scope ?? "all";
      const analytics = triageAnalyticsRef(item, scope);
      captureTriageEvent(analytics, "triage started");
      const token = env.installation.token;
      const tokenExpiresAtTs = env.installation.expiresAtTs;
      const headSha = env.headSha;
      const branch = await loadPullRequestBranchInfo({
        token,
        tokenExpiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
      });
      if (!branch.sameRepo) {
        return handleForkPrReport({
          pool,
          item,
          token,
          tokenExpiresAtTs,
          headSha,
          scope,
          analytics,
        });
      }

      const discovered = await resolveInventoryAndScope({
        cfg,
        pool,
        item,
        token,
        tokenExpiresAtTs,
        scope,
        analytics,
      });
      if (discovered.inventory.length === 0) {
        return publishEmptyInventoryReport({
          pool,
          item,
          token,
          tokenExpiresAtTs,
          headSha,
          scope,
          analytics,
          threads: discovered.threads,
          inventory: discovered.inventory,
          previouslyResolvedCount: discovered.previouslyResolvedCount,
          scopedThreadRootId: discovered.scopedThreadRootId,
          reportContext: discovered.reportContext,
        });
      }

      if (
        await hasCompletedPublishStep(pool, item.id, item.resourceKey, "triage", "triage_report")
      ) {
        captureTriageEvent(analytics, "triage skipped", { reason: "report_already_published" });
        return {};
      }

      const resumeParams = {
        pool,
        item,
        token,
        tokenExpiresAtTs,
        headSha,
        headRef: branch.headRef,
        analytics,
        inventory: discovered.inventory,
        resolutionByRootCommentId: discovered.resolutionByRootCommentId,
        previouslyResolvedCount: discovered.previouslyResolvedCount,
        reportContext: discovered.reportContext,
      };
      const resumed = await tryResumeStoredPush(resumeParams);
      if (resumed != null) return resumed;

      return runFreshTriageAgent({
        ...resumeParams,
        cfg,
        botIdentity: discovered.botIdentity,
        scope,
      });
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation) return;
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
        const octokit = installationOctokit(installation.token, installation.expiresAtTs);
        await octokit.rest.issues.createComment({
          owner: item.owner,
          repo: item.repo,
          issue_number: item.prNumber,
          body: TRIAGE_FAILURE_MESSAGE,
        });
      } catch (error) {
        captureTriageFailure(analytics, "failure_comment", error);
        throw error;
      }
    },
  });
}
