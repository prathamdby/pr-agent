import { logInfo, logWarn } from "../../evlog.js";
import { buildAskSystemPrompt } from "./askPrompt.js";
import { formatAskReply } from "./formatAskReply.js";
import {
  ASK_FAILURE_MESSAGE,
  ASK_META_REFUSAL,
  ASK_RETRY_NUDGE,
  MAX_ASK_FINALIZE_ROUNDS,
  MAX_ASK_TOOL_ROUNDS,
} from "../../settings/index.js";
import { createFeaturePiSession } from "../runtime/createFeatureSession.js";
import { buildAskUserContent } from "./askUserContent.js";
import type { AskRunParams, AskRunResult } from "./askRunTypes.js";
import { classifyAskQuestionIntent } from "./askSafety.js";
import { buildAskRunSetup } from "./askRunSetup.js";
import {
  createRateLimitCircuit,
  runWithRateLimitCircuit,
  wrapExecutorsWithRateLimitCircuit,
} from "../../github/rateLimitCircuit.js";
import {
  getSharedRateLimitCircuit,
  openSharedRateLimitCircuitBestEffort,
} from "../../github/sharedRateLimitCircuit.js";
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

  const installationId = params.durability?.installationId ?? 0;
  const durabilityPool = params.durability?.pool;
  const circuit = createRateLimitCircuit({
    installationId,
    onOpened: (kind) => {
      openSharedRateLimitCircuitBestEffort(durabilityPool, {
        installationId,
        lastErrorKind: kind,
      });
    },
  });
  if (durabilityPool != null && installationId > 0) {
    try {
      const sharedCircuit = await getSharedRateLimitCircuit(durabilityPool, installationId);
      if (sharedCircuit != null && sharedCircuit.openUntil.getTime() > Date.now()) {
        circuit.hydrateOpenFromShared(
          sharedCircuit.lastErrorKind === "secondary" ? "secondary" : "primary",
          sharedCircuit.openUntil,
        );
        logInfo("github_shared_rate_limit_circuit_honored", {
          installationId,
          type: "ask",
        });
      }
    } catch (error) {
      // Best-effort shared read: DB blips must not abort the ask run.
      logWarn("github_shared_rate_limit_circuit_read_failed", {
        installationId,
        type: "ask",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return runWithRateLimitCircuit(circuit, async () => {
    const { bundle } = buildAskRunSetup(params);
    const tools = bundle.piTools;
    const executors = wrapExecutorsWithRateLimitCircuit(bundle.executors);

    const session = await createFeaturePiSession({
      role: "ask",
      cfg,
      cwd: params.cwd,
      systemPrompt: buildAskSystemPrompt(),
      tools,
      executors,
      durability: params.durability,
    });

    try {
      const sendOpts = {
        maxToolRounds: MAX_ASK_TOOL_ROUNDS,
        phase: "ask" as const,
        checkpointId: "ask:ask",
      };
      let lastText = (await session.send(buildAskUserContent(params), sendOpts)).text.trim();

      if (!lastText && MAX_ASK_FINALIZE_ROUNDS > 0) {
        for (let round = 0; round < MAX_ASK_FINALIZE_ROUNDS && !lastText; round++) {
          lastText = (
            await session.send(ASK_RETRY_NUDGE, {
              phase: "ask",
              checkpointId: "ask:ask",
              // Keep tool definitions registered for cache prefixes; forbid tool turns.
              maxToolRounds: 0,
            })
          ).text.trim();
        }
      }

      const answerText = formatAskReply({
        question,
        answer: lastText.length > 0 ? lastText : ASK_FAILURE_MESSAGE,
        replyTarget,
      });

      logInfo("ask_run_completed", {
        provider: cfg.piProvider,
        hasAnswer: lastText.length > 0,
        metaRefusal: false,
        rateLimitCircuitOpened: circuit.isOpen(),
      });

      return { answer: answerText, replied: true };
    } finally {
      await session.dispose();
    }
  });
}
