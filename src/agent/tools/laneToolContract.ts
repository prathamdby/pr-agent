import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { AppError } from "../../errors/appError.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";

export const WORKSPACE_READ_TOOL_NAMES = [
  "listChangedFiles",
  "readWorkspaceFile",
  "searchWorkspace",
  "getWorkspaceDiff",
] as const;

export const CONTEXT7_TOOL_NAMES = ["resolveLibraryId", "getLibraryDocs"] as const;

export type LaneToolCatalog = {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
};

export function formatLaneToolContract(toolNames: readonly string[]): string {
  const listed = toolNames.map((name) => `\`${name}\``).join(", ");
  const lines = ["## Tools", `Available tools: ${listed}.`];
  if (toolNames.includes("resolveLibraryId") && toolNames.includes("getLibraryDocs")) {
    lines.push(
      "For library behaviour or upstream API questions, call `resolveLibraryId` then `getLibraryDocs` first.",
    );
  }
  return lines.join("\n");
}

export function formatUnknownToolError(requested: string, validNames: readonly string[]): string {
  return `No executor registered for tool ${requested}. Valid tools: ${validNames.join(", ")}.`;
}

export function assembleNamedTools(
  names: readonly string[],
  catalogs: readonly LaneToolCatalog[],
): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
} {
  const piByName = new Map<string, PiTool>();
  const execByName: Record<string, AgentRunnerToolExecutor> = {};
  for (const catalog of catalogs) {
    for (const tool of catalog.piTools) {
      piByName.set(tool.name, tool);
    }
    Object.assign(execByName, catalog.executors);
  }

  const piTools: PiTool[] = [];
  const executors: Record<string, AgentRunnerToolExecutor> = {};
  for (const name of names) {
    const tool = piByName.get(name);
    const executor = execByName[name];
    if (!tool || !executor) {
      throw new AppError({
        code: "provider.missing_tool_executor",
        message: formatUnknownToolError(name, names),
        context: { toolName: name, validTools: names },
      });
    }
    piTools.push(tool);
    executors[name] = executor;
  }
  return { piTools, executors };
}
