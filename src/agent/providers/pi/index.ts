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
import { recordReviewMetric } from "../../../review/run/reviewRunMetrics.js";
import { AppError } from "../../../errors/appError.js";
import type {
  AgentRunnerProvider,
  AgentRunnerSendOptions,
  AgentRunnerToolExecutor,
} from "../interface.js";
import {
  exactUsageFromProviderUsage,
  mergeExactUsage,
  promptMetadataFromText,
} from "../usageMetadata.js";

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

function safeRecordToolCallMetric(
  event: Extract<Parameters<typeof recordReviewMetric>[0], { kind: "tool_call" }>,
): void {
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
): ReturnType<typeof defineTool> {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      if (!executor) {
        safeRecordToolCallMetric({ kind: "tool_call", name: tool.name, ok: false });
        throw new AppError({
          code: "provider.missing_tool_executor",
          message: `No executor registered for tool ${tool.name}`,
          context: { toolName: tool.name },
        });
      }
      try {
        if (refreshBeforeTool) {
          await refreshBeforeTool(tool.name);
        }
        const result = await executor(params);
        const size = toolResultSize(result);
        safeRecordToolCallMetric({
          kind: "tool_call",
          name: tool.name,
          ok: true,
          resultBytes: size.resultBytes,
          resultCharacters: size.resultCharacters,
        });
        return {
          content: [{ type: "text" as const, text: toolResultToText(result) }],
          details: result && typeof result === "object" ? (result as Record<string, unknown>) : {},
        };
      } catch (error) {
        safeRecordToolCallMetric({ kind: "tool_call", name: tool.name, ok: false });
        throw error;
      }
    },
  });
}

export const piAgentRunnerProvider: AgentRunnerProvider = {
  async createSession({ cfg, cwd, systemPrompt, tools, executors, refreshBeforeTool }) {
    const agentDir = await mkdtemp(join(tmpdir(), "pr-agent-pi-"));
    try {
      const authPath = join(agentDir, "auth.json");
      const modelRuntime = await ModelRuntime.create({
        authPath,
        modelsPath: cfg.modelsJsonPath,
        allowModelNetwork: false,
      });
      for (const [provider, key] of Object.entries(cfg.modelProviderKeys)) {
        if (key.trim()) await modelRuntime.setRuntimeApiKey(provider, key.trim());
      }
      await chmod(authPath, 0o600).catch(() => undefined);
      if (cfg.modelsJsonPath) {
        const loadError = modelRuntime.getError();
        if (loadError) {
          throw new AppError({
            code: "provider.models_load_failed",
            message: loadError,
            context: { modelsJsonPath: cfg.modelsJsonPath },
          });
        }
      }
      const model = modelRuntime.getModel(cfg.piProvider, cfg.piModel);
      if (!model) {
        throw new AppError({
          code: "provider.model_not_found",
          message: cfg.modelsJsonPath
            ? `Model not found: ${cfg.piProvider}/${cfg.piModel} (models.json: ${cfg.modelsJsonPath})`
            : `Model not found: ${cfg.piProvider}/${cfg.piModel}`,
          context: {
            piProvider: cfg.piProvider,
            piModel: cfg.piModel,
            ...(cfg.modelsJsonPath ? { modelsJsonPath: cfg.modelsJsonPath } : {}),
          },
        });
      }
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: cwd ?? process.cwd(),
        agentDir,
        settingsManager,
        systemPromptOverride: () => systemPrompt,
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
      const allToolNames = tools.map((tool) => tool.name);
      const { session } = await createAgentSession({
        cwd: cwd ?? process.cwd(),
        agentDir,
        model,
        thinkingLevel: "off",
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(cwd ?? process.cwd()),
        noTools: "builtin",
        customTools: tools.map((tool) =>
          toCodingAgentTool(tool, executors[tool.name], refreshBeforeTool),
        ),
      });
      let abortPromise: Promise<void> | undefined;

      const abort = (): Promise<void> => {
        abortPromise ??= (async () => {
          await session.abort();
        })();
        return abortPromise;
      };

      return {
        async send(prompt: string, opts?: AgentRunnerSendOptions) {
          if (abortPromise) {
            throw new AppError({
              code: "agent.session_aborted",
              message: "Agent runner session aborted",
            });
          }
          let sessionToolTurnCount = 0;
          let finalText = "";
          let aggregatedUsage: ReturnType<typeof exactUsageFromProviderUsage> | undefined;
          // Inactivity (idle) budget, not a total wall-clock cap: a single prompt() drives the whole
          // multi-round agentic loop, whose duration scales with PR/repo size. We abort only when the
          // provider goes silent (no streamed message/tool/turn events) for the configured window, so
          // large-but-progressing reviews finish while genuine hangs are still cut off.
          const idleTimeoutMs = cfg.providerPromptTimeoutMs;
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
          const unsubscribe = session.subscribe((event) => {
            // Any streamed event (token update, tool execution, turn boundary) is forward progress.
            markActivity();
            if (event.type !== "turn_end") return;
            sessionToolTurnCount += 1;
            if (event.message.role === "assistant" && event.message.usage) {
              aggregatedUsage = mergeExactUsage(
                aggregatedUsage,
                exactUsageFromProviderUsage(event.message.usage),
              );
            }
            // A tool-free turn is the terminal turn of prompt(); capture only that answer text.
            if (event.toolResults.length === 0) {
              finalText = assistantMessageText(event.message);
            } else if (opts?.maxToolRounds != null && sessionToolTurnCount >= opts.maxToolRounds) {
              void session.abort();
            }
          });
          try {
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
            return aggregatedUsage
              ? { text: finalText, prompt: promptMeta, usage: aggregatedUsage }
              : { text: finalText, prompt: promptMeta };
          } finally {
            if (idleCheckHandle) clearInterval(idleCheckHandle);
            unsubscribe();
          }
        },
        abort,
        // customTools are fixed at session creation; restrictToTools only toggles active names.
        restrictToTools(nextTools, _executors) {
          session.setActiveToolsByName(nextTools.map((tool) => tool.name));
        },
        restoreTools() {
          session.setActiveToolsByName(allToolNames);
        },
        async dispose() {
          try {
            session.dispose();
          } finally {
            await rm(agentDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  },
};
