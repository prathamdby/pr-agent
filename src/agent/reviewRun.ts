import { complete, getModel } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool as PiTool,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import { logInfo, logWarn, logDebug } from "../evlog.js";
import { buildContext7Tools } from "./context7Tools.js";
import { buildGithubTools } from "./githubTools.js";
import { upsertReviewSummaryComment } from "../github/reviewPublish.js";
import { renderReviewFailureNotice } from "../agentWork/progressComment.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  type CachedPrDiffIndex,
} from "./reviewLocationValidation.js";
import { automatedSecuritySystemPrompt } from "./securityPrompt.js";
import { buildAutomatedSystemPrompt } from "./reviewSystemPrompt.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
  PUBLISH_BUDGET_EXHAUSTED_MESSAGE,
  type SubmitReviewState,
} from "./submitReviewTool.js";
import { PRE_SUBMIT_USER_MESSAGE, VALIDATION_REPAIR_ROUNDS } from "./reviewPromptBlocks.js";
import {
  REVIEW_PAYLOAD_MINIMAL_EXAMPLE,
  reviewSummarySentinelForMode,
  type ReviewMode,
} from "./reviewSchema.js";
import {
  bumpRateLimitConsecutiveFailures,
  classifyGithubToolError,
  formatToolErrorMessage,
  isInstallationTokenNearExpiry,
  logGithubToolRequestError,
} from "../github/githubRequestError.js";

const RATE_LIMIT_CIRCUIT_THRESHOLD = 3;
const CIRCUIT_OPEN_USER_MESSAGE =
  "Stop GitHub tool calls; call submitReview now with your current analysis from the conversation above.";
const CIRCUIT_OPEN_TOOL_RESULT =
  "Rate-limit circuit open: further GitHub investigation tools are blocked for this review run. Call submitReview now.";

const PROSE_ONLY_NUDGE =
  "You replied with text only. Call submitReview now with a complete ReviewPayload (required).";

export type ReviewRunResult = {
  lastAssistant: AssistantMessage;
  published: boolean;
  publishAttempts: number;
};

const PUBLISH_RECOVERY_ROUNDS = 4;

const PUBLISH_RECOVERY_PROMPTS = [
  "You ended with a text reply but never called submitReview. Call submitReview exactly once now with a complete ReviewPayload based on your analysis above. Do not continue investigating unless required to fix payload validation.",
  "The structured review was still not published. You must call submitReview now with a valid ReviewPayload. No prose-only replies.",
  "Final publish attempt: call submitReview immediately with your ReviewPayload. This is required to complete the review.",
] as const;

function collectToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((p): p is ToolCall => p.type === "toolCall");
}

function assistantReplySummary(message: AssistantMessage): string {
  const parts = message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text);
  return parts.join("\n").trim();
}

function endsWithToolResults(messages: Message[]): boolean {
  return messages[messages.length - 1]?.role === "toolResult";
}

type ToolLoopMode = {
  toolChoice: "first-round" | "every-round" | "optional" | "required";
  nudgeOnProseOnly?: boolean;
};

export async function runFullPrReview(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  mode?: ReviewMode;
  userSupplement?: string;
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
  initialPublishState?: { published?: boolean; inlinePublished?: boolean };
  recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { githubId?: string | number; meta?: Record<string, unknown> },
  ) => Promise<void>;
  shouldAbortPublish?: () => Promise<boolean>;
}): Promise<ReviewRunResult> {
  const {
    cfg,
    token,
    tokenExpiresAtTs,
    tokenTtlMs,
    owner,
    repo,
    prNumber,
    headSha,
    userSupplement,
  } = params;
  if (!Number.isFinite(tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  if (!Number.isFinite(tokenTtlMs) || tokenTtlMs <= 0) {
    throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
  }
  const reviewMode = params.mode ?? "review";

  const gh = buildGithubTools(token, {
    maxPrFilesListed: cfg.maxPrFilesListed,
    maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
  });
  const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });
  let cachedDiffIndex: CachedPrDiffIndex = createCachedPrDiffIndex();
  const submitState: SubmitReviewState = createSubmitReviewState({
    published: params.initialPublishState?.published,
    inlinePublished: params.initialPublishState?.inlinePublished,
  });
  const publishCtx = { owner, repo, prNumber, headSha };
  const { piTool: submitTool, executor: submitExecutor } = buildSubmitReviewTool({
    cfg,
    token,
    ctx: publishCtx,
    mode: reviewMode,
    state: submitState,
    cachedDiffIndex,
    shouldLinkToSummary: params.shouldLinkToSummary,
    summaryCommentIdHint: params.summaryCommentIdHint,
    recordPublishStep: params.recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
  });

  const reviewGithubExecutors = { ...gh.executors };
  if (reviewGithubExecutors.listPullRequestFiles) {
    const originalListFiles = reviewGithubExecutors.listPullRequestFiles;
    reviewGithubExecutors.listPullRequestFiles = async (args) => {
      const out = await originalListFiles(args);
      if (out && typeof out === "object") {
        ingestListPullRequestFilesResult(
          cachedDiffIndex,
          out as {
            truncated?: boolean;
            files?: Array<{ filename: string; patch?: string; patchOmitted?: boolean }>;
          },
        );
      }
      return out;
    };
  }

  const piTools: PiTool[] = [...gh.piTools, ...ctx7.piTools, submitTool];
  const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    ...reviewGithubExecutors,
    ...ctx7.executors,
    submitReview: submitExecutor,
  };

  const model = getModel(cfg.piProvider, cfg.piModel as never);

  const userContent = [
    `Target repository: ${owner}/${repo}`,
    `Pull request #: ${prNumber}`,
    `Head commit SHA: ${headSha}`,
    userSupplement ? `\nAdditional instruction:\n${userSupplement}\n` : "",
    "",
    reviewMode === "review-security"
      ? "Perform a deep security review of the PR diff using investigation tools, then call submitReview exactly once with a complete ReviewPayload."
      : "Perform a full review using investigation tools, then call submitReview exactly once with a complete ReviewPayload.",
  ].join("\n");

  const context: Context = {
    systemPrompt:
      reviewMode === "review-security"
        ? automatedSecuritySystemPrompt
        : buildAutomatedSystemPrompt(),
    messages: [
      {
        role: "user",
        content: userContent,
        timestamp: Date.now(),
      },
    ],
    tools: piTools,
  };

  let lastAssistant: AssistantMessage | null = null;
  let stopLoop = false;
  let publishAttempts = 0;
  let rateLimitConsecutiveFailures = 0;
  let rateLimitCircuitOpen = false;
  let circuitUserMessagePending = false;

  const logCtx = {
    expiresAtTs: tokenExpiresAtTs,
    ttlMs: tokenTtlMs,
    owner,
    repo,
    prNumber,
    mode: reviewMode,
  };

  const githubExecutorNames = new Set(Object.keys(reviewGithubExecutors));

  async function appendToolResults(toolCalls: ToolCall[]) {
    for (const call of toolCalls) {
      let text: string;
      let isError = false;

      if (
        rateLimitCircuitOpen &&
        call.name !== "submitReview" &&
        githubExecutorNames.has(call.name)
      ) {
        logDebug("github_tool_circuit_short_circuit", { tool: call.name });
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: CIRCUIT_OPEN_TOOL_RESULT }],
          isError: true,
          timestamp: Date.now(),
        });
        continue;
      }

      const isGithubTool = githubExecutorNames.has(call.name);

      if (isGithubTool && isInstallationTokenNearExpiry(tokenExpiresAtTs)) {
        logDebug("token_expired_before_tool", {
          tool: call.name,
          tokenExpiresInSeconds: Math.max(0, Math.floor((tokenExpiresAtTs - Date.now()) / 1000)),
        });
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
        if (call.name === "submitReview" && submitState.published) {
          stopLoop = true;
        }
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
            logWarn("review_rate_limit_circuit_open", {
              consecutiveFailures: rateLimitConsecutiveFailures,
              owner,
              repo,
              pr: prNumber,
              mode: reviewMode,
            });
            circuitUserMessagePending = true;
          }
        } else {
          if (call.name === "submitReview") {
            const msg = e instanceof Error ? e.message : String(e);
            text =
              msg === PUBLISH_BUDGET_EXHAUSTED_MESSAGE
                ? msg
                : "Review publish failed. Retry submitReview with a valid ReviewPayload if publish budget remains.";
          } else {
            text = e instanceof Error ? e.message : `Error executing ${call.name}: ${String(e)}`;
          }
          logDebug("tool_execute_failed", { tool: call.name, message: text.slice(0, 200) });
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
        content: CIRCUIT_OPEN_USER_MESSAGE,
        timestamp: Date.now(),
      });
    }
  }

  async function runToolLoop(maxRounds: number, loopMode: ToolLoopMode) {
    for (let round = 0; round < maxRounds && !stopLoop; round++) {
      const requireTools =
        loopMode.toolChoice === "every-round" ||
        loopMode.toolChoice === "required" ||
        (loopMode.toolChoice === "first-round" && round === 0);

      const assistant = await complete(
        model,
        context,
        requireTools && piTools.length > 0 ? { toolChoice: "required" } : undefined,
      );
      lastAssistant = assistant;
      context.messages.push(assistant);

      const toolCalls = collectToolCalls(assistant);
      if (toolCalls.length === 0) {
        logDebug("agent_round_complete_no_tools", {
          mode: reviewMode,
          round,
          summary: assistantReplySummary(assistant).slice(0, 200),
        });
        if (loopMode.nudgeOnProseOnly && !stopLoop && round < maxRounds - 1) {
          context.messages.push({
            role: "user",
            content: PROSE_ONLY_NUDGE,
            timestamp: Date.now(),
          });
          continue;
        }
        break;
      }

      logDebug("agent_tool_round", {
        mode: reviewMode,
        round,
        tools: toolCalls.map((t) => t.name),
      });
      await appendToolResults(toolCalls);
    }
  }

  async function runValidationRepair() {
    for (let repair = 0; repair < VALIDATION_REPAIR_ROUNDS && !submitState.published; repair++) {
      const validationError = submitState.lastValidationError;
      if (!validationError) break;
      logDebug("review_payload_repair_attempt", {
        mode: reviewMode,
        repair,
        message: validationError.slice(0, 200),
      });
      const err = validationError;
      submitState.lastValidationError = null;
      context.messages.push({
        role: "user",
        content: [
          err,
          "Fix the payload and call submitReview again with a complete ReviewPayload.",
          `Minimal valid example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
        ].join("\n\n"),
        timestamp: Date.now(),
      });
      stopLoop = false;
      const savedTools = context.tools;
      context.tools = [submitTool];
      await runToolLoop(1, { toolChoice: "required", nudgeOnProseOnly: true });
      context.tools = savedTools;
    }
  }

  async function runInvestigationPhase() {
    stopLoop = false;
    await runToolLoop(cfg.maxToolRounds, { toolChoice: "first-round" });

    if (!submitState.published && !stopLoop) {
      if (endsWithToolResults(context.messages)) {
        context.messages.push({
          role: "user",
          content: PRE_SUBMIT_USER_MESSAGE,
          timestamp: Date.now(),
        });
        await runToolLoop(2, { toolChoice: "required", nudgeOnProseOnly: true });
      } else {
        context.messages.push({
          role: "user",
          content: PROSE_ONLY_NUDGE,
          timestamp: Date.now(),
        });
        await runToolLoop(1, { toolChoice: "required", nudgeOnProseOnly: true });
      }
    }

    await runValidationRepair();
  }

  async function runPublishRecoveryPhase(attemptIndex: number) {
    const prompt =
      PUBLISH_RECOVERY_PROMPTS[attemptIndex - 1] ??
      PUBLISH_RECOVERY_PROMPTS[PUBLISH_RECOVERY_PROMPTS.length - 1];
    const isLastAttempt = attemptIndex >= cfg.maxReviewPublishAttempts - 1;
    logInfo("review_publish_retry", {
      mode: reviewMode,
      attempt: attemptIndex + 1,
      maxAttempts: cfg.maxReviewPublishAttempts,
      submitOnly: isLastAttempt,
      owner,
      repo,
      pr: prNumber,
    });
    stopLoop = false;
    context.messages.push({
      role: "user",
      content: [
        prompt,
        `Minimal valid ReviewPayload example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
      ].join("\n\n"),
      timestamp: Date.now(),
    });
    const savedTools = context.tools;
    if (isLastAttempt) {
      context.tools = [submitTool];
    }
    await runToolLoop(PUBLISH_RECOVERY_ROUNDS, {
      toolChoice: "every-round",
      nudgeOnProseOnly: true,
    });
    context.tools = savedTools;
    await runValidationRepair();
  }

  async function runMaintainerPlainTextFallback() {
    logWarn("agent_publish_fallback", {
      mode: reviewMode,
      publishAttempts,
      publishCallCount: submitState.publishCallCount,
      maxPublishCalls: cfg.maxReviewPublishCalls,
      endsOnToolResult: endsWithToolResults(context.messages),
    });
    const retryCommand = reviewMode === "review-security" ? "/review-security" : "/review";
    const body = renderReviewFailureNotice({ mode: reviewMode, retryCommand });
    try {
      const comment = await upsertReviewSummaryComment(
        token,
        owner,
        repo,
        prNumber,
        body,
        reviewSummarySentinelForMode(reviewMode),
      );
      logInfo("review_publish_fallback_comment", {
        mode: reviewMode,
        owner,
        repo,
        pr: prNumber,
        commentId: comment.id,
        updated: comment.updated,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logWarn("review_publish_fallback_comment_failed", {
        mode: reviewMode,
        owner,
        repo,
        pr: prNumber,
        message,
      });
    }
  }

  for (
    let attempt = 0;
    attempt < cfg.maxReviewPublishAttempts && !submitState.published;
    attempt++
  ) {
    publishAttempts = attempt + 1;
    if (attempt === 0) {
      await runInvestigationPhase();
    } else {
      await runPublishRecoveryPhase(attempt);
    }
  }

  if (!submitState.published) {
    logWarn("review_publish_exhausted", {
      mode: reviewMode,
      attempts: publishAttempts,
      maxAttempts: cfg.maxReviewPublishAttempts,
      owner,
      repo,
      pr: prNumber,
    });
  }

  if (!submitState.published) {
    await runMaintainerPlainTextFallback();
  }

  if (!lastAssistant) {
    throw new Error("Agent produced no assistant message");
  }

  return { lastAssistant, published: submitState.published, publishAttempts };
}
