import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { TriageScope } from "../agentWork/types.js";
import type { Config } from "../config.js";
import type { BotFindingThread } from "../review/reviewPriorFeedback.js";
import type { WritablePrCheckout } from "../prWorkspace/writablePrCheckout.js";
import { triageSystemPrompt } from "./triagePrompt.js";
import { buildTriageUserContent } from "./triageUserMessage.js";
import {
  buildTriageWorkspaceTools,
  createTriageWorkspaceToolState,
  type TriageWorkspaceToolState,
} from "./triageWorkspaceTools.js";
import {
  buildSubmitTriageTool,
  createSubmitTriageState,
  type SubmitTriageState,
} from "./submitTriageTool.js";

export type TriageRunSetup = {
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  readonly submitState: SubmitTriageState;
  readonly workspaceState: TriageWorkspaceToolState;
};

export function shouldContinueTriageRun(setup: Pick<TriageRunSetup, "submitState">): boolean {
  return !setup.submitState.submitted;
}

export function buildTriageRunSetup(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkout: WritablePrCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly scope?: TriageScope;
}): TriageRunSetup {
  const workspaceState = createTriageWorkspaceToolState();
  const submitState = createSubmitTriageState();
  const workspaceTools = buildTriageWorkspaceTools({
    cfg: params.cfg,
    checkout: params.checkout,
    inventory: params.inventory,
    state: workspaceState,
  });
  const submitTool = buildSubmitTriageTool({
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    inventory: params.inventory,
    checkout: params.checkout,
    workspaceState,
    submitState,
  });

  return {
    systemPrompt: triageSystemPrompt,
    userContent: buildTriageUserContent({
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      maxFixesPerRun: params.cfg.maxTriageFixesPerRun,
      threads: params.inventory,
      scope: params.scope,
    }),
    piTools: [...workspaceTools.piTools, submitTool.piTool],
    executors: { ...workspaceTools.executors, submitTriage: submitTool.executor },
    submitState,
    workspaceState,
  };
}

export function buildSubmitOnlyTriageSessionTools(setup: TriageRunSetup): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const submitTool = setup.piTools.find((tool) => tool.name === "submitTriage");
  const submitTriage = setup.executors.submitTriage;
  if (!submitTool || !submitTriage) return { piTools: setup.piTools, executors: setup.executors };
  return { piTools: [submitTool], executors: { submitTriage } };
}
