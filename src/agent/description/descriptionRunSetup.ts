import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentToolCallContext, AgentRunnerToolExecutor } from "../providers/interface.js";
import type { Config } from "../../config.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { createAskPathGate } from "../ask/askSafety.js";
import { buildWorkspaceTools } from "../tools/workspaceToolset.js";
import { descriptionSystemPrompt } from "./descriptionSystemPrompt.js";
import { buildDescriptionUserContent } from "./descriptionUserMessage.js";
import { resolveDescriptionWritingPolicy } from "./descriptionWritingPolicy.js";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
  type SubmitDescriptionState,
} from "./submitDescriptionTool.js";
import type { OperationIntentContext } from "../../agentWork/publishOnce.js";

export type DescriptionRunSetup = {
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly piTools: PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly submitState: SubmitDescriptionState;
  readonly refreshBeforeTool: (toolName: string) => Promise<void>;
};

export function shouldContinueDescriptionRun(
  setup: Pick<DescriptionRunSetup, "submitState">,
): boolean {
  return !setup.submitState.published && !setup.submitState.publishSuperseded;
}

export function buildDescriptionRunSetup(params: {
  cfg: Config;
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  workspace: LocalPrWorkspace;
  shouldAbortPublish?: () => Promise<boolean>;
  recordPublishStep?: (detail?: Record<string, unknown>) => Promise<void>;
  operationIntent?: OperationIntentContext;
}): DescriptionRunSetup {
  const { cfg, prSurface, owner, repo, prNumber, headSha, userSupplement, workspace } = params;

  const pathGate = createAskPathGate();
  const submitState = createSubmitDescriptionState();
  const policy = resolveDescriptionWritingPolicy(workspace.reader.stats);
  const knownPaths = new Set(workspace.reader.changedFiles.map((file) => file.path));

  const localTools = buildWorkspaceTools(workspace.reader, {
    pathGate,
  });

  const buildSubmit = () =>
    buildSubmitDescriptionTool({
      cfg,
      prSurface,
      owner,
      repo,
      prNumber,
      state: submitState,
      mapMode: policy.mapMode,
      knownPaths,
      shouldAbortPublish: params.shouldAbortPublish,
      recordPublishStep: params.recordPublishStep,
      operationIntent: params.operationIntent,
    });

  let submitBundle = buildSubmit();
  const executors = { ...localTools.executors };
  executors.submitDescription = async (args, ctx?: AgentToolCallContext) =>
    submitBundle.executor(args, ctx);

  const refreshBeforeTool = async (toolName: string) => {
    if (toolName === "submitDescription") {
      submitBundle = buildSubmit();
    }
  };

  return {
    systemPrompt: descriptionSystemPrompt,
    userContent: buildDescriptionUserContent({
      owner,
      repo,
      prNumber,
      headSha,
      policy,
      fileCount: workspace.reader.stats.fileCount,
      totalChanges: workspace.reader.stats.totalChanges,
      truncated: workspace.reader.stats.truncated,
      userSupplement,
    }),
    piTools: [...localTools.piTools, submitBundle.piTool],
    executors,
    submitState,
    refreshBeforeTool,
  };
}
