import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { createAskPathGate } from "../ask/askSafety.js";
import {
  buildLocalWorkspaceTools,
  type LocalWorkspaceExecutors,
} from "../tools/localWorkspaceTools.js";
import { descriptionSystemPrompt } from "./descriptionSystemPrompt.js";
import { buildDescriptionUserContent } from "./descriptionUserMessage.js";
import { resolveDescriptionWritingPolicy } from "./descriptionWritingPolicy.js";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
  type SubmitDescriptionState,
} from "./submitDescriptionTool.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import type { OperationIntentContext } from "../../agentWork/withOperationIntent.js";
import type { JsonObject } from "../../util/jsonValue.js";

export type DescriptionRunExecutors = LocalWorkspaceExecutors & {
  readonly submitDescription: AgentRunnerToolExecutor;
};

export type DescriptionRunSetup = {
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly piTools: PiTool[];
  readonly executors: DescriptionRunExecutors;
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
  recordPublishStep?: (detail?: JsonObject) => Promise<void>;
  operationIntent?: OperationIntentContext;
}): DescriptionRunSetup {
  const { cfg, prSurface, owner, repo, prNumber, headSha, userSupplement, workspace } = params;

  const pathGate = createAskPathGate();
  const submitState = createSubmitDescriptionState();
  const policy = resolveDescriptionWritingPolicy(workspace.stats);
  const knownPaths = new Set(workspace.changedFiles.map((file) => file.path));

  const localTools = buildLocalWorkspaceTools(workspace, {
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
  const executors: DescriptionRunExecutors = {
    ...localTools.executors,
    submitDescription: async (args: JsonObject) => {
      if (submitState.published) {
        return { ok: true, duplicate: true };
      }
      return submitBundle.executor(args);
    },
  };

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
      fileCount: workspace.stats.fileCount,
      totalChanges: workspace.stats.totalChanges,
      truncated: workspace.stats.truncated,
      userSupplement,
    }),
    piTools: [...localTools.piTools, submitBundle.piTool],
    executors,
    submitState,
    refreshBeforeTool,
  };
}
