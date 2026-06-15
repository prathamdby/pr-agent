export type StructuredAgentPhase<TName extends string> = {
  readonly name: TName;
  readonly run: () => Promise<void>;
};

export async function runStructuredAgentLoop<TName extends string>(params: {
  readonly phases: readonly StructuredAgentPhase<TName>[];
  readonly shouldContinue: () => boolean;
  readonly onPhaseEnter?: (phase: TName) => void;
}): Promise<void> {
  for (const phase of params.phases) {
    if (!params.shouldContinue()) break;
    params.onPhaseEnter?.(phase.name);
    await phase.run();
  }
}

export async function runValidationRepairLoop(params: {
  readonly rounds: number;
  readonly shouldContinue: () => boolean;
  readonly getValidationError: () => string | null | undefined;
  readonly clearValidationError: () => void;
  readonly repair: (validationError: string) => Promise<void>;
}): Promise<void> {
  for (let repair = 0; repair < params.rounds && params.shouldContinue(); repair++) {
    const validationError = params.getValidationError();
    if (!validationError) break;
    params.clearValidationError();
    await params.repair(validationError);
  }
}
