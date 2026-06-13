import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { getAppBotIdentity, installationOctokit } from "../../github/appAuth.js";
import { listReviewThreadResolution } from "../../github/reviewThreadResolution.js";
import { fetchBotFindingThreads } from "../../review/reviewPriorFeedback.js";
import { runFullPrTriage } from "../../agent/triageRun.js";
import { publishTriage, publishTriageReportOnly } from "../../agent/publishTriage.js";
import {
  TRIAGE_FAILURE_MESSAGE,
  TRIAGE_FORK_PR_NOTICE,
  TRIAGE_NO_PRIOR_FINDINGS,
  TRIAGE_SUMMARY_SENTINEL,
} from "../../settings/index.js";
import { withWritablePrCheckout } from "../../prWorkspace/index.js";
import { hasCompletedPublishStep } from "../repository.js";
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

function reportOnlyBody(message: string, headSha: string, inventoryCount: number): string {
  return [
    TRIAGE_SUMMARY_SENTINEL,
    "",
    message,
    "",
    `Evaluated head: \`${headSha}\``,
    `Inventory items: ${inventoryCount}`,
  ].join("\n");
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
          body: reportOnlyBody(TRIAGE_FORK_PR_NOTICE, headSha, 0),
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
          body: reportOnlyBody(TRIAGE_NO_PRIOR_FINDINGS, headSha, threads.length),
        });
        return {};
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
