import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { getAppBotIdentity, installationOctokit } from "../../github/appAuth.js";
import { listReviewThreadResolution } from "../../github/reviewThreadResolution.js";
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

type PullRequestBranchInfo = {
  readonly headRef: string;
  readonly sameRepo: boolean;
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

function triageReportContext(payload: TriageWorkPayload, threadRootCommentId?: number) {
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
      throw new Error("Stored triage push cannot create new commits");
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
      const payload = item.payload as TriageWorkPayload;
      const scope = payload.scope ?? "all";
      const analytics = triageAnalyticsRef(item, scope);
      captureTriageEvent(analytics, "triage started");
      const tokenState = { installation: env.installation };
      const headSha = env.headSha;
      const branch = await loadPullRequestBranchInfo({
        token: tokenState.installation.token,
        tokenExpiresAtTs: tokenState.installation.expiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
      });
      if (!branch.sameRepo) {
        captureTriageEvent(analytics, "triage report only", { outcome: "fork_pr" });
        await publishTriageReportOnly({
          pool,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          installationId: item.installationId,
          token: tokenState.installation.token,
          tokenExpiresAtTs: tokenState.installation.expiresAtTs,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          inventory: [],
          previouslyResolvedCount: 0,
          body: reportOnlyBody({
            message: TRIAGE_FORK_PR_NOTICE,
            headSha,
            inventoryCount: 0,
            previouslyResolvedCount: 0,
            scope,
          }),
        });
        return {};
      }

      const botIdentity = await getAppBotIdentity(cfg);
      const eligibleReviews = await listTriageEligibleInlineReviews(pool, item.resourceKey);
      const [threads, resolutionByRootCommentId] = await Promise.all([
        fetchBotFindingThreads(
          tokenState.installation.token,
          item.owner,
          item.repo,
          item.prNumber,
          botIdentity.userId,
          eligibleReviews,
        ),
        listReviewThreadResolution(
          tokenState.installation.token,
          item.owner,
          item.repo,
          item.prNumber,
          tokenState.installation.expiresAtTs,
        ),
      ]);
      captureTriageEvent(analytics, "triage inventory discovered", {
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
      if (scope === "thread") {
        if (payload.threadAnchorCommentId != null) {
          scopedThreadRootId =
            payload.needsThreadRootResolution === true
              ? await resolveScopedThreadRootId({
                  token: tokenState.installation.token,
                  owner: item.owner,
                  repo: item.repo,
                  prNumber: item.prNumber,
                  anchorCommentId: payload.threadAnchorCommentId,
                  analytics,
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
      const reportContext = triageReportContext(payload, scopedThreadRootId);

      if (inventory.length === 0) {
        const threadMatchesKnownFinding =
          scope === "thread" &&
          scopedThreadRootId != null &&
          threads.some((thread) => thread.rootCommentId === scopedThreadRootId);
        const outcome =
          scope === "thread"
            ? threadMatchesKnownFinding
              ? "all_resolved"
              : "thread_not_eligible"
            : threads.length === 0
              ? "no_eligible_findings"
              : "all_resolved";
        const message =
          scope === "thread"
            ? threadMatchesKnownFinding
              ? TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED
              : TRIAGE_THREAD_NOT_ELIGIBLE
            : threads.length === 0
              ? TRIAGE_NO_ELIGIBLE_FINDINGS
              : TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED;
        captureTriageEvent(analytics, "triage report only", {
          outcome,
          previously_resolved_count: previouslyResolvedCount,
        });
        await publishTriageReportOnly({
          pool,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          installationId: item.installationId,
          token: tokenState.installation.token,
          tokenExpiresAtTs: tokenState.installation.expiresAtTs,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          inventory,
          previouslyResolvedCount,
          ...reportContext,
          body: reportOnlyBody({
            message,
            headSha,
            inventoryCount: scope === "thread" ? inventory.length : threads.length,
            previouslyResolvedCount,
            scope,
            threadRootCommentId: scopedThreadRootId,
          }),
        });
        return {};
      }

      if (
        await hasCompletedPublishStep(pool, item.id, item.resourceKey, "triage", "triage_report")
      ) {
        captureTriageEvent(analytics, "triage skipped", { reason: "report_already_published" });
        return {};
      }

      let storedPushDetail = await getCompletedPublishStepDetail(
        pool,
        item.id,
        item.resourceKey,
        "triage",
        "triage_push",
      );
      if (storedPushDetail == null) {
        storedPushDetail = await getCompletedPublishStepDetailWithoutNewerStep(
          pool,
          item.resourceKey,
          "triage",
          "triage_push",
          "triage_report",
        );
      }
      if (storedPushDetail != null) {
        const parsed = parseStoredTriagePushDetail(storedPushDetail);
        if (!parsed) {
          const error = new Error("Stored triage_push detail is invalid");
          captureTriageFailure(analytics, "parse_stored_push", error);
          throw error;
        }
        if (parsed.pushed && storedPushMatchesInventory(parsed, headSha, inventory)) {
          captureTriageEvent(analytics, "triage resumed", {
            inventory_count: inventory.length,
            commit_count: parsed.commits.length,
          });
          const publish = await publishTriage({
            pool,
            workItemId: item.id,
            resourceKey: item.resourceKey,
            installationId: item.installationId,
            token: tokenState.installation.token,
            tokenExpiresAtTs: tokenState.installation.expiresAtTs,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            checkout: checkoutFromStoredPush(branch.headRef, headSha, parsed),
            inventory,
            resolutionByRootCommentId,
            payload: parsed.payload,
            previouslyResolvedCount,
            priorPush: parsed,
            ...reportContext,
          });
          if (publish.degraded) {
            captureTriageEvent(analytics, "triage degraded", { step: "publish_resume" });
          } else {
            captureTriageEvent(analytics, "triage published", {
              inventory_count: inventory.length,
              resumed: true,
            });
          }
          return publish.degraded ? { degraded: true } : {};
        }
      }

      return withWritablePrCheckout(
        {
          cfg,
          owner: item.owner,
          repo: item.repo,
          headRef: branch.headRef,
          headSha,
          installationToken: tokenState.installation.token,
          botIdentity,
        },
        async (checkout) => {
          captureTriageEvent(analytics, "triage agent started", {
            inventory_count: inventory.length,
          });
          const result = await runFullPrTriage({
            cfg,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            checkout,
            inventory,
            cwd: checkout.dir,
            scope,
          });
          if (!result.submitted || !result.payload) {
            const error = new Error("Triage run ended without submitTriage");
            captureTriageFailure(analytics, "agent_run", error, {
              submitted: result.submitted,
            });
            throw error;
          }
          const publish = await publishTriage({
            pool,
            workItemId: item.id,
            resourceKey: item.resourceKey,
            installationId: item.installationId,
            token: tokenState.installation.token,
            tokenExpiresAtTs: tokenState.installation.expiresAtTs,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            checkout,
            inventory,
            resolutionByRootCommentId,
            payload: result.payload,
            previouslyResolvedCount,
            ...reportContext,
          });
          if (publish.degraded) {
            captureTriageEvent(analytics, "triage degraded", { step: "publish" });
          } else {
            captureTriageEvent(analytics, "triage published", {
              inventory_count: inventory.length,
              previously_resolved_count: previouslyResolvedCount,
              commit_count: checkout.listCommittedShas().length,
            });
          }
          return publish.degraded ? { degraded: true } : {};
        },
      );
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation) return;
      const payload = item.payload as TriageWorkPayload;
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
