import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import { verificationSystemPrompt } from "./verificationPrompt.js";
import { buildVerificationUserContent } from "./verificationUserMessage.js";
import { buildVerificationWorkspaceTools } from "./verificationWorkspaceTools.js";
import {
  buildSubmitVerificationTool,
  createSubmitVerificationState,
  type SubmitVerificationState,
} from "./submitVerificationTool.js";

export type VerificationRunSetup = {
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  readonly submitState: SubmitVerificationState;
};

export function shouldContinueVerificationRun(
  setup: Pick<VerificationRunSetup, "submitState">,
): boolean {
  return !setup.submitState.submitted;
}

export function buildVerificationRunSetup(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly rootDir: string;
  readonly inventory: readonly BotFindingThread[];
  readonly pushedCommits: readonly { readonly sha: string; readonly subject: string }[];
}): VerificationRunSetup {
  const submitState = createSubmitVerificationState();
  const workspaceTools = buildVerificationWorkspaceTools({
    cfg: params.cfg,
    rootDir: params.rootDir,
  });
  const submitTool = buildSubmitVerificationTool({
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    inventory: params.inventory,
    pushedShas: params.pushedCommits.map((commit) => commit.sha),
    submitState,
  });

  return {
    systemPrompt: verificationSystemPrompt,
    userContent: buildVerificationUserContent({
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      pushedCommits: params.pushedCommits,
      threads: params.inventory,
    }),
    piTools: [...workspaceTools.piTools, submitTool.piTool],
    executors: { ...workspaceTools.executors, submitVerification: submitTool.executor },
    submitState,
  };
}

export function buildSubmitOnlyVerificationSessionTools(setup: VerificationRunSetup): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const submitTool = setup.piTools.find((tool) => tool.name === "submitVerification");
  const submitVerification = setup.executors.submitVerification;
  if (!submitTool || !submitVerification) {
    return { piTools: setup.piTools, executors: setup.executors };
  }
  return { piTools: [submitTool], executors: { submitVerification } };
}
