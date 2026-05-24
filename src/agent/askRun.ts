import { complete, getModel } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool as PiTool,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { ReplyTarget } from "../commands/replyTarget.js";
import { logInfo, logWarn, logDebug } from "../evlog.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { buildAskSystemPrompt } from "./askPrompt.js";
import { formatAskFailureReply, formatAskReply } from "./formatAskReply.js";
import { buildContext7Tools } from "./context7Tools.js";
import {
  ASK_META_REFUSAL,
  buildAskGithubTools,
  classifyAskQuestionIntent,
  createAskPathGate,
  wrapTrustedContext,
  wrapUntrustedBlock,
} from "./askSafety.js";
import {
  bumpRateLimitConsecutiveFailures,
  classifyGithubToolError,
  formatToolErrorMessage,
  isInstallationTokenNearExpiry,
  logGithubToolRequestError,
} from "../github/githubRequestError.js";

import {
  ASK_CIRCUIT_OPEN_TOOL_RESULT,
  ASK_CIRCUIT_OPEN_USER_MESSAGE,
  ASK_FAILURE_MESSAGE,
  ASK_RETRY_NUDGE,
  ASK_RETRY_ROUNDS,
  RATE_LIMIT_CIRCUIT_THRESHOLD,
} from "../settings/index.js";

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
};

export type AskRunResult = {
  answer: string;
  replied: boolean;
};

function collectToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((p): p is ToolCall => p.type === "toolCall");
}

function assistantReplySummary(message: AssistantMessage): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function endsWithToolResults(messages: Message[]): boolean {
  return messages[messages.length - 1]?.role === "toolResult";
}

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
      "Use GitHub tools to inspect the PR diff and related files, then answer the question in user_question.",
    );
  }

  return blocks.join("\n\n");
}

export async function runAskRun(params: AskRunParams): Promise<AskRunResult> {
  const { cfg, token, tokenExpiresAtTs, tokenTtlMs, owner, repo, prNumber, question, replyTarget } =
    params;

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

  if (!Number.isFinite(tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  if (!Number.isFinite(tokenTtlMs) || tokenTtlMs <= 0) {
    throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
  }

  if (cfg.piProvider === "cursor") {
    const { runCursorAskRun } = await import("./cursor/askRunCursor.js");
    return runCursorAskRun(params);
  }

  const pathGate = createAskPathGate();
  if (params.codeAnchor?.path) {
    pathGate.addPaths([params.codeAnchor.path]);
  }
  const gh = buildAskGithubTools(
    token,
    { owner, repo, prNumber, headSha: params.headSha },
    {
      maxPrFilesListed: cfg.maxPrFilesListed,
      maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
    },
    pathGate,
  );
  try {
    await gh.executors.listPullRequestFiles({});
    if (pathGate.prChangedPaths.size === 0) {
      logDebug("ask_path_gate_prime_empty", { owner, repo, pr: prNumber });
    }
  } catch (e) {
    logDebug("ask_path_gate_prime_failed", {
      owner,
      repo,
      pr: prNumber,
      message: sanitizeLogMessage(e instanceof Error ? e.message : String(e)),
    });
  }
  const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });

  const piTools: PiTool[] = [...gh.piTools, ...ctx7.piTools];
  const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    ...gh.executors,
    ...ctx7.executors,
  };

  const model = getModel(cfg.piProvider, cfg.piModel as never);
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

  let lastAssistant: AssistantMessage | null = null;
  let stopLoop = false;
  let rateLimitConsecutiveFailures = 0;
  let rateLimitCircuitOpen = false;
  let circuitUserMessagePending = false;
  let retried = false;
  let toolRounds = 0;

  const logCtx = {
    expiresAtTs: tokenExpiresAtTs,
    ttlMs: tokenTtlMs,
    owner,
    repo,
    prNumber,
    mode: "ask" as const,
  };

  const githubExecutorNames = new Set(Object.keys(gh.executors));

  async function appendToolResults(toolCalls: ToolCall[]) {
    for (const call of toolCalls) {
      let text: string;
      let isError = false;

      if (rateLimitCircuitOpen && githubExecutorNames.has(call.name)) {
        logDebug("github_tool_circuit_short_circuit", { tool: call.name, mode: "ask" });
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: ASK_CIRCUIT_OPEN_TOOL_RESULT }],
          isError: true,
          timestamp: Date.now(),
        });
        continue;
      }

      const isGithubTool = githubExecutorNames.has(call.name);

      if (isGithubTool && isInstallationTokenNearExpiry(tokenExpiresAtTs)) {
        isError = true;
        const classified = classifyGithubToolError(new Error("token near expiry guard"), {
          expiresAtTs: tokenExpiresAtTs,
          ttlMs: tokenTtlMs,
        });
        logGithubToolRequestError(call.name, null, logCtx, classified);
        text = formatToolErrorMessage(call.name, null, classified);
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text }],
          isError,
          timestamp: Date.now(),
        });
        continue;
      }

      try {
        const exec = executors[call.name];
        if (!exec) throw new Error(`Unknown tool: ${call.name}`);
        const out = await exec(call.arguments);
        text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        if (githubExecutorNames.has(call.name)) {
          rateLimitConsecutiveFailures = 0;
        }
      } catch (e) {
        isError = true;
        if (isGithubTool) {
          const classified = classifyGithubToolError(e, {
            expiresAtTs: tokenExpiresAtTs,
            ttlMs: tokenTtlMs,
          });
          logGithubToolRequestError(call.name, e, logCtx, classified);
          text = formatToolErrorMessage(call.name, e, classified);
          rateLimitConsecutiveFailures = bumpRateLimitConsecutiveFailures(
            rateLimitConsecutiveFailures,
            classified.classification,
          );
          if (
            !rateLimitCircuitOpen &&
            rateLimitConsecutiveFailures >= RATE_LIMIT_CIRCUIT_THRESHOLD
          ) {
            rateLimitCircuitOpen = true;
            stopLoop = true;
            logWarn("ask_rate_limit_circuit_open", {
              consecutiveFailures: rateLimitConsecutiveFailures,
              owner,
              repo,
              pr: prNumber,
            });
            circuitUserMessagePending = true;
          }
        } else {
          const raw = e instanceof Error ? e.message : `Error executing ${call.name}: ${String(e)}`;
          text = raw;
          logDebug("tool_execute_failed", {
            tool: call.name,
            message: sanitizeLogMessage(raw),
            mode: "ask",
          });
        }
      }

      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text }],
        isError,
        timestamp: Date.now(),
      });
    }

    if (circuitUserMessagePending) {
      circuitUserMessagePending = false;
      context.messages.push({
        role: "user",
        content: ASK_CIRCUIT_OPEN_USER_MESSAGE,
        timestamp: Date.now(),
      });
    }
  }

  async function runToolLoop(maxRounds: number, requireToolsFirstRound: boolean) {
    for (let round = 0; round < maxRounds && !stopLoop; round++) {
      toolRounds += 1;
      const requireTools = requireToolsFirstRound && round === 0;
      const assistant = await complete(
        model,
        context,
        requireTools && piTools.length > 0 ? { toolChoice: "required" } : undefined,
      );
      lastAssistant = assistant;
      context.messages.push(assistant);

      const toolCalls = collectToolCalls(assistant);
      if (toolCalls.length === 0) {
        logDebug("ask_round_complete_no_tools", { round, pr: prNumber });
        break;
      }

      logDebug("ask_tool_round", { round, tools: toolCalls.map((t) => t.name), pr: prNumber });
      await appendToolResults(toolCalls);
    }
  }

  async function runFinalizePasses() {
    for (
      let f = 0;
      f < cfg.maxAskFinalizeRounds && endsWithToolResults(context.messages) && !stopLoop;
      f++
    ) {
      const assistant = await complete(model, context);
      lastAssistant = assistant;
      context.messages.push(assistant);
      const toolCalls = collectToolCalls(assistant);
      if (toolCalls.length === 0) break;
      await appendToolResults(toolCalls);
    }
  }

  async function runTextOnlyPass(prompt: string) {
    const savedTools = context.tools;
    context.tools = [];
    context.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    const assistant = await complete(model, context);
    lastAssistant = assistant;
    context.messages.push(assistant);
    context.tools = savedTools;
  }

  stopLoop = false;
  await runToolLoop(cfg.maxAskToolRounds, true);
  await runFinalizePasses();

  let summary = lastAssistant ? assistantReplySummary(lastAssistant) : "";

  if (!summary && !retried) {
    retried = true;
    logDebug("ask_retry_nudge", { owner, repo, pr: prNumber });
    context.messages.push({ role: "user", content: ASK_RETRY_NUDGE, timestamp: Date.now() });
    stopLoop = false;
    await runToolLoop(ASK_RETRY_ROUNDS, false);
    await runFinalizePasses();
    summary = lastAssistant ? assistantReplySummary(lastAssistant) : "";
  }

  if (!summary) {
    logWarn("ask_text_only_fallback", { owner, repo, pr: prNumber });
    await runTextOnlyPass(
      "Respond with plain text only (no tool calls). Answer the question using what you found, or explain clearly what blocked a complete answer.",
    );
    summary = lastAssistant ? assistantReplySummary(lastAssistant) : "";
  }

  const answerText =
    summary.length > 0
      ? formatAskReply({ question, answer: summary, replyTarget })
      : formatAskFailureReply({ question, message: ASK_FAILURE_MESSAGE, replyTarget });

  logInfo("ask_completed", {
    owner,
    repo,
    pr: prNumber,
    hasAnswer: summary.length > 0,
    inline: replyTarget.kind === "inlineReviewThread",
  });
  logInfo("ask_run_completed", {
    toolRounds,
    rateLimitCircuitOpened: rateLimitCircuitOpen,
    hasAnswer: summary.length > 0,
    metaRefusal: false,
  });

  return { answer: answerText, replied: true };
}
