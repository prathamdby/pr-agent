import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.js";

import { durationMsFromClaim } from "../../analytics/workCompleted.js";
import { captureDurableWorkCompletedWithCi } from "../ciWorkTelemetry.js";
import { runFullPrDescription } from "../../agent/description/descriptionRun.js";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.js";
import { logWarn } from "../../evlog.js";
import { prBodyHasAgentDescriptionBlock } from "../../agent/description/descriptionBodyMerge.js";
import { DESCRIPTION_FAILURE_MESSAGE, DESCRIPTION_PUBLISH_LENS } from "../../settings/index.js";
import { recordPublishStep } from "../repository.js";

export function createDescriptionWorkExecution({
  cfg,
  pool,
}: WorkExecutionDependencies): WorkExecution<"description"> {
  return {
    execute: async (item, env) => {
      const { prSurface } = env;
      const headSha = env.headSha;
      const payload = item.payload;
      return env.withAdmittedRepositoryView(
        {
          repositorySizeKb: payload.repositorySizeKb,
        },
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
            escalation: env.escalation,
            shouldAbortPublish: env.shouldAbortPublish,
            recordPublishStep: (detail) =>
              recordPublishStep(pool, {
                workItemId: item.id,
                resourceKey: item.resourceKey,
                reviewLens: DESCRIPTION_PUBLISH_LENS,
                step: "pr_body",
                detail,
                leaseEpoch: env.leaseEpoch,
              }),
            operationIntent: {
              client: pool,
              workItemId: item.id,
              resourceKey: item.resourceKey,
              leaseEpoch: env.leaseEpoch,
            },
            durability: env.durability,
            signal: env.signal,
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
            await captureDurableWorkCompletedWithCi(pool, {
              item,
              workType: "description",
              outcome: "degraded",
              durationMs: durationMsFromClaim(env.claim),
              attemptCount: env.claim?.attemptCount ?? item.attemptCount,
              degradedReason: "durable_degradation",
              extras: { source: payload.source, durableDegradation: "publish_not_completed" },
            });
            return { kind: "completed", degradation: ["publish_not_completed"] };
          }
          if (result.published) {
            await captureDurableWorkCompletedWithCi(pool, {
              item,
              workType: "description",
              outcome: "published",
              durationMs: durationMsFromClaim(env.claim),
              attemptCount: env.claim?.attemptCount ?? item.attemptCount,
              extras: { source: payload.source },
            });
          } else if (result.publishSuperseded) {
            await captureDurableWorkCompletedWithCi(pool, {
              item,
              workType: "description",
              outcome: "superseded",
              durationMs: durationMsFromClaim(env.claim),
              attemptCount: env.claim?.attemptCount ?? item.attemptCount,
              extras: { source: payload.source },
            });
          }
          return { kind: "completed" };
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
  };
}
