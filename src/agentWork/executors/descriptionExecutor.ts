import type { FeatureWorkDependencies, FeatureWorkExecution } from "./featureExecution.ts";
import { runFullPrDescription } from "../../agent/description/descriptionRun.ts";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.ts";
import { logWarn } from "../../evlog.ts";
import { prBodyHasAgentDescriptionBlock } from "../../agent/description/descriptionBodyMerge.ts";
import { DESCRIPTION_FAILURE_MESSAGE, DESCRIPTION_PUBLISH_LENS } from "../../settings/index.ts";

type DescriptionDegradationReason = "publish_not_completed";

export function createDescriptionFeatureExecution({ cfg }: FeatureWorkDependencies) {
  return ((pinnedReturn: FeatureWorkExecution<"description">) => pinnedReturn)({
    execute: async (item, env) => {
      const { prSurface } = env;
      const headSha = env.headSha;
      const payload = item.payload;
      return env.withRepositoryView(
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
            recordPublishStep: async (detail) =>
              env.publication.record({
                lens: DESCRIPTION_PUBLISH_LENS,
                step: "pr_body",
                ...(detail !== undefined ? { detail } : {}),
              }),
            publication: env.publication,
            createSession: env.createSession,
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
    onTerminalFailure: async (item, prSurface, env) => {
      if (!prSurface) return;
      const payload = item.payload;
      if (payload.source !== "slash") {
        const { pullRequest } = await prSurface.getHead();
        if (prBodyHasAgentDescriptionBlock(pullRequest.body)) return;
      }
      await env.publication.once({
        decodeResult: () => undefined,
        allowsUndefinedResult: true,
        resourceTarget: "description_failure_reply",
        operationKey: `description:failure_reply:${item.resourceKey}`,
        mutationKind: "github.description_failure_reply",
        mutate: async () => {
          await prSurface.replyAt(
            { kind: "prConversation", prNumber: item.prNumber },
            DESCRIPTION_FAILURE_MESSAGE,
          );
        },
      });
    },
  });
}
