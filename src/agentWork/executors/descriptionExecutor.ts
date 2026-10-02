import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.js";
import { createPublishContext } from "../publishOnce.js";
import { runFullPrDescription } from "../../agent/description/descriptionRun.js";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.js";
import { logWarn } from "../../evlog.js";
import { prBodyHasAgentDescriptionBlock } from "../../agent/description/descriptionBodyMerge.js";
import { DESCRIPTION_FAILURE_MESSAGE, DESCRIPTION_PUBLISH_LENS } from "../../settings/index.js";

type DescriptionDegradationReason = "publish_not_completed";

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
              createPublishContext(pool, {
                workItemId: item.id,
                resourceKey: item.resourceKey,
                reviewLens: DESCRIPTION_PUBLISH_LENS,
                step: "pr_body",
                detail,
                leaseEpoch: env.leaseEpoch,
              }).record(),
            operationIntent: {
              client: pool,
              workItemId: item.id,
              resourceKey: item.resourceKey,
              leaseEpoch: env.leaseEpoch,
            },
            sessionContext: env.durability,
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
            return {
              kind: "completed",
              degradation: [
                "publish_not_completed",
              ] satisfies readonly DescriptionDegradationReason[],
              completion: {
                kind: "description",
                outcome: "degraded",
                source: payload.source,
                durableDegradation: "publish_not_completed",
              },
            };
          }
          if (result.published) {
            return {
              kind: "completed",
              completion: { kind: "description", outcome: "published", source: payload.source },
            };
          } else if (result.publishSuperseded) {
            return {
              kind: "completed",
              completion: { kind: "description", outcome: "superseded", source: payload.source },
            };
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
