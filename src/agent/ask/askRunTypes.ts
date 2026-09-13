import type { Pool } from "pg";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import type { Config } from "../../config.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { FeatureSessionDurability } from "../runtime/sessionDurability.js";
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
  /** Full containing-thread transcript for conversational asks (untrusted). */
  threadTranscript?: string;
  threadTranscriptTruncated?: boolean;
  cwd?: string;
  workspace: LocalPrWorkspace;
  durability?: FeatureSessionDurability;
  pool?: Pool;
  /** Durable CI facts for this head. Loaded by the ask run from `pr_head_ci_state`. */
  ciState?: AskCiState;
  codeIndexSnapshotId?: string;
  /** Durable job/lease abort for tool execution. */
  signal?: AbortSignal;
};

export type AskRunResult = {
  answer: string;
  replied: boolean;
  /** Exact provider usage when the provider returned token metadata. */
  usage?: AgentRunnerUsageMetadata;
};
