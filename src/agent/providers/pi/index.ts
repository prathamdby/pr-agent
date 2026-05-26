import { getModel } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRunnerProvider, AgentRunnerToolExecutor } from "../interface.js";

function toolResultToText(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function toCodingAgentTool(
  tool: PiTool,
  executor: AgentRunnerToolExecutor | undefined,
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
      const result = await executor(params);
      return {
        content: [{ type: "text" as const, text: toolResultToText(result) }],
        details: result && typeof result === "object" ? (result as Record<string, unknown>) : {},
      };
    },
  });
}

export const piAgentRunnerProvider: AgentRunnerProvider = {
  async createSession({ cfg, cwd, systemPrompt, tools, executors }) {
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
    });
    await resourceLoader.reload();
    const model = getModel(cfg.piProvider, cfg.piModel as never);
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
      tools: [],
      customTools: tools.map((tool) => toCodingAgentTool(tool, executors[tool.name])),
    });

    return {
      async send(prompt: string) {
        const chunks: string[] = [];
        const unsubscribe = session.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            chunks.push(event.assistantMessageEvent.delta);
          }
        });
        try {
          await session.prompt(prompt);
          return { text: chunks.join("") };
        } finally {
          unsubscribe();
        }
      },
      async dispose() {
        await rm(agentDir, { recursive: true, force: true });
      },
    };
  },
};
