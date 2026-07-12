import { getModel } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { TextContent, Tool as PiTool } from "@earendil-works/pi-ai";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentRunnerProvider,
  AgentRunnerSendOptions,
  AgentRunnerToolExecutor,
} from "../interface.js";
import { safeEmitToolCallMetric, type OnAgentToolCallMetric } from "../sessionMetrics.js";
import {
  exactUsageFromProviderUsage,
  mergeExactUsage,
  promptMetadataFromText,
} from "../usageMetadata.js";

function toolResultToText(result: unknown): string {
  if (result === undefined) return "";
  return typeof result === "string" ? result : JSON.stringify(result);
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
  refreshBeforeTool: ((toolName: string) => Promise<void>) | undefined,
  onToolCallMetric: OnAgentToolCallMetric | undefined,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      if (!executor) {
        safeEmitToolCallMetric(onToolCallMetric, {
          kind: "tool_call",
          name: tool.name,
          ok: false,
        });
        throw new Error(`No executor registered for tool ${tool.name}`);
      }
      try {
        if (refreshBeforeTool) {
          await refreshBeforeTool(tool.name);
        }
        const result = await executor(params);
        const text = toolResultToText(result);
        const size = {
          resultCharacters: text.length,
          resultBytes: Buffer.byteLength(text, "utf8"),
        };
        const payload = {
          content: [{ type: "text" as const, text }],
          details: result && typeof result === "object" ? (result as Record<string, unknown>) : {},
        };
        safeEmitToolCallMetric(onToolCallMetric, {
          kind: "tool_call",
          name: tool.name,
          ok: true,
          resultBytes: size.resultBytes,
          resultCharacters: size.resultCharacters,
        });
        return payload;
      } catch (error) {
        safeEmitToolCallMetric(onToolCallMetric, {
          kind: "tool_call",
          name: tool.name,
          ok: false,
        });
        throw error;
      }
    },
  });
}

export const piAgentRunnerProvider: AgentRunnerProvider = {
  async createSession({
    cfg,
    cwd,
    systemPrompt,
    tools,
    executors,
    refreshBeforeTool,
    signal,
    onToolCallMetric,
  }) {
    signal?.throwIfAborted();
    const agentDir = await mkdtemp(join(tmpdir(), "pr-agent-pi-"));
    const authPath = join(agentDir, "auth.json");
    const authStorage = AuthStorage.create(authPath);
    for (const [provider, key] of Object.entries(cfg.modelProviderKeys)) {
      if (key.trim()) authStorage.setRuntimeApiKey(provider, key.trim());
    }
    await chmod(authPath, 0o600).catch(() => undefined);
    const modelRegistryFactory = ModelRegistry as unknown as {
      inMemory?: typeof ModelRegistry.create;
      create: typeof ModelRegistry.create;
    };
    const modelRegistry = modelRegistryFactory.inMemory
      ? modelRegistryFactory.inMemory(authStorage)
      : modelRegistryFactory.create(authStorage, join(agentDir, "models.json"));
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
    const model = getModel(cfg.piProvider, cfg.piModel as never);
    const allToolNames = tools.map((tool) => tool.name);
    const { session } = await createAgentSession({
      cwd: cwd ?? process.cwd(),
      agentDir,
      model,
      thinkingLevel: "off",
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd ?? process.cwd()),
      noTools: "builtin",
      customTools: tools.map((tool) =>
        toCodingAgentTool(tool, executors[tool.name], refreshBeforeTool, onToolCallMetric),
      ),
    });
    const sessionAbortController = new AbortController();
    const forwardSessionAbort = () => sessionAbortController.abort(signal?.reason);
    signal?.addEventListener("abort", forwardSessionAbort, { once: true });
    if (signal?.aborted) forwardSessionAbort();

    return {
      async send(prompt: string, opts?: AgentRunnerSendOptions) {
        const sendSignal = opts?.signal
          ? AbortSignal.any([sessionAbortController.signal, opts.signal])
          : sessionAbortController.signal;
        const abortProviderSession = () => {
          void session.abort();
        };
        sendSignal.addEventListener("abort", abortProviderSession, { once: true });
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
          rejectOnIdle?.(new Error(`Provider prompt timeout: no activity for ${idleTimeoutMs}ms`));
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
          if (sendSignal.aborted) abortProviderSession();
          sendSignal.throwIfAborted();
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
          sendSignal.throwIfAborted();
          const promptMeta = promptMetadataFromText(prompt);
          return aggregatedUsage
            ? { text: finalText, prompt: promptMeta, usage: aggregatedUsage }
            : { text: finalText, prompt: promptMeta };
        } finally {
          if (idleCheckHandle) clearInterval(idleCheckHandle);
          unsubscribe();
          sendSignal.removeEventListener("abort", abortProviderSession);
        }
      },
      async cancel() {
        sessionAbortController.abort();
        await session.abort();
      },
      // customTools are fixed at session creation; restrictToTools only toggles active names.
      restrictToTools(nextTools, _executors) {
        session.setActiveToolsByName(nextTools.map((tool) => tool.name));
      },
      restoreTools() {
        session.setActiveToolsByName(allToolNames);
      },
      async dispose() {
        sessionAbortController.abort();
        signal?.removeEventListener("abort", forwardSessionAbort);
        await rm(agentDir, { recursive: true, force: true });
      },
    };
  },
};
