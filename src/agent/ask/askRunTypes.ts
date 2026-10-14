import type { Pool } from "pg";
import type { ReplyTarget } from "../../agentWork/types.js";
import type { Config } from "../../settings/index.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { FeatureSessionContext } from "../runtime/createFeatureSession.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import type { AgentRunnerUsageMetadata } from "../providers/usageMetadata.js";

export type CodeAnchor = {
  path: string;
  line: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  diffHunk?: string;
};

export type AskCiState = {
  readonly rollup: string;
  readonly version: number;
  readonly checks: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }[];
};

export type AskRunParams = {
  cfg: Config;
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  question: string;
  replyTarget: ReplyTarget;
  codeAnchor?: CodeAnchor;
  threadTranscript?: string;
  threadTranscriptTruncated?: boolean;
  cwd?: string;
  workspace: LocalPrWorkspace;
  sessionContext?: FeatureSessionContext;
  pool?: Pool;
  ciState?: AskCiState;
  signal?: AbortSignal;
};

export type AskRunResult = {
  answer: string;
  replied: boolean;
  usage?: AgentRunnerUsageMetadata;
};
