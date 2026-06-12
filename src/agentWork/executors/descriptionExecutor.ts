import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { runFullPrDescription } from "../../agent/descriptionRun.js";
import { installationOctokit } from "../../github/appAuth.js";
import { logWarn } from "../../evlog.js";
import { DESCRIPTION_FAILURE_MESSAGE, DESCRIPTION_PUBLISH_LENS } from "../../settings/index.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { recordPublishStep, shouldSkipWork } from "../repository.js";
import {
  makeInstallationTokenRefresher,
  resolveWorkItemHead,
  runDurableWorkItem,
} from "../durableJob.js";
import { type DescriptionJobData, type DescriptionWorkPayload } from "../types.js";
export async function executeDescriptionJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<DescriptionJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "description",
    resolveHeadSha: resolveWorkItemHead,
    execute: async (item, env) => {
      const tokenState = { installation: env.installation };
      const headSha = env.headSha;
      const payload = item.payload as DescriptionWorkPayload;
      return withPrRepositoryView(
        {
          cfg,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          installationToken: tokenState.installation.token,
          installationExpiresAtTs: tokenState.installation.expiresAtTs,
          pullRequest: env.pullRequest,
          repositorySizeKb: payload.repositorySizeKb,
        },
        async (repositoryView) => {
          const result = await runFullPrDescription({
            cfg,
            token: tokenState.installation.token,
            tokenExpiresAtTs: tokenState.installation.expiresAtTs,
            tokenTtlMs: tokenState.installation.ttlMs,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            userSupplement: payload.userSupplement,
            cwd: repositoryView.agentCwd,
            workspace: repositoryView.workspace,
            shouldAbortPublish: async () => shouldSkipWork(pool, item),
            recordPublishStep: (detail) =>
              recordPublishStep(pool, {
                workItemId: item.id,
                resourceKey: item.resourceKey,
                reviewLens: DESCRIPTION_PUBLISH_LENS,
                step: "pr_body",
                detail,
              }),
            refreshInstallationToken: makeInstallationTokenRefresher(
              cfg,
              item.installationId,
              tokenState,
            ),
          });
          if (!result.published && !result.publishSuperseded) {
            logWarn("description_not_published", {
              owner: item.owner,
              repo: item.repo,
              pr: item.prNumber,
            });
            return { degraded: true };
          }
          return {};
        },
      );
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation) return;
      const payload = item.payload as DescriptionWorkPayload;
      if (payload.source !== "slash") return;
      const octokit = installationOctokit(installation.token, installation.expiresAtTs);
      await octokit.rest.issues.createComment({
        owner: item.owner,
        repo: item.repo,
        issue_number: item.prNumber,
        body: DESCRIPTION_FAILURE_MESSAGE,
      });
    },
  });
}
