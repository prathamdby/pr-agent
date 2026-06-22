import type { Usage } from "@earendil-works/pi-ai";

export type AgentRunnerUsageMetadata = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly estimated: boolean;
};

export type AgentRunnerPromptMetadata = {
  readonly inputCharacters: number;
  readonly inputBytes: number;
};

export type AgentRunnerTurn = {
  readonly text: string;
  readonly usage?: AgentRunnerUsageMetadata;
  readonly prompt?: AgentRunnerPromptMetadata;
};

export function promptMetadataFromText(text: string): AgentRunnerPromptMetadata {
  return {
    inputCharacters: text.length,
    inputBytes: Buffer.byteLength(text, "utf8"),
  };
}

export function estimatedUsageFromTokenCounts(
  inputTokens: number,
  outputTokens: number,
): AgentRunnerUsageMetadata {
  return {
    estimated: true,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function exactUsageFromProviderUsage(usage: Usage): AgentRunnerUsageMetadata | undefined {
  const hasTokenData = usage.totalTokens > 0 || usage.input > 0 || usage.output > 0;
  if (!hasTokenData) return undefined;
  return {
    estimated: false,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

export function mergeExactUsage(
  left: AgentRunnerUsageMetadata | undefined,
  right: AgentRunnerUsageMetadata | undefined,
): AgentRunnerUsageMetadata | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    estimated: false,
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
  };
}
