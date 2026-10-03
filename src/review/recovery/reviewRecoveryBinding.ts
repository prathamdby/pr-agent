import { createHash } from "node:crypto";
import * as v from "valibot";
import type { Config } from "../../settings/index.js";
import { MAX_TOOL_ROUNDS, ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS } from "../../settings/index.js";
import { escalatedToolRounds, type EscalationPlan } from "../../agentWork/retryPolicy.js";
import { resolveModelPolicy } from "../../agent/runtime/modelPolicy.js";
import { assertPiModelSelection } from "../../agent/runtime/modelsJson.js";
import { SPECIALIST_SYSTEM_PROMPTS } from "../orchestrator/specialistRun.js";
import { orchestratorSystemPrompt } from "../orchestrator/prompts/orchestratorPrompts.js";
import { encodeReviewArtifact, REVIEW_CONTRACT_VERSION } from "./reviewArtifacts.js";

/** The surface's provider value retains base SHA even on its narrower shared view. */
export function reviewRecoveryBaseSha(pullRequest: unknown): string | null {
  const parsed = v.safeParse(
    v.object({
      base: v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40,64}$/)) }),
    }),
    pullRequest,
  );
  return parsed.success ? parsed.output.base.sha : null;
}

export async function reviewRecoveryModelApis(cfg: Config, escalation?: EscalationPlan) {
  const policy = resolveModelPolicy(cfg);
  const assignments = {
    orchestrator: escalation?.model ?? policy.orchestratorPrimary,
    specialist: escalation?.model ?? policy.generalPrimary,
    boundPolicyJudge: policy.generalPrimary,
    fallback: policy.fallback,
  };
  const selected = new Map<string, Promise<string>>();
  return Object.fromEntries(
    await Promise.all(
      Object.entries(assignments).map(
        async ([role, assignment]): Promise<readonly [string, string | null]> => {
          if (!assignment) return [role, null];
          const key = `${assignment.provider}/${assignment.model}`;
          let api = selected.get(key);
          if (!api) {
            api = assertPiModelSelection({
              modelsJsonPath: cfg.models.jsonPath,
              piProvider: assignment.provider,
              piModel: assignment.model,
            });
            selected.set(key, api);
          }
          return [role, await api];
        },
      ),
    ),
  );
}

/** Only the digest is stored. Never pass credentials, prior feedback or our run output. */
export function reviewRecoveryInputDigest(input: {
  readonly cfg: Config;
  readonly diff: unknown;
  readonly trustedInputs: string;
  readonly source: string;
  readonly userSupplement?: string;
  readonly prTitle: string;
  readonly prBody: string | null;
  readonly escalation?: EscalationPlan;
  readonly modelApis?: Readonly<Record<string, string | null>>;
  readonly effectivePublicationCapabilities?: Readonly<{
    checksWrite: boolean;
    statusesWrite: boolean;
    labelsWrite: boolean;
    reactionsWrite: boolean;
  }>;
}) {
  const policy = resolveModelPolicy(input.cfg);
  return createHash("sha256")
    .update(
      encodeReviewArtifact({
        diff: input.diff,
        trustedInputs: input.trustedInputs,
        source: input.source,
        userSupplement: input.userSupplement ?? null,
        prTitle: input.prTitle,
        prBody: input.prBody,
        review: input.cfg.review,
        findingHistory: input.cfg.findingHistory,
        providerBudget: input.cfg.provider,
        publication: {
          commitStatus: input.cfg.features.commitStatus,
          reviewLabels: input.cfg.features.reviewLabels,
          capabilities: input.effectivePublicationCapabilities ?? null,
        },
        models: {
          orchestrator: input.escalation?.model ?? policy.orchestratorPrimary,
          specialist: input.escalation?.model ?? policy.generalPrimary,
          boundPolicyJudge: policy.generalPrimary,
          thinkingCeiling: input.cfg.models.thinkingCeiling,
          api: input.cfg.models.api,
          roleApis: input.modelApis ?? null,
          fallback: policy.fallback ?? null,
        },
        toolRounds: {
          investigation: escalatedToolRounds(MAX_TOOL_ROUNDS, input.escalation),
          judgment: escalatedToolRounds(ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS, input.escalation),
        },
        codeMode: input.cfg.codeMode,
        context7Enabled: input.cfg.context7.apiKey.length > 0,
        codeIndexMode: input.cfg.codeIndex.mode,
        personas: {
          orchestrator: orchestratorSystemPrompt,
          specialists: SPECIALIST_SYSTEM_PROMPTS,
        },
        contract: REVIEW_CONTRACT_VERSION,
      }),
    )
    .digest("hex");
}
