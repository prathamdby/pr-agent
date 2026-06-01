import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/localPrWorkspace.js";
import { createAskPathGate } from "./askSafety.js";
import { buildGithubTools } from "./githubTools.js";
import { buildLocalWorkspaceTools } from "./localWorkspaceTools.js";
import { createRefreshableToolExecutors } from "./providers/cursor/refreshableGithubTools.js";
import { descriptionSystemPrompt } from "./descriptionSystemPrompt.js";
import { buildDescriptionUserContent } from "./descriptionUserMessage.js";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
  type SubmitDescriptionState,
} from "./submitDescriptionTool.js";

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
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  workspace?: LocalPrWorkspace;
  shouldAbortPublish?: () => Promise<boolean>;
  recordPublishStep?: (detail?: Record<string, unknown>) => Promise<void>;
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
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
    refreshInstallationToken: params.refreshInstallationToken,
    githubToolNames: new Set([TOKEN_REFRESH_TOOL]),
    build: (activeToken) => {
      if (workspace) {
        return buildLocalWorkspaceTools(workspace, cfg, { pathGate });
      }
      return buildGithubTools(activeToken, {
        maxPrFilesListed: cfg.maxPrFilesListed,
        maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
      });
    },
  });

  const buildSubmit = () =>
    buildSubmitDescriptionTool({
      cfg,
      token: refreshableGh.getToken(),
      owner,
      repo,
      prNumber,
      state: submitState,
      shouldAbortPublish: params.shouldAbortPublish,
      recordPublishStep: params.recordPublishStep,
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
