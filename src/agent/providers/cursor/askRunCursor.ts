import { logDebug, logInfo } from "../../../evlog.js";
import { complete } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Tool as PiTool } from "@earendil-works/pi-ai";
import { buildAskSystemPrompt } from "../../askPrompt.js";
import { formatAskFailureReply, formatAskReply } from "../../formatAskReply.js";
import { buildContext7Tools } from "../../context7Tools.js";
import { buildAskGithubTools, createAskPathGate } from "../../askSafety.js";
import { buildLocalWorkspaceTools } from "../../localWorkspaceTools.js";
import { ASK_FAILURE_MESSAGE } from "../../../settings/index.js";
import { buildAskUserContent, type AskRunParams, type AskRunResult } from "../../askRun.js";
import { attachCursorRunContext, getCursorModel } from "./index.js";
import { createRefreshableToolExecutors } from "./refreshableGithubTools.js";
import { sanitizeLogMessage } from "../../../security/sanitizeLogMessage.js";

export async function runCursorAskRun(params: AskRunParams): Promise<AskRunResult> {
  const { cfg, token, tokenExpiresAtTs, owner, repo, prNumber, question, replyTarget } = params;

  const pathGate = createAskPathGate();
  if (params.codeAnchor?.path) {
    pathGate.addPaths([params.codeAnchor.path]);
  }

  const refreshableGh = params.workspace
    ? {
        bundle: buildLocalWorkspaceTools(params.workspace),
        refreshBeforeTool: async () => undefined,
      }
    : createRefreshableToolExecutors({
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

  if (!params.workspace) {
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
  }

  const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });
  const piTools: PiTool[] = [...refreshableGh.bundle.piTools, ...ctx7.piTools];
  const executors = refreshableGh.bundle.executors;
  Object.assign(executors, ctx7.executors);
  const model = getCursorModel(cfg.piModel);

  const context: Context = {
    systemPrompt: buildAskSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildAskUserContent(params),
        timestamp: Date.now(),
      },
    ],
    tools: piTools,
  };

  attachCursorRunContext(context, {
    executors,
    apiKey: cfg.cursorApiKey,
    cwd: params.cwd,
    refreshBeforeTool: refreshableGh.refreshBeforeTool,
  });

  logInfo("cursor_ask_started", { owner, repo, pr: prNumber, model: model.id });

  const lastAssistant: AssistantMessage = await complete(model, context, {
    apiKey: cfg.cursorApiKey,
  });

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
  logInfo("ask_run_completed", {
    provider: "cursor",
    hasAnswer: summary.length > 0,
    metaRefusal: false,
  });

  return { answer: answerText, replied: true };
}
