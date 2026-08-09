import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { captureEvent } from "../../analytics/index.js";
import { runFullPrDescription } from "../../agent/description/descriptionRun.js";
import {
  classifyFailure,
  classifiedFailureLogFields,
  classifiedFailurePostHogProperties,
} from "../../errors/classifiedFailure.js";
import { logWarn } from "../../evlog.js";
import { prBodyHasAgentDescriptionBlock } from "../../agent/description/descriptionBodyMerge.js";
import { DESCRIPTION_FAILURE_MESSAGE, DESCRIPTION_PUBLISH_LENS } from "../../settings/index.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import { isExecutionEpochCurrent, recordPublishStep, shouldSkipWork } from "../repository.js";
import { resolveWorkItemHead, runDurableWorkItem } from "../durableJob.js";
import { type DescriptionJobData } from "../types.js";
import { buildRepositoryViewParams } from "./repositoryViewParams.js";

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
      const { prSurface } = env;
      const headSha = env.headSha;
      const payload = item.payload;
      const gitCredentialToken = await prSurface.gitCredentialToken();
      return withPrRepositoryView(
        buildRepositoryViewParams(
          item,
          { installationToken: gitCredentialToken, headSha, pullRequest: env.pullRequest },
          payload,
        ),
        async (repositoryView) => {
          const result = await runFullPrDescription({
            cfg,
            prSurface,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            userSupplement: payload.userSupplement,
            cwd: repositoryView.agentCwd,
            workspace: repositoryView.workspace,
            shouldAbortPublish: async () =>
              env.signal.aborted ||
              (await shouldSkipWork(pool, item)) ||
              !(await isExecutionEpochCurrent(pool, item.id, env.executionEpoch)),
            recordPublishStep: (detail) =>
              recordPublishStep(pool, {
                workItemId: item.id,
                resourceKey: item.resourceKey,
                reviewLens: DESCRIPTION_PUBLISH_LENS,
                step: "pr_body",
                detail,
                executionEpoch: env.executionEpoch,
              }),
            operationIntent: {
              client: pool,
              workItemId: item.id,
              resourceKey: item.resourceKey,
              executionEpoch: env.executionEpoch,
            },
            durability: {
              pool,
              workItemId: item.id,
              installationId: item.installationId,
            },
          });
          if (!result.published && !result.publishSuperseded) {
            const failure = classifyFailure(new Error("Description was not published"), {
              phase: "publish",
            });
            logWarn("description_not_published", {
              owner: item.owner,
              repo: item.repo,
              pr: item.prNumber,
              ...classifiedFailureLogFields(failure),
            });
            captureEvent({
              distinctId: `installation:${item.installationId}`,
              event: "description failed",
              properties: {
                owner: item.owner,
                repo: item.repo,
                pr_number: item.prNumber,
                source: payload.source,
                ...classifiedFailurePostHogProperties(failure),
              },
            });
            return { degraded: true };
          }
          if (result.published) {
            captureEvent({
              distinctId: `installation:${item.installationId}`,
              event: "description published",
              properties: {
                owner: item.owner,
                repo: item.repo,
                pr_number: item.prNumber,
                source: payload.source,
              },
            });
          }
          return {};
        },
      );
    },
    onTerminalFailure: async (item, prSurface) => {
      if (!prSurface) return;
      const payload = item.payload;
      if (payload.source !== "slash") {
        const body = await prSurface.getPullRequestBody();
        if (prBodyHasAgentDescriptionBlock(body)) return;
      }
      await prSurface.replyAt(
        { kind: "prConversation", prNumber: item.prNumber },
        DESCRIPTION_FAILURE_MESSAGE,
      );
    },
  });
}
