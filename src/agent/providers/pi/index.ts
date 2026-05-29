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

function toolResultToText(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
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
        throw new Error(`No executor registered for tool ${tool.name}`);
      }
      if (refreshBeforeTool) {
        await refreshBeforeTool(tool.name);
      }
      const result = await executor(params);
      return {
        content: [{ type: "text" as const, text: toolResultToText(result) }],
        details: result && typeof result === "object" ? (result as Record<string, unknown>) : {},
      };
    },
  });
}

export const piAgentRunnerProvider: AgentRunnerProvider = {
  async createSession({ cfg, cwd, systemPrompt, tools, executors, refreshBeforeTool }) {
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
        toCodingAgentTool(tool, executors[tool.name], refreshBeforeTool),
      ),
    });

    return {
      async send(prompt: string, opts?: AgentRunnerSendOptions) {
        let sessionToolTurnCount = 0;
        let finalText = "";
        const unsubscribe = session.subscribe((event) => {
          if (event.type !== "turn_end") return;
          sessionToolTurnCount += 1;
          // A tool-free turn is the terminal turn of prompt(); capture only that answer text.
          if (event.toolResults.length === 0) {
            finalText = assistantMessageText(event.message);
          } else if (opts?.maxToolRounds != null && sessionToolTurnCount >= opts.maxToolRounds) {
            void session.abort();
          }
        });
        try {
          await session.prompt(prompt);
          return { text: finalText };
        } finally {
          unsubscribe();
        }
      },
      // customTools are fixed at session creation; restrictToTools only toggles active names.
      restrictToTools(nextTools, _executors) {
        session.setActiveToolsByName(nextTools.map((tool) => tool.name));
      },
      restoreTools() {
        session.setActiveToolsByName(allToolNames);
      },
      async dispose() {
        await rm(agentDir, { recursive: true, force: true });
      },
    };
  },
};
