import { logInfo, logWarn } from "../../evlog.js";
import { buildAskSystemPrompt } from "./askPrompt.js";
import { formatAskReply } from "./formatAskReply.js";
import { buildContext7Tools } from "../tools/context7Tools.js";
import {
  ASK_FAILURE_MESSAGE,
  ASK_META_REFUSAL,
  ASK_RETRY_NUDGE,
  ASK_SHORTEN_NUDGE,
  CONTEXT7_RESPONSE_BYTES,
  MAX_ASK_FINALIZE_ROUNDS,
  MAX_ASK_TOOL_ROUNDS,
} from "../../settings/index.js";
import { createFeaturePiSession } from "../runtime/createFeatureSession.js";
import { loadPrHeadCiState } from "../../agentWork/prHeadCiState.js";
import { buildAskUserContent } from "./askUserContent.js";
import type { AskCiState, AskRunParams, AskRunResult } from "./askRunTypes.js";
import { mergeExactUsage } from "../providers/usageMetadata.js";
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

async function loadAskCiState(
  pool: AskRunParams["pool"],
  owner: string,
  repo: string,
  headSha: string,
): Promise<AskCiState | undefined> {
  if (pool == null) return undefined;
  const row = await loadPrHeadCiState(pool, owner, repo, headSha);
  if (row == null) {
    return { rollup: "none", version: 0, checks: [] };
  }
  return {
    rollup: row.rollup,
    version: row.version,
    checks: Object.values(row.checks).map((fact) => ({
      name: fact.name,
      status: fact.status,
      conclusion: fact.conclusion,
    })),
  };
}

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

    const ctx7 = buildContext7Tools({
      apiKey: cfg.context7ApiKey,
      maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
    });
    const tools = [...bundle.piTools, ...ctx7.piTools];
    const executors = wrapExecutorsWithRateLimitCircuit({
      ...bundle.executors,
      ...ctx7.executors,
    });

    const session = await createFeaturePiSession({
      role: "ask",
      cfg,
      cwd: params.cwd,
      systemPrompt: buildAskSystemPrompt(),
      tools,
      executors,
      durability: params.durability,
      hostSignal: params.signal,
    });

    try {
      const sendOpts = {
        maxToolRounds: MAX_ASK_TOOL_ROUNDS,
        phase: "ask" as const,
        checkpointId: "ask:ask",
      };
      let usage: AskRunResult["usage"];
      const ciState =
        params.ciState ??
        (await loadAskCiState(params.pool, params.owner, params.repo, params.headSha));
      const firstTurn = await session.send(buildAskUserContent({ ...params, ciState }), sendOpts);
      usage = mergeExactUsage(usage, firstTurn.usage);
      // Keep the last non-empty answer so an empty retry never replaces a cut one.
      let answer = { text: firstTurn.text.trim(), end: firstTurn.end };

      for (
        let round = 0;
        round < MAX_ASK_FINALIZE_ROUNDS && (!answer.text || answer.end === "output_limit");
        round++
      ) {
        const finalizeTurn = await session.send(answer.text ? ASK_SHORTEN_NUDGE : ASK_RETRY_NUDGE, {
          phase: "ask",
          checkpointId: "ask:ask",
          // Keep tool definitions registered for cache prefixes; forbid tool turns.
          maxToolRounds: 0,
        });
        usage = mergeExactUsage(usage, finalizeTurn.usage);
        const text = finalizeTurn.text.trim();
        if (text) answer = { text, end: finalizeTurn.end };
      }

      const answerText = formatAskReply({
        question,
        answer: answer.text.length > 0 ? answer.text : ASK_FAILURE_MESSAGE,
        replyTarget,
        truncated: answer.text.length > 0 && answer.end === "output_limit",
      });

      logInfo("ask_run_completed", {
        provider: cfg.piProvider,
        hasAnswer: answer.text.length > 0,
        answerEnd: answer.end,
        metaRefusal: false,
        rateLimitCircuitOpened: circuit.isOpen(),
      });

      return { answer: answerText, replied: true, ...(usage ? { usage } : {}) };
    } finally {
      await session.dispose();
    }
  });
}
