import type { ReplyTarget } from "../commands/replyTarget.js";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/localPrWorkspace.js";

export type CodeAnchor = {
  path: string;
  line: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  diffHunk?: string;
};

export type AskRunParams = {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  question: string;
  replyTarget: ReplyTarget;
  codeAnchor?: CodeAnchor;
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  cwd?: string;
  workspace?: LocalPrWorkspace;
};

export type AskRunResult = {
  answer: string;
  replied: boolean;
};
