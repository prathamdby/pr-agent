import type { Pool } from "pg";
import type { CodeAnchor, ReplyTarget } from "../../agentWork/types.ts";
import type { Config } from "../../settings/index.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type {
  DiscussionTrigger,
  PullRequestDiscussion,
} from "../discussion/pullRequestDiscussion.ts";
import type { FeatureSessionContext } from "../runtime/createFeatureSession.ts";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.ts";
import type { AgentRunnerUsageMetadata } from "../providers/usageMetadata.ts";

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
  discussion: PullRequestDiscussion;
  discussionTrigger?: DiscussionTrigger;
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
