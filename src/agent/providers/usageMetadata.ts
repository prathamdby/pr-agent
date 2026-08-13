import type { Usage } from "@earendil-works/pi-ai";

export type AgentRunnerUsageMetadata = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Subset of cacheWriteTokens written with 1h retention when the provider reports it. */
  readonly cacheWrite1hTokens?: number;
  readonly totalTokens?: number;
  readonly estimated: boolean;
};

type MutableAgentRunnerUsageMetadata = {
  -readonly [K in keyof AgentRunnerUsageMetadata]: AgentRunnerUsageMetadata[K];
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
  const result: MutableAgentRunnerUsageMetadata = {
    estimated: false,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
  if (usage.cacheWrite1h != null) result.cacheWrite1hTokens = usage.cacheWrite1h;
  return result;
}

function mergeOptionalCount(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

export function mergeExactUsage(
  left: AgentRunnerUsageMetadata | undefined,
  right: AgentRunnerUsageMetadata | undefined,
): AgentRunnerUsageMetadata | undefined {
  if (!left) return right;
  if (!right) return left;
  const cacheWrite1hTokens = mergeOptionalCount(left.cacheWrite1hTokens, right.cacheWrite1hTokens);
  const result: MutableAgentRunnerUsageMetadata = {
    estimated: false,
    inputTokens: mergeOptionalCount(left.inputTokens, right.inputTokens),
    outputTokens: mergeOptionalCount(left.outputTokens, right.outputTokens),
    cacheReadTokens: mergeOptionalCount(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: mergeOptionalCount(left.cacheWriteTokens, right.cacheWriteTokens),
    totalTokens: mergeOptionalCount(left.totalTokens, right.totalTokens),
  };
  if (cacheWrite1hTokens !== undefined) result.cacheWrite1hTokens = cacheWrite1hTokens;
  return result;
}
