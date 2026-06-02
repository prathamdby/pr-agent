import type { ReplyTarget } from "../commands/replyTarget.js";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/localPrWorkspace.js";
import { logInfo } from "../evlog.js";
import { ASK_META_REFUSAL } from "../settings/index.js";
import { formatAskReply } from "./formatAskReply.js";
import { classifyAskQuestionIntent, wrapTrustedContext, wrapUntrustedBlock } from "./askSafety.js";
import { runAskHarness } from "./askRunHarness.js";

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

export function buildAskUserContent(params: AskRunParams): string {
  const blocks = [
    wrapTrustedContext([
      `Repository: ${params.owner}/${params.repo}`,
      `Pull request: #${params.prNumber}`,
      `Head commit SHA: ${params.headSha}`,
    ]),
    wrapUntrustedBlock("user_question", params.question),
  ];

  if (params.codeAnchor) {
    const { path, line, startLine, side, diffHunk } = params.codeAnchor;
    const range =
      startLine != null && startLine !== line ? `lines ${startLine}-${line}` : `line ${line}`;
    const anchorLines = [`File: ${path}`, `${range}${side ? ` (${side} side of diff)` : ""}`];
    if (diffHunk?.trim()) {
      anchorLines.push("", "Diff hunk:", "```diff", diffHunk.trim(), "```");
    }
    anchorLines.push(
      "",
      "Start from this anchor, then use tools to trace symbols and surrounding context.",
    );
    blocks.push(wrapUntrustedBlock("code_anchor", anchorLines.join("\n")));
  } else {
    blocks.push(
      "Use the local PR workspace tools to inspect changed files and related code, then answer the question in user_question.",
    );
  }

  return blocks.join("\n\n");
}

export async function runAskRun(params: AskRunParams): Promise<AskRunResult> {
  const { owner, repo, prNumber, question, replyTarget } = params;

  if (classifyAskQuestionIntent(question) === "bot_meta") {
    logInfo("ask_meta_refusal", { owner, repo, pr: prNumber });
    logInfo("ask_run_completed", {
      toolRounds: 0,
      rateLimitCircuitOpened: false,
      hasAnswer: true,
      metaRefusal: true,
    });
    return {
      answer: formatAskReply({ question, answer: ASK_META_REFUSAL, replyTarget }),
      replied: true,
    };
  }

  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  if (!Number.isFinite(params.tokenTtlMs) || params.tokenTtlMs <= 0) {
    throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
  }

  return runAskHarness(params);
}
