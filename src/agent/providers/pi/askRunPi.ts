import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { logDebug } from "../../../evlog.js";
import { sanitizeLogMessage } from "../../../security/sanitizeLogMessage.js";
import { buildAskSystemPrompt } from "../../askPrompt.js";
import { formatAskReply } from "../../formatAskReply.js";
import { buildContext7Tools } from "../../context7Tools.js";
import { buildAskGithubTools, createAskPathGate } from "../../askSafety.js";
import { buildLocalWorkspaceTools } from "../../localWorkspaceTools.js";
import { ASK_FAILURE_MESSAGE } from "../../../settings/index.js";
import { buildAskUserContent, type AskRunParams, type AskRunResult } from "../../askRun.js";
import { piAgentRunnerProvider } from "./index.js";

export async function runPiCodingAskRun(params: AskRunParams): Promise<AskRunResult> {
  const { cfg, token, owner, repo, prNumber, question, replyTarget } = params;
  const pathGate = createAskPathGate();
  if (params.codeAnchor?.path) {
    pathGate.addPaths([params.codeAnchor.path]);
  }
  const repoTools = params.workspace
    ? buildLocalWorkspaceTools(params.workspace)
    : buildAskGithubTools(
        token,
        { owner, repo, prNumber, headSha: params.headSha },
        {
          maxPrFilesListed: cfg.maxPrFilesListed,
          maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
        },
        pathGate,
      );
  if (!params.workspace) {
    try {
      await repoTools.executors.listPullRequestFiles({});
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
  const tools: PiTool[] = [...repoTools.piTools, ...ctx7.piTools];
  const session = await piAgentRunnerProvider.createSession({
    cfg,
    cwd: params.cwd,
    systemPrompt: buildAskSystemPrompt(),
    tools,
    executors: { ...repoTools.executors, ...ctx7.executors },
  });
  try {
    const first = await session.send(buildAskUserContent(params));
    const answer = first.text.trim();
    if (!answer) {
      const retry = await session.send(ASK_FAILURE_MESSAGE);
      return {
        answer: formatAskReply({
          question,
          answer: retry.text.trim() || ASK_FAILURE_MESSAGE,
          replyTarget,
        }),
        replied: true,
      };
    }
    return { answer: formatAskReply({ question, answer, replyTarget }), replied: true };
  } finally {
    await session.dispose();
  }
}
