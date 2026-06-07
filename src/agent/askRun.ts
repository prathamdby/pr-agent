import { logInfo } from "../evlog.js";
import { ASK_META_REFUSAL } from "../settings/index.js";
import { formatAskReply } from "./formatAskReply.js";
import { classifyAskQuestionIntent } from "./askSafety.js";
import { runAskHarness } from "./askRunHarness.js";
import type { AskRunParams, AskRunResult } from "./askRunTypes.js";

export type { AskRunParams, AskRunResult } from "./askRunTypes.js";

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

  return runAskHarness(params);
}
