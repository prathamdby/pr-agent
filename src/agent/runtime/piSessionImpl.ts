import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { TextContent, Tool as PiTool } from "@earendil-works/pi-ai";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.js";
import { AppError } from "../../errors/appError.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import {
  exactUsageFromProviderUsage,
  mergeExactUsage,
  promptMetadataFromText,
} from "../providers/usageMetadata.js";
import {
  canCompactAtBoundary,
  SERVER_COMPACTION_INSTRUCTIONS,
  structuredStateReinjectionPrompt,
} from "./compactionPolicy.js";
import { createSanitizedEventSink } from "./lifecycleSanitizer.js";
import { bindPromptCacheRetention } from "./modelRuntimeCache.js";
import { cacheIdentityFromAssignment, sessionCacheIdFromIdentity } from "./promptCachePolicy.js";
import { resolveThinkingLevel } from "./thinkingPolicy.js";
import type { AuthoritativeStructuredState, PiSession, PiSessionCreateParams } from "./types.js";

function toolResultToText(result: unknown): string {
  if (result === undefined) return "";
  return typeof result === "string" ? result : JSON.stringify(result);
}

function toolResultSize(result: unknown): { resultBytes: number; resultCharacters: number } {
  const text = toolResultToText(result);
  return {
    resultCharacters: text.length,
    resultBytes: Buffer.byteLength(text, "utf8"),
  };
}

function safeRecordReviewMetric(event: Parameters<typeof recordReviewMetric>[0]): void {
  try {
    recordReviewMetric(event);
  } catch {
    // metrics are best-effort outside review runs
  }
}

function assistantMessageText(message: TurnEndEvent["message"]): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function toCodingAgentTool(
  tool: PiTool,
  executor: AgentRunnerToolExecutor | undefined,
  refreshBeforeTool?: (toolName: string) => Promise<void>,
  setExternalMutationPending?: (pending: boolean) => void,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const startedAt = Date.now();
      if (!executor) {
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: false,
          durationMs: Date.now() - startedAt,
          errorMessage: `No executor registered for tool ${tool.name}`,
        });
        throw new AppError({
          code: "provider.missing_tool_executor",
          message: `No executor registered for tool ${tool.name}`,
          context: { toolName: tool.name },
        });
      }
      setExternalMutationPending?.(true);
      try {
        if (refreshBeforeTool) {
          await refreshBeforeTool(tool.name);
        }
        const result = await executor(params);
        const size = toolResultSize(result);
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: true,
          durationMs: Date.now() - startedAt,
          resultBytes: size.resultBytes,
          resultCharacters: size.resultCharacters,
        });
        return {
          content: [{ type: "text" as const, text: toolResultToText(result) }],
          details: result && typeof result === "object" ? (result as Record<string, unknown>) : {},
        };
      } catch (error) {
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: false,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        setExternalMutationPending?.(false);
      }
    },
  });
}

export async function createPiSessionImpl(params: PiSessionCreateParams): Promise<PiSession> {
  const agentDir = await mkdtemp(join(tmpdir(), "pr-agent-pi-"));
  let structuredState: AuthoritativeStructuredState = params.structuredState;
  let pendingExternalMutation = false;
  const emit = createSanitizedEventSink(params.eventSink);

  try {
    const authPath = join(agentDir, "auth.json");
    const modelRuntime = await ModelRuntime.create({
      authPath,
      modelsPath: params.cfg.modelsJsonPath,
      allowModelNetwork: false,
    });
    for (const [provider, key] of Object.entries(params.cfg.modelProviderKeys)) {
      if (key.trim()) await modelRuntime.setRuntimeApiKey(provider, key.trim());
    }
    await chmod(authPath, 0o600).catch(() => undefined);
    if (params.cfg.modelsJsonPath) {
      const loadError = modelRuntime.getError();
      if (loadError) {
        throw new AppError({
          code: "provider.models_load_failed",
          message: loadError,
          context: { modelsJsonPath: params.cfg.modelsJsonPath },
        });
      }
    }
    const model = modelRuntime.getModel(params.primary.provider, params.primary.model);
    if (!model) {
      throw new AppError({
        code: "provider.model_not_found",
        message: params.cfg.modelsJsonPath
          ? `Model not found: ${params.primary.provider}/${params.primary.model} (models.json: ${params.cfg.modelsJsonPath})`
          : `Model not found: ${params.primary.provider}/${params.primary.model}`,
        context: {
          piProvider: params.primary.provider,
          piModel: params.primary.model,
          ...(params.cfg.modelsJsonPath ? { modelsJsonPath: params.cfg.modelsJsonPath } : {}),
        },
      });
    }
    bindPromptCacheRetention(modelRuntime, params.promptCachePolicy.retention);

    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: params.compactionPolicy.enabled,
      },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: params.cwd ?? process.cwd(),
      agentDir,
      settingsManager,
      systemPromptOverride: () => params.systemPrompt,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      extensionsOverride: () => ({
        extensions: [],
        errors: [],
        runtime: createExtensionRuntime(),
      }),
    });
    await resourceLoader.reload();
    const allToolNames = params.tools.map((tool) => tool.name);
    const initialThinking = resolveThinkingLevel({
      policy: params.thinkingPolicy,
      phase: "synthesis",
    });
    const sessionCacheId = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment(params.role, params.primary, params.specialistId),
    );
    const cwd = params.cwd ?? process.cwd();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: initialThinking,
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd, { id: sessionCacheId }),
      noTools: "builtin",
      customTools: params.tools.map((tool) =>
        toCodingAgentTool(
          tool,
          params.executors[tool.name],
          params.refreshBeforeTool,
          (pending) => {
            pendingExternalMutation = pending;
          },
        ),
      ),
    });

    let abortPromise: Promise<void> | undefined;
    const abort = (): Promise<void> => {
      abortPromise ??= (async () => {
        await session.abort();
        emit({
          kind: "cancellation",
          role: params.role,
          provider: params.primary.provider,
          model: params.primary.model,
          reason: "abort",
        });
      })();
      return abortPromise;
    };

    const piSession: PiSession = {
      role: params.role,
      primary: params.primary,
      async send(prompt, opts) {
        if (abortPromise) {
          throw new AppError({
            code: "agent.session_aborted",
            message: "Agent runner session aborted",
          });
        }
        const thinking = resolveThinkingLevel({
          policy: params.thinkingPolicy,
          phase: opts.phase,
        });
        session.setThinkingLevel(thinking);

        let sessionToolTurnCount = 0;
        let finalText = "";
        let aggregatedUsage: ReturnType<typeof exactUsageFromProviderUsage> | undefined;
        const idleTimeoutMs = opts.deadlineMs ?? params.cfg.providerPromptTimeoutMs;
        const idleTimeoutEnabled = typeof idleTimeoutMs === "number" && idleTimeoutMs > 0;
        let idleCheckHandle: ReturnType<typeof setInterval> | undefined;
        let rejectOnIdle: ((error: Error) => void) | undefined;
        let lastActivityAt = Date.now();
        let idleRejected = false;
        const markActivity = () => {
          lastActivityAt = Date.now();
        };
        const rejectForIdle = () => {
          if (idleRejected) return;
          idleRejected = true;
          void session.abort();
          rejectOnIdle?.(
            new AppError({
              code: "pi.prompt_idle_timeout",
              message: `Provider prompt timeout: no activity for ${idleTimeoutMs}ms`,
            }),
          );
        };
        const startIdleTimer = () => {
          const checkEveryMs = Math.max(1, Math.min(idleTimeoutMs, 1000));
          idleCheckHandle = setInterval(() => {
            if (Date.now() - lastActivityAt >= idleTimeoutMs) {
              rejectForIdle();
            }
          }, checkEveryMs);
        };

        emit({
          kind: "turn",
          role: params.role,
          phase: opts.phase,
          checkpointId: opts.checkpointId,
          provider: params.primary.provider,
          model: params.primary.model,
        });

        const unsubscribe = session.subscribe((event) => {
          markActivity();
          if (event.type === "tool_execution_start") {
            emit({
              kind: "tool",
              role: params.role,
              phase: opts.phase,
              toolName: event.toolName,
              checkpointId: opts.checkpointId,
              provider: params.primary.provider,
              model: params.primary.model,
            });
          }
          if (event.type !== "turn_end") return;
          sessionToolTurnCount += 1;
          if (event.message.role === "assistant" && event.message.usage) {
            aggregatedUsage = mergeExactUsage(
              aggregatedUsage,
              exactUsageFromProviderUsage(event.message.usage),
            );
            emit({
              kind: "usage",
              role: params.role,
              phase: opts.phase,
              provider: params.primary.provider,
              model: params.primary.model,
            });
          }
          if (event.toolResults.length === 0) {
            finalText = assistantMessageText(event.message);
          } else if (opts.maxToolRounds != null && sessionToolTurnCount >= opts.maxToolRounds) {
            void session.abort();
          }
        });

        let sendStartedAt: number | undefined;
        try {
          sendStartedAt = Date.now();
          const run = session.prompt(prompt);
          if (idleTimeoutEnabled) {
            const idle = new Promise<never>((_, reject) => {
              rejectOnIdle = reject;
              markActivity();
              startIdleTimer();
            });
            await Promise.race([run, idle]);
          } else {
            await run;
          }
          const promptMeta = promptMetadataFromText(prompt);
          emit({
            kind: "completion",
            role: params.role,
            phase: opts.phase,
            checkpointId: opts.checkpointId,
            provider: params.primary.provider,
            model: params.primary.model,
            ok: true,
          });
          return aggregatedUsage
            ? { text: finalText, prompt: promptMeta, usage: aggregatedUsage }
            : { text: finalText, prompt: promptMeta };
        } catch (error) {
          emit({
            kind: "failure",
            role: params.role,
            phase: opts.phase,
            checkpointId: opts.checkpointId,
            provider: params.primary.provider,
            model: params.primary.model,
            ok: false,
            failureCode: error instanceof AppError ? error.code : "runtime.session_send_failed",
          });
          throw error;
        } finally {
          if (sendStartedAt !== undefined) {
            safeRecordReviewMetric({
              kind: "session_send_span",
              sendMs: Date.now() - sendStartedAt,
            });
          }
          if (idleCheckHandle) clearInterval(idleCheckHandle);
          unsubscribe();
        }
      },
      setActiveTools(nextTools) {
        session.setActiveToolsByName(nextTools.map((tool) => tool.name));
      },
      restoreTools() {
        session.setActiveToolsByName(allToolNames);
      },
      abort,
      async dispose() {
        try {
          session.dispose();
        } finally {
          await rm(agentDir, { recursive: true, force: true });
        }
      },
      async restartWithFallback(restartParams) {
        if (!params.fallback) {
          throw new AppError({
            code: "runtime.fallback_unavailable",
            message: "No fallback model assignment configured for this session",
            context: { role: params.role },
          });
        }
        await piSession.dispose();
        return createPiSessionImpl({
          ...params,
          primary: params.fallback,
          structuredState: restartParams.structuredState,
        });
      },
      getStructuredState: () => structuredState,
      setStructuredState(state) {
        structuredState = state;
      },
      setExternalMutationPending(pending) {
        pendingExternalMutation = pending;
      },
      async compactIfNeeded(reason = "threshold") {
        if (!params.compactionPolicy.enabled) return false;
        const gate = canCompactAtBoundary({
          turnSettled: true,
          pendingExternalMutation,
        });
        if (!gate.ok) {
          throw new AppError({
            code: "runtime.compaction_blocked_pending_mutation",
            message: "Compaction cannot run while an external mutation is unresolved",
            context: { reason: gate.reason },
          });
        }
        const instructions = [
          params.compactionPolicy.instructions || SERVER_COMPACTION_INSTRUCTIONS,
          structuredStateReinjectionPrompt(structuredState),
        ].join("\n\n");
        await session.compact(instructions);
        emit({
          kind: "compaction",
          role: params.role,
          provider: params.primary.provider,
          model: params.primary.model,
          reason,
        });
        try {
          // Re-assert authoritative state after compaction summary (advisory only).
          await session.prompt(structuredStateReinjectionPrompt(structuredState));
        } catch (error) {
          emit({
            kind: "failure",
            role: params.role,
            provider: params.primary.provider,
            model: params.primary.model,
            ok: false,
            failureCode: "runtime.compaction_reinjection_failed",
          });
          await abort();
          if (error instanceof AppError) throw error;
          throw new AppError({
            code: "runtime.compaction_reinjection_failed",
            message: "Failed to re-inject structured state after compaction",
            cause: error,
          });
        }
        return true;
      },
    };

    return piSession;
  } catch (error) {
    await rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
