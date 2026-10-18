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

export function thinkingLevelIndex(level: ThinkingLevel): number {
  const index = THINKING_ORDER.indexOf(level);
  return index < 0 ? 0 : index;
}

export function clampThinkingLevel(level: ThinkingLevel, ceiling: ThinkingLevel): ThinkingLevel {
  const levelIndex = thinkingLevelIndex(level);
  const ceilingIndex = thinkingLevelIndex(ceiling);
  return THINKING_ORDER[Math.min(levelIndex, ceilingIndex)] ?? "off";
}

export function clampToModelSupportedLevel(
  desired: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel {
  if (supported.length === 0) return "off";
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
  if (best) return best;
  return (
    [...supported].toSorted((a, b) => thinkingLevelIndex(a) - thinkingLevelIndex(b))[0] ?? "off"
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
}): ThinkingLevel {
  const phases = params.holdAcrossPhases?.includes(params.phase)
    ? params.holdAcrossPhases
    : [params.phase];
  const wanted = phases
    .map((phase) => params.policy.levelForPhase(phase))
    .reduce((highest, level) =>
      thinkingLevelIndex(level) > thinkingLevelIndex(highest) ? level : highest,
    );
  const desired = clampThinkingLevel(wanted, params.policy.ceiling);
  if (!params.modelSupportedLevels) return desired;
  return clampToModelSupportedLevel(desired, params.modelSupportedLevels);
}

export function thinkingPolicyFromCeiling(ceiling: ThinkingLevel): ThinkingPolicy {
  return {
    ceiling,
    levelForPhase: DEFAULT_THINKING_POLICY.levelForPhase,
  };
}

export { DEFAULT_THINKING_POLICY };
