import { logInfo } from "../evlog.js";
import { buildAskSystemPrompt } from "./askPrompt.js";
import { formatAskFailureReply, formatAskReply } from "./formatAskReply.js";
import { buildContext7Tools } from "./context7Tools.js";
import { ASK_FAILURE_MESSAGE, ASK_RETRY_NUDGE, ASK_RETRY_ROUNDS } from "../settings/index.js";
import { resolveAgentRunnerProvider } from "./providers/index.js";
import { buildAskUserContent, type AskRunParams, type AskRunResult } from "./askRun.js";
import { buildAskRunSetup } from "./askRunSetup.js";

export async function runAskHarness(params: AskRunParams): Promise<AskRunResult> {
  const { cfg, question, replyTarget } = params;
  const { refreshableGh, primePathGate } = buildAskRunSetup(params);
  await primePathGate();

  const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });
  const tools = [...refreshableGh.bundle.piTools, ...ctx7.piTools];
  const executors = { ...refreshableGh.bundle.executors, ...ctx7.executors };

  const runner = resolveAgentRunnerProvider(cfg);
  const session = await runner.createSession({
    cfg,
    cwd: params.cwd,
    systemPrompt: buildAskSystemPrompt(),
    tools,
    executors,
    refreshBeforeTool: refreshableGh.refreshBeforeTool,
  });

  try {
    const sendOpts = { maxToolRounds: cfg.maxAskToolRounds };
    let lastText = (await session.send(buildAskUserContent(params), sendOpts)).text.trim();

    if (!lastText) {
      lastText = (await session.send(ASK_RETRY_NUDGE, sendOpts)).text.trim();
    }

    for (let round = 0; round < ASK_RETRY_ROUNDS && !lastText; round++) {
      lastText = (await session.send(ASK_RETRY_NUDGE, sendOpts)).text.trim();
    }

    if (!lastText) {
      lastText = (
        await session.send(
          "Respond with plain text only (no tool calls). Answer the question using what you found, or explain clearly what blocked a complete answer.",
        )
      ).text.trim();
    }

    const answerText =
      lastText.length > 0
        ? formatAskReply({ question, answer: lastText, replyTarget })
        : formatAskFailureReply({ question, message: ASK_FAILURE_MESSAGE, replyTarget });

    logInfo("ask_run_completed", {
      provider: cfg.agentProvider,
      hasAnswer: lastText.length > 0,
      metaRefusal: false,
    });

    return { answer: answerText, replied: true };
  } finally {
    await session.dispose();
  }
}
