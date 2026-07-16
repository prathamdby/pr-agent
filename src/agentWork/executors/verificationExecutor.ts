import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { logInfo } from "../../evlog.js";
import { getAppBotIdentity, installationOctokit } from "../../github/appAuth.js";
import { listReviewThreadResolution } from "../../github/reviewThreadResolution.js";
import { listCommitCompareFiles } from "../../github/compareCommitFiles.js";
import { fetchPullRequestFiles } from "../../github/listPullRequestFiles.js";
import { paginateOctokitPages } from "../../github/paginateOctokit.js";
import { fetchBotFindingThreads } from "../../review/run/reviewPriorFeedback.js";
import { runVerification } from "../../agent/verification/verificationRun.js";
import { publishVerification } from "../../agent/verification/publishVerification.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { PR_COMMITS_MAX_PAGES, PR_COMMITS_PAGE_SIZE } from "../../settings/index.js";
import { listTriageEligibleInlineReviews } from "../repository.js";
import { resolveWorkItemHead, runDurableWorkItem } from "../durableJob.js";
import { type VerificationJobData } from "../types.js";

type PushedCommit = {
  readonly sha: string;
  readonly subject: string;
};

async function listPushedCommits(params: {
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): Promise<PushedCommit[]> {
  const octokit = installationOctokit(params.token, params.tokenExpiresAtTs);
  const commits = await paginateOctokitPages({
    perPage: PR_COMMITS_PAGE_SIZE,
    maxPages: PR_COMMITS_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.pulls.listCommits({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.prNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  return commits.map((commit) => ({
    sha: commit.sha,
    subject: commit.commit.message.split("\n")[0] ?? "",
  }));
}

export async function executeVerificationJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<VerificationJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "verification",
    resolveHeadSha: resolveWorkItemHead,
    execute: async (item, env) => {
      const payload = item.payload;
      const tokenState = { installation: env.installation };
      const headSha = env.headSha;
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

      const unresolvedThreads = threads.filter(
        (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved !== true,
      );

      if (unresolvedThreads.length === 0) {
        logInfo("verification_short_circuit_no_open_findings", {
          type: "verification",
          workItemId: item.id,
          resourceKey: item.resourceKey,
          threadCount: threads.length,
        });
        return {};
      }

      const [prFiles, pushedCommits, pushDeltaFiles] = await Promise.all([
        fetchPullRequestFiles(
          tokenState.installation.token,
          item.owner,
          item.repo,
          item.prNumber,
          {
            maxPrFilesListed: cfg.maxPrFilesListed,
            maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
          },
          env.pullRequest,
          tokenState.installation.expiresAtTs,
        ),
        listPushedCommits({
          token: tokenState.installation.token,
          tokenExpiresAtTs: tokenState.installation.expiresAtTs,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
        }),
        payload.pushBeforeSha != null
          ? listCommitCompareFiles({
              token: tokenState.installation.token,
              tokenExpiresAtTs: tokenState.installation.expiresAtTs,
              owner: item.owner,
              repo: item.repo,
              base: payload.pushBeforeSha,
              head: headSha,
            })
          : Promise.resolve(null),
      ]);

      const changedFilePaths =
        pushDeltaFiles != null ? pushDeltaFiles.files : ([] as readonly string[]);

      const result = await withPrRepositoryView(
        {
          cfg,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          installationToken: tokenState.installation.token,
          installationExpiresAtTs: tokenState.installation.expiresAtTs,
          prFiles,
          pullRequest: env.pullRequest,
          repositorySizeKb: payload.repositorySizeKb,
        },
        async (view) => {
          const runResult = await runVerification({
            cfg,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            rootDir: view.agentCwd,
            inventory: unresolvedThreads,
            pushedCommits,
          });
          if (!runResult.submitted || !runResult.payload) {
            throw new Error("Verification run ended without submitVerification");
          }
          return runResult;
        },
      );

      if (!result.payload) {
        throw new Error("Verification run ended without submitVerification");
      }

      const publish = await publishVerification({
        pool,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        token: tokenState.installation.token,
        tokenExpiresAtTs: tokenState.installation.expiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha,
        inventory: unresolvedThreads,
        resolutionByRootCommentId,
        payload: result.payload,
        changedFilePaths,
      });

      return publish.degraded ? { degraded: true } : {};
    },
  });
}
