import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { createAskPathGate } from "../ask/askSafety.js";
import { buildLocalWorkspaceTools } from "../tools/localWorkspaceTools.js";
import { createRefreshableToolExecutors } from "../tools/refreshableGithubTools.js";
import { descriptionSystemPrompt } from "./descriptionSystemPrompt.js";
import { buildDescriptionUserContent } from "./descriptionUserMessage.js";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
  type SubmitDescriptionState,
} from "./submitDescriptionTool.js";
import type { OperationIntentContext } from "../../agentWork/withOperationIntent.js";

const TOKEN_REFRESH_TOOL = "getPullRequest";

export type DescriptionRunSetup = {
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  readonly submitState: SubmitDescriptionState;
  readonly getToken: () => string;
  readonly refreshBeforeTool: (toolName: string) => Promise<void>;
};

export function shouldContinueDescriptionRun(
  setup: Pick<DescriptionRunSetup, "submitState">,
): boolean {
  return !setup.submitState.published && !setup.submitState.publishSuperseded;
}

export function buildDescriptionRunSetup(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  workspace: LocalPrWorkspace;
  shouldAbortPublish?: () => Promise<boolean>;
  recordPublishStep?: (detail?: Record<string, unknown>) => Promise<void>;
  operationIntent?: OperationIntentContext;
  refreshInstallationToken?: () => Promise<{
    token: string;
    expiresAtTs: number;
  }>;
}): DescriptionRunSetup {
  const {
    cfg,
    token,
    tokenExpiresAtTs,
    owner,
    repo,
    prNumber,
    headSha,
    userSupplement,
    workspace,
  } = params;

  const pathGate = createAskPathGate();
  const submitState = createSubmitDescriptionState();

  const refreshableGh = createRefreshableToolExecutors({
    initialToken: token,
    tokenExpiresAtTs,
    tokenTtlMs: params.tokenTtlMs,
    refreshInstallationToken: params.refreshInstallationToken,
    githubToolNames: new Set([TOKEN_REFRESH_TOOL]),
    build: (_activeToken, _activeExpiresAtTs) =>
      buildLocalWorkspaceTools(workspace, {
        pathGate,
      }),
  });

  const buildSubmit = () =>
    buildSubmitDescriptionTool({
      cfg,
      token: refreshableGh.getToken(),
      tokenExpiresAtTs: refreshableGh.getTokenExpiresAtTs(),
      getTokenExpiresAtTs: () => refreshableGh.getTokenExpiresAtTs(),
      owner,
      repo,
      prNumber,
      state: submitState,
      shouldAbortPublish: params.shouldAbortPublish,
      recordPublishStep: params.recordPublishStep,
      operationIntent: params.operationIntent,
    });

  let submitBundle = buildSubmit();
  const executors = { ...refreshableGh.bundle.executors };
  executors.submitDescription = async (args) => {
    if (submitState.published) {
      return { ok: true, duplicate: true };
    }
    return submitBundle.executor(args);
  };

  const refreshBeforeTool = async (toolName: string) => {
    if (refreshableGh.githubExecutorNames.has(toolName) || toolName === "submitDescription") {
      await refreshableGh.refreshBeforeTool(TOKEN_REFRESH_TOOL);
      if (toolName === "submitDescription") {
        submitBundle = buildSubmit();
      }
    }
  };

  return {
    systemPrompt: descriptionSystemPrompt,
    userContent: buildDescriptionUserContent({
      owner,
      repo,
      prNumber,
      headSha,
      userSupplement,
    }),
    piTools: [...refreshableGh.bundle.piTools, submitBundle.piTool],
    executors,
    submitState,
    getToken: refreshableGh.getToken,
    refreshBeforeTool,
  };
}

export function buildSubmitOnlyDescriptionSessionTools(setup: DescriptionRunSetup): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const submitTool = setup.piTools.find((tool) => tool.name === "submitDescription");
  const submitDescription = setup.executors.submitDescription;
  if (!submitTool || !submitDescription) {
    return { piTools: setup.piTools, executors: setup.executors };
  }
  return {
    piTools: [submitTool],
    executors: { submitDescription },
  };
}
