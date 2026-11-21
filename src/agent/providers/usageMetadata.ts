import type { Usage } from "@earendil-works/pi-ai";

export type AgentRunnerUsageMetadata = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWrite1hTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly estimated: boolean;
};

export type AgentRunnerPromptMetadata = {
  readonly inputCharacters: number;
  readonly inputBytes: number;
};

export type TurnEnd = "completed" | "output_limit" | "tool_budget";

export type AgentRunnerTurn = {
  readonly text: string;
  readonly end: TurnEnd;
  readonly usage?: AgentRunnerUsageMetadata;
  readonly prompt?: AgentRunnerPromptMetadata;
};

export function promptMetadataFromText(text: string) {
  return ((pinnedReturn: AgentRunnerPromptMetadata) => pinnedReturn)({
    inputCharacters: text.length,
    inputBytes: Buffer.byteLength(text, "utf8"),
  });
}

export function exactUsageFromProviderUsage(usage: Usage) {
  const hasTokenData = usage.totalTokens > 0 || usage.input > 0 || usage.output > 0;
  if (!hasTokenData)
    return ((pinnedReturn: AgentRunnerUsageMetadata | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: AgentRunnerUsageMetadata | undefined) => pinnedReturn)({
    estimated: false,
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead != null ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite != null ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(usage.cacheWrite1h != null ? { cacheWrite1hTokens: usage.cacheWrite1h } : {}),
    ...(usage.reasoning != null ? { reasoningTokens: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
  });
}

function mergeOptionalCount(left?: number, right?: number) {
  if (left === undefined && right === undefined)
    return ((pinnedReturn: number | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: number | undefined) => pinnedReturn)((left ?? 0) + (right ?? 0));
}

export function mergeExactUsage(
  left: AgentRunnerUsageMetadata | undefined,
  right: AgentRunnerUsageMetadata | undefined,
) {
  if (!left) return ((pinnedReturn: AgentRunnerUsageMetadata | undefined) => pinnedReturn)(right);
  if (!right) return ((pinnedReturn: AgentRunnerUsageMetadata | undefined) => pinnedReturn)(left);
  const cacheReadTokens = mergeOptionalCount(left.cacheReadTokens, right.cacheReadTokens);
  const cacheWriteTokens = mergeOptionalCount(left.cacheWriteTokens, right.cacheWriteTokens);
  const cacheWrite1hTokens = mergeOptionalCount(left.cacheWrite1hTokens, right.cacheWrite1hTokens);
  const reasoningTokens = mergeOptionalCount(left.reasoningTokens, right.reasoningTokens);
  return ((pinnedReturn: AgentRunnerUsageMetadata | undefined) => pinnedReturn)({
    estimated: false,
    inputTokens: mergeOptionalCount(left.inputTokens, right.inputTokens),
    outputTokens: mergeOptionalCount(left.outputTokens, right.outputTokens),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens: mergeOptionalCount(left.totalTokens, right.totalTokens),
  });
}
