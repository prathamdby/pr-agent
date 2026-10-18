import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { TriageScope } from "../../agentWork/types.ts";
import { type Config, MAX_TRIAGE_FIXES_PER_RUN } from "../../settings/index.ts";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.ts";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.ts";
import { triageSystemPrompt, buildTriageUserContent } from "../../prompts/triage/prompt.ts";
import {
  buildTriageWorkspaceTools,
  createTriageWorkspaceToolState,
  type TriageWorkspaceToolState,
} from "./triageWorkspaceTools.ts";
import {
  buildSubmitTriageTool,
  createSubmitTriageState,
  type SubmitTriageState,
} from "./submitTriageTool.ts";

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
      maxFixesPerRun: MAX_TRIAGE_FIXES_PER_RUN,
      threads: params.inventory,
      scope: params.scope,
    }),
    piTools: [...workspaceTools.piTools, submitTool.piTool],
    executors: { ...workspaceTools.executors, submitTriage: submitTool.executor },
    submitState,
    workspaceState,
  };
}
