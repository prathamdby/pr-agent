import { logInfo } from "../../evlog.js";
import { buildAskSystemPrompt } from "./askPrompt.js";
import { formatAskFailureReply, formatAskReply } from "./formatAskReply.js";
import { buildContext7Tools } from "../tools/context7Tools.js";
import { ASK_FAILURE_MESSAGE, ASK_META_REFUSAL, ASK_RETRY_NUDGE } from "../../settings/index.js";
import { resolveAgentRunnerProvider } from "../providers/index.js";
import { buildAskUserContent } from "./askUserContent.js";
import type { AskRunParams, AskRunResult } from "./askRunTypes.js";
import { classifyAskQuestionIntent } from "./askSafety.js";
import { buildAskRunSetup } from "./askRunSetup.js";

export type { AskRunParams, AskRunResult } from "./askRunTypes.js";

export async function runAskRun(params: AskRunParams): Promise<AskRunResult> {
  const { cfg, question, replyTarget } = params;

  if (classifyAskQuestionIntent(question) === "bot_meta") {
    logInfo("ask_meta_refusal", { owner: params.owner, repo: params.repo, pr: params.prNumber });
    logInfo("ask_run_completed", {
      toolRounds: 0,
      rateLimitCircuitOpened: false,
      hasAnswer: true,
      metaRefusal: true,
    });
    return {
      answer: formatAskReply({
        question,
        answer: ASK_META_REFUSAL,
        replyTarget,
      }),
      replied: true,
    };
  }

  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  if (!Number.isFinite(params.tokenTtlMs) || params.tokenTtlMs <= 0) {
    throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
  }

  const { refreshableGh, primePathGate } = buildAskRunSetup(params);
  const primePathGatePromise = primePathGate();

  const ctx7 = buildContext7Tools({
    apiKey: cfg.context7ApiKey,
    maxResponseBytes: cfg.context7ResponseBytes,
  });
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
  await primePathGatePromise;

  try {
    const sendOpts = { maxToolRounds: cfg.maxAskToolRounds };
    let lastText = (await session.send(buildAskUserContent(params), sendOpts)).text.trim();

    if (!lastText && cfg.maxAskFinalizeRounds > 0) {
      session.restrictToTools([], {});
      try {
        for (let round = 0; round < cfg.maxAskFinalizeRounds && !lastText; round++) {
          lastText = (await session.send(ASK_RETRY_NUDGE)).text.trim();
        }
      } finally {
        session.restoreTools();
      }
    }

    const answerText =
      lastText.length > 0
        ? formatAskReply({ question, answer: lastText, replyTarget })
        : formatAskFailureReply({
            question,
            message: ASK_FAILURE_MESSAGE,
            replyTarget,
          });

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
