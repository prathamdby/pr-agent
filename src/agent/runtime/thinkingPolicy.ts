import type { AgentSessionPhase, ThinkingLevel, ThinkingPolicy } from "./types.js";
import { DEFAULT_THINKING_POLICY } from "./types.js";

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

/** Clamp to the nearest level that does not exceed the ceiling. */
export function clampThinkingLevel(level: ThinkingLevel, ceiling: ThinkingLevel): ThinkingLevel {
  const levelIndex = thinkingLevelIndex(level);
  const ceilingIndex = thinkingLevelIndex(ceiling);
  return THINKING_ORDER[Math.min(levelIndex, ceilingIndex)] ?? "off";
}

/**
 * Clamp to the nearest model-supported level at or below the desired level.
 * Empty support list → `off` (fail safe).
 */
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
  // Desired below all supported — pick the lowest supported.
  return [...supported].sort((a, b) => thinkingLevelIndex(a) - thinkingLevelIndex(b))[0] ?? "off";
}

export function resolveThinkingLevel(params: {
  readonly policy: ThinkingPolicy;
  readonly phase: AgentSessionPhase;
  readonly modelSupportedLevels?: readonly ThinkingLevel[];
}): ThinkingLevel {
  const desired = clampThinkingLevel(
    params.policy.levelForPhase(params.phase),
    params.policy.ceiling,
  );
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
