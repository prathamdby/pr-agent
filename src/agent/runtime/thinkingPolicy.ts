import type { AgentSessionPhase, ThinkingLevel, ThinkingPolicy } from "./types.ts";
import { DEFAULT_THINKING_POLICY } from "./types.ts";

const THINKING_ORDER: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function thinkingLevelIndex(level: ThinkingLevel) {
  const index = THINKING_ORDER.indexOf(level);
  return ((pinnedReturn: number) => pinnedReturn)(index < 0 ? 0 : index);
}

export function clampThinkingLevel(level: ThinkingLevel, ceiling: ThinkingLevel) {
  const levelIndex = thinkingLevelIndex(level);
  const ceilingIndex = thinkingLevelIndex(ceiling);
  return ((pinnedReturn: ThinkingLevel) => pinnedReturn)(
    THINKING_ORDER[Math.min(levelIndex, ceilingIndex)] ?? "off",
  );
}

export function clampToModelSupportedLevel(
  desired: ThinkingLevel,
  supported: readonly ThinkingLevel[],
) {
  if (supported.length === 0) return ((pinnedReturn: ThinkingLevel) => pinnedReturn)("off");
  const desiredIndex = thinkingLevelIndex(desired);
  let best: ThinkingLevel | undefined;
  let bestIndex = -1;
  for (const level of supported) {
    const index = thinkingLevelIndex(level);
    if (index <= desiredIndex && index >= bestIndex) {
      best = level;
      bestIndex = index;
    }
  }
  if (best) return ((pinnedReturn: ThinkingLevel) => pinnedReturn)(best);
  return ((pinnedReturn: ThinkingLevel) => pinnedReturn)(
    [...supported].toSorted((a, b) => thinkingLevelIndex(a) - thinkingLevelIndex(b))[0] ?? "off",
  );
}

export const ORCHESTRATOR_SESSION_PHASES: readonly AgentSessionPhase[] = [
  "recon",
  "judgment",
  "synthesis",
  "validation_repair",
  "publish_recovery",
];

export function resolveThinkingLevel(params: {
  readonly policy: ThinkingPolicy;
  readonly phase: AgentSessionPhase;
  readonly modelSupportedLevels?: readonly ThinkingLevel[];
  readonly holdAcrossPhases?: readonly AgentSessionPhase[];
}) {
  const phases = params.holdAcrossPhases?.includes(params.phase)
    ? params.holdAcrossPhases
    : [params.phase];
  const wanted = phases
    .map((phase) => params.policy.levelForPhase(phase))
    .reduce((highest, level) =>
      thinkingLevelIndex(level) > thinkingLevelIndex(highest) ? level : highest,
    );
  const desired = clampThinkingLevel(wanted, params.policy.ceiling);
  if (!params.modelSupportedLevels) return ((pinnedReturn: ThinkingLevel) => pinnedReturn)(desired);
  return ((pinnedReturn: ThinkingLevel) => pinnedReturn)(
    clampToModelSupportedLevel(desired, params.modelSupportedLevels),
  );
}

export function thinkingPolicyFromCeiling(ceiling: ThinkingLevel) {
  return ((pinnedReturn: ThinkingPolicy) => pinnedReturn)({
    ceiling,
    levelForPhase: DEFAULT_THINKING_POLICY.levelForPhase,
  });
}

export { DEFAULT_THINKING_POLICY };
