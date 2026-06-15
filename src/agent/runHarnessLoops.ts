import type { Tool as PiTool } from "@earendil-works/pi-ai";

export function pickSubmitOnlyBundle(
  setup: {
    readonly piTools: readonly PiTool[];
    readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  },
  toolName: string,
): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const submitTool = setup.piTools.find((tool) => tool.name === toolName);
  const submitExecutor = setup.executors[toolName];
  if (!submitTool || !submitExecutor) {
    return { piTools: [...setup.piTools], executors: setup.executors };
  }
  return { piTools: [submitTool], executors: { [toolName]: submitExecutor } };
}

export async function runValidationRepairLoop(params: {
  readonly maxRounds: number;
  readonly shouldContinue: () => boolean;
  readonly getValidationError: () => string | null;
  readonly clearValidationError: () => void;
  readonly sendRepair: (prompt: string) => Promise<string>;
  readonly buildRepairPrompt: (validationError: string) => string;
  readonly onEnter?: () => void;
  readonly shouldStopAfterRepair?: () => boolean;
}): Promise<string> {
  params.onEnter?.();
  let lastText = "";
  for (let repair = 0; repair < params.maxRounds && params.shouldContinue(); repair++) {
    const validationError = params.getValidationError();
    if (!validationError) break;
    params.clearValidationError();
    lastText = await params.sendRepair(params.buildRepairPrompt(validationError));
    if (params.shouldStopAfterRepair?.()) break;
  }
  return lastText;
}

export async function runSubmitOnlyNudgeLoop(params: {
  readonly maxRounds: number;
  readonly shouldContinue: () => boolean;
  readonly shouldBreakEarly?: () => boolean;
  readonly nudgeText: string;
  readonly sendNudge: (prompt: string) => Promise<string>;
  readonly runValidationRepair: () => Promise<string>;
}): Promise<string> {
  let lastText = "";
  for (let nudge = 0; nudge < params.maxRounds && params.shouldContinue(); nudge++) {
    if (params.shouldBreakEarly?.()) break;
    lastText = await params.sendNudge(params.nudgeText);
    const repaired = await params.runValidationRepair();
    if (repaired) lastText = repaired;
  }
  return lastText;
}
