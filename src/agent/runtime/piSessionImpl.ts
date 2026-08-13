import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.js";
import { AppError } from "../../errors/appError.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import {
  jsonObjectSchema,
  isJsonString,
  asJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../util/jsonValue.js";
import * as v from "valibot";
import {
  exactUsageFromProviderUsage,
  mergeExactUsage,
  promptMetadataFromText,
} from "../providers/usageMetadata.js";
import { createSanitizedEventSink } from "./lifecycleSanitizer.js";
import { bindPromptCacheRetention, type PromptCacheRuntime } from "./modelRuntimeCache.js";
import { cacheIdentityFromAssignment, sessionCacheIdFromIdentity } from "./promptCachePolicy.js";
import { resolveThinkingLevel } from "./thinkingPolicy.js";
import type { AuthoritativeStructuredState, PiSession, PiSessionCreateParams } from "./types.js";

export type PiModelInfo = {
  readonly id: string;
  readonly provider?: string;
  readonly api?: string;
};

export type PiModelRuntimeCreateOptions = {
  readonly authPath?: string;
  readonly modelsPath?: string | null;
  readonly allowModelNetwork?: boolean;
};

export type PiModelRuntime = PromptCacheRuntime & {
  setRuntimeApiKey(provider: string, key: string): Promise<void>;
  getError(): string | undefined;
  getModel(provider: string, model: string): PiModelInfo | undefined;
};

export type PiResourceLoader = {
  reload(): Promise<void>;
};

export type PiSettingsManager = {
  readonly compaction?: { readonly enabled: boolean };
};

export type PiSessionManagerHandle = {
  readonly id?: string;
};

export type PiCompactionSettings = {
  readonly compaction: { readonly enabled: boolean };
};

export type PiExtensionRuntime = {
  readonly dispose?: () => void;
};

export type PiToolExecuteContext = {
  readonly cwd?: string;
};

export type PiDefinedTool = {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly execute: (
    toolCallId: string,
    params: JsonObject,
    onUpdate?: undefined,
    signal?: undefined,
    ctx?: PiToolExecuteContext,
  ) => Promise<{
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
    readonly details?: JsonObject;
  }>;
};

export type PiDefineToolInput = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly execute: PiDefinedTool["execute"];
};

export type PiSdkTurnEndEvent = {
  readonly type: "turn_end";
  readonly toolResults: readonly JsonObject[];
  readonly message: {
    readonly role: string;
    readonly usage?: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly totalTokens: number;
      readonly cost: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheWrite: number;
        readonly total: number;
      };
    };
    readonly content: readonly (
      | { readonly type: "text"; readonly text: string }
      | { readonly type: "thinking"; readonly thinking: string }
      | {
          readonly type: "toolCall";
          readonly id: string;
          readonly name: string;
          readonly arguments: JsonObject;
        }
    )[];
  };
};

export type PiSdkEvent =
  | PiSdkTurnEndEvent
  | { readonly type: "tool_execution_start"; readonly toolName: string }
  | { readonly type: "message_update" };

export type PiSdkSession = {
  subscribe(listener: (event: PiSdkEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void | Promise<void>;
  setActiveToolsByName(names: readonly string[]): void;
  setThinkingLevel(level: string): void;
  dispose(): void;
};

export type PiResourceLoaderOptions = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly settingsManager: PiSettingsManager;
  readonly systemPromptOverride: () => string;
  readonly skillsOverride: () => {
    readonly skills: readonly never[];
    readonly diagnostics: readonly never[];
  };
  readonly agentsFilesOverride: () => { readonly agentsFiles: readonly never[] };
  readonly promptsOverride: () => {
    readonly prompts: readonly never[];
    readonly diagnostics: readonly never[];
  };
  readonly extensionsOverride: () => {
    readonly extensions: readonly never[];
    readonly errors: readonly never[];
    readonly runtime: PiExtensionRuntime;
  };
};

export type PiCreateAgentSessionOptions = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly model: PiModelInfo;
  readonly thinkingLevel: string;
  readonly modelRuntime: PiModelRuntime;
  readonly resourceLoader: PiResourceLoader;
  readonly settingsManager: PiSettingsManager;
  readonly sessionManager: PiSessionManagerHandle;
  readonly noTools: "builtin";
  readonly customTools: readonly PiDefinedTool[];
};

export type PiSessionRuntime = {
  readonly ModelRuntime: {
    create(options: PiModelRuntimeCreateOptions): Promise<PiModelRuntime>;
  };
  createAgentSession(options: PiCreateAgentSessionOptions): Promise<{ session: PiSdkSession }>;
  createExtensionRuntime(): PiExtensionRuntime;
  defineTool(tool: PiDefineToolInput): PiDefinedTool;
  DefaultResourceLoader: new (options: PiResourceLoaderOptions) => PiResourceLoader;
  readonly SessionManager: {
    inMemory(cwd: string, options?: { readonly id?: string }): PiSessionManagerHandle;
  };
  readonly SettingsManager: {
    inMemory(settings: PiCompactionSettings): PiSettingsManager;
  };
};

const defaultPiSessionRuntime = {
  ModelRuntime,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
};

// @ts-expect-error Pi SDK module shapes are wider than PiSessionRuntime; tests inject PiSessionRuntime.
const defaultPiSessionRuntimeTyped: PiSessionRuntime = defaultPiSessionRuntime;
let piSessionRuntime: PiSessionRuntime = defaultPiSessionRuntimeTyped;

export function setPiSessionRuntime(runtime: PiSessionRuntime): void {
  piSessionRuntime = runtime;
}

export function resetPiSessionRuntime(): void {
  piSessionRuntime = defaultPiSessionRuntimeTyped;
}

function toolResultToText(result: JsonValue): string {
  return isJsonString(result) ? result : JSON.stringify(result);
}

type ToolResultSize = {
  readonly resultBytes: number;
  readonly resultCharacters: number;
};

function toolResultSize(result: JsonValue): ToolResultSize {
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

function assistantMessageText(message: PiSdkTurnEndEvent["message"]): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function toCodingAgentTool(
  tool: PiTool,
  executor: AgentRunnerToolExecutor | undefined,
  refreshBeforeTool?: (toolName: string) => Promise<void>,
): ReturnType<PiSessionRuntime["defineTool"]> {
  return piSessionRuntime.defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // SAFETY: Pi defineTool expects its own JSON-schema parameter type; tool.parameters is already that schema from toJsonSchema.
    parameters: tool.parameters as never,
    execute: async (_toolCallId: string, params) => {
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
      try {
        if (refreshBeforeTool) {
          await refreshBeforeTool(tool.name);
        }
        const args = v.parse(jsonObjectSchema, params);
        const result = await executor(args);
        const size = toolResultSize(result);
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: true,
          durationMs: Date.now() - startedAt,
          resultBytes: size.resultBytes,
          resultCharacters: size.resultCharacters,
        });
        const details = asJsonObject(result) ?? {};
        return {
          content: [{ type: "text" as const, text: toolResultToText(result) }],
          details,
        };
      } catch (error) {
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: false,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : "Non-error thrown",
        });
        throw error;
      }
    },
  });
}

type ModelNotFoundContext = {
  piProvider: string;
  piModel: string;
  modelsJsonPath?: string;
};

export async function createPiSessionImpl(params: PiSessionCreateParams): Promise<PiSession> {
  const agentDir = await mkdtemp(join(tmpdir(), "pr-agent-pi-"));
  let structuredState: AuthoritativeStructuredState = params.structuredState;
  const emit = createSanitizedEventSink(params.eventSink);

  try {
    const authPath = join(agentDir, "auth.json");
    const modelRuntime = await piSessionRuntime.ModelRuntime.create({
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
      const context: ModelNotFoundContext = {
        piProvider: params.primary.provider,
        piModel: params.primary.model,
      };
      if (params.cfg.modelsJsonPath) context.modelsJsonPath = params.cfg.modelsJsonPath;
      throw new AppError({
        code: "provider.model_not_found",
        message: params.cfg.modelsJsonPath
          ? `Model not found: ${params.primary.provider}/${params.primary.model} (models.json: ${params.cfg.modelsJsonPath})`
          : `Model not found: ${params.primary.provider}/${params.primary.model}`,
        context,
      });
    }
    bindPromptCacheRetention(modelRuntime, params.promptCachePolicy.retention);

    const settingsManager = piSessionRuntime.SettingsManager.inMemory({
      compaction: {
        enabled: params.compactionPolicy.enabled,
      },
    });
    const resourceLoader = new piSessionRuntime.DefaultResourceLoader({
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
        runtime: piSessionRuntime.createExtensionRuntime(),
      }),
    });
    await resourceLoader.reload();
    const initialThinking = resolveThinkingLevel({
      policy: params.thinkingPolicy,
      phase: "synthesis",
    });
    const sessionCacheId = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment(params.role, params.primary, params.specialistId),
    );
    const cwd = params.cwd ?? process.cwd();
    const { session } = await piSessionRuntime.createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: initialThinking,
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: piSessionRuntime.SessionManager.inMemory(cwd, { id: sessionCacheId }),
      noTools: "builtin",
      customTools: params.tools.map((tool) =>
        toCodingAgentTool(tool, params.executors[tool.name], params.refreshBeforeTool),
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
        const idleTimeoutEnabled = idleTimeoutMs != null && idleTimeoutMs > 0;
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
    };

    return piSession;
  } catch (error) {
    await rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
