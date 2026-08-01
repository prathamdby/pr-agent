import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { TriageScope } from "../../agentWork/types.js";
import type { Config } from "../../config.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
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
import { MAX_TRIAGE_FIXES_PER_RUN } from "../../settings/index.js";

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

/**
 * Finalize keeps every triage workspace tool except search, plus submitTriage.
 * Names come from the live setup tool list so renames cannot silently drop commitFix.
 */
const TRIAGE_FINALIZE_EXCLUDED = new Set(["searchWorkspace"]);

export function buildSubmitOnlyTriageSessionTools(setup: TriageRunSetup): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const keepNames = new Set(
    setup.piTools.map((tool) => tool.name).filter((name) => !TRIAGE_FINALIZE_EXCLUDED.has(name)),
  );
  keepNames.add("submitTriage");
  const piTools = setup.piTools.filter((tool) => keepNames.has(tool.name));
  const executors = Object.fromEntries(
    Object.entries(setup.executors).filter(([name]) => keepNames.has(name)),
  );
  if (piTools.length === 0 || !executors.submitTriage || !executors.commitFix) {
    return { piTools: setup.piTools, executors: setup.executors };
  }
  return { piTools, executors };
}
