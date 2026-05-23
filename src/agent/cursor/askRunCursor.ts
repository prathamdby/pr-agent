import type { Config } from "../../config.js";
import { logDebug, logInfo } from "../../evlog.js";
import { complete } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Tool as PiTool } from "@earendil-works/pi-ai";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import { buildAskSystemPrompt } from "../askPrompt.js";
import { formatAskFailureReply, formatAskReply } from "../formatAskReply.js";
import { buildContext7Tools } from "../context7Tools.js";
import {
  buildAskGithubTools,
  createAskPathGate,
  wrapTrustedContext,
  wrapUntrustedBlock,
} from "../askSafety.js";
import { ASK_FAILURE_MESSAGE } from "../../settings/index.js";
import type { AskRunParams, AskRunResult, CodeAnchor } from "../askRun.js";
import {
  attachCursorRunContext,
  detachCursorRunContext,
  getCursorModel,
} from "./index.js";
import { createRefreshableToolExecutors } from "./refreshableGithubTools.js";
import { sanitizeLogMessage } from "../../security/sanitizeLogMessage.js";

function buildUserContent(params: AskRunParams): string {
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
      "Use GitHub tools to inspect the PR diff and related files, then answer the question in user_question.",
    );
  }
  return blocks.join("\n\n");
}

export async function runCursorAskRun(params: AskRunParams): Promise<AskRunResult> {
  const { cfg, token, tokenExpiresAtTs, owner, repo, prNumber, question, replyTarget } = params;

  const pathGate = createAskPathGate();
  if (params.codeAnchor?.path) {
    pathGate.addPaths([params.codeAnchor.path]);
  }

  const refreshableGh = createRefreshableToolExecutors({
    initialToken: token,
    tokenExpiresAtTs,
    refreshInstallationToken: params.refreshInstallationToken,
    build: (activeToken) => {
      const gh = buildAskGithubTools(
        activeToken,
        { owner, repo, prNumber, headSha: params.headSha },
        {
          maxPrFilesListed: cfg.maxPrFilesListed,
          maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
        },
        pathGate,
      );
      return { piTools: gh.piTools, executors: gh.executors };
    },
  });

  try {
    await refreshableGh.bundle.executors.listPullRequestFiles?.({});
  } catch (e) {
    logDebug("ask_path_gate_prime_failed", {
      owner,
      repo,
      pr: prNumber,
      message: sanitizeLogMessage(e instanceof Error ? e.message : String(e)),
    });
  }

  const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });
  const piTools: PiTool[] = [...refreshableGh.bundle.piTools, ...ctx7.piTools];
  const executors = { ...refreshableGh.bundle.executors, ...ctx7.executors };
  const model = getCursorModel(cfg.piModel);

  const context: Context = {
    systemPrompt: buildAskSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildUserContent(params),
        timestamp: Date.now(),
      },
    ],
    tools: piTools,
  };

  attachCursorRunContext(context, {
    executors,
    apiKey: cfg.cursorApiKey,
    refreshBeforeTool: refreshableGh.refreshBeforeTool,
  });

  logInfo("cursor_ask_started", { owner, repo, pr: prNumber, model: model.id });

  let lastAssistant: AssistantMessage;
  try {
    lastAssistant = await complete(model, context, { apiKey: cfg.cursorApiKey });
  } finally {
    detachCursorRunContext(context);
  }

  const summary = lastAssistant.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();

  const answerText =
    summary.length > 0
      ? formatAskReply({ question, answer: summary, replyTarget })
      : formatAskFailureReply({ question, message: ASK_FAILURE_MESSAGE, replyTarget });

  logInfo("cursor_ask_completed", {
    owner,
    repo,
    pr: prNumber,
    hasAnswer: summary.length > 0,
    stopReason: lastAssistant.stopReason,
  });

  return { answer: answerText, replied: true };
}
