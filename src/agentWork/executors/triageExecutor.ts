import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { posthog } from "../../posthog.js";
import { getAppBotIdentity, installationOctokit } from "../../github/appAuth.js";
import { listReviewThreadResolution } from "../../github/reviewThreadResolution.js";
import { fetchBotFindingThreads, type BotFindingThread } from "../../review/reviewPriorFeedback.js";
import { runFullPrTriage } from "../../agent/triageRun.js";
import {
  parseStoredTriagePushDetail,
  publishTriage,
  publishTriageReportOnly,
  type StoredTriagePushDetail,
} from "../../agent/publishTriage.js";
import {
  TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  TRIAGE_FAILURE_MESSAGE,
  TRIAGE_FORK_PR_NOTICE,
  TRIAGE_NO_PRIOR_FINDINGS,
  TRIAGE_SUMMARY_SENTINEL,
} from "../../settings/index.js";
import { type WritablePrCheckout, withWritablePrCheckout } from "../../prWorkspace/index.js";
import {
  getCompletedPublishStepDetail,
  getCompletedPublishStepDetailWithoutNewerStep,
  hasCompletedPublishStep,
} from "../repository.js";
import { resolveWorkItemHead, runDurableWorkItem } from "../durableJob.js";
import { type TriageJobData } from "../types.js";

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

function reportOnlyBody(params: {
  readonly message: string;
  readonly headSha: string;
  readonly inventoryCount: number;
  readonly previouslyResolvedCount: number;
}): string {
  return [
    TRIAGE_SUMMARY_SENTINEL,
    "",
    params.message,
    "",
    `Evaluated head: \`${params.headSha}\``,
    `Inventory items: ${params.inventoryCount}`,
    `Previously resolved: ${params.previouslyResolvedCount}`,
  ].join("\n");
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
        await publishTriageReportOnly({
          pool,
          workItemId: item.id,
          resourceKey: item.resourceKey,
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
          }),
        });
        return {};
      }

      const botIdentity = await getAppBotIdentity(cfg);
      const [threads, resolutionByRootCommentId] = await Promise.all([
        fetchBotFindingThreads(
          tokenState.installation.token,
          item.owner,
          item.repo,
          item.prNumber,
          botIdentity.userId,
        ),
        listReviewThreadResolution(
          tokenState.installation.token,
          item.owner,
          item.repo,
          item.prNumber,
          tokenState.installation.expiresAtTs,
        ),
      ]);
      const previouslyResolvedCount = threads.filter(
        (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved === true,
      ).length;
      const inventory = threads.filter(
        (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved !== true,
      );

      if (inventory.length === 0) {
        await publishTriageReportOnly({
          pool,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          token: tokenState.installation.token,
          tokenExpiresAtTs: tokenState.installation.expiresAtTs,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          inventory,
          previouslyResolvedCount,
          body: reportOnlyBody({
            message:
              threads.length === 0 ? TRIAGE_NO_PRIOR_FINDINGS : TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
            headSha,
            inventoryCount: threads.length,
            previouslyResolvedCount,
          }),
        });
        return {};
      }

      if (
        await hasCompletedPublishStep(pool, item.id, item.resourceKey, "triage", "triage_report")
      ) {
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
        if (!parsed) throw new Error("Stored triage_push detail is invalid");
        if (parsed.pushed && storedPushMatchesInventory(parsed, headSha, inventory)) {
          const publish = await publishTriage({
            pool,
            workItemId: item.id,
            resourceKey: item.resourceKey,
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
          });
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
          const result = await runFullPrTriage({
            cfg,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            checkout,
            inventory,
            cwd: checkout.dir,
          });
          if (!result.submitted || !result.payload) {
            throw new Error("Triage run ended without submitTriage");
          }
          const publish = await publishTriage({
            pool,
            workItemId: item.id,
            resourceKey: item.resourceKey,
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
          });
          if (!publish.degraded) {
            posthog.capture({
              distinctId: `installation:${item.installationId}`,
              event: "triage completed",
              properties: {
                owner: item.owner,
                repo: item.repo,
                pr_number: item.prNumber,
                inventory_count: inventory.length,
                previously_resolved_count: previouslyResolvedCount,
              },
            });
          }
          return publish.degraded ? { degraded: true } : {};
        },
      );
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation) return;
      if (
        await hasCompletedPublishStep(pool, item.id, item.resourceKey, "triage", "triage_report")
      ) {
        return;
      }
      const octokit = installationOctokit(installation.token, installation.expiresAtTs);
      await octokit.rest.issues.createComment({
        owner: item.owner,
        repo: item.repo,
        issue_number: item.prNumber,
        body: TRIAGE_FAILURE_MESSAGE,
      });
    },
  });
}
