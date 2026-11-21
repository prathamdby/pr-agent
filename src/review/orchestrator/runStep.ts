export type SynthesisStep =
  | "judge"
  | "unjudged"
  | "synthesis"
  | "repair_summary"
  | "recover_summary"
  | "publish";

export type SynthesisStepFacts = {
  readonly pendingJudgment: boolean;
  readonly orchestratorAvailable: boolean;
  readonly summaryPublished: boolean;
  readonly synthesisSent: boolean;
  readonly repairsUsed: number;
  readonly repairLimit: number;
  readonly recoveriesUsed: number;
  readonly recoveryLimit: number;
};

export function nextSynthesisStep(facts: SynthesisStepFacts) {
  if (facts.pendingJudgment)
    return ((pinnedReturn: SynthesisStep) => pinnedReturn)(
      facts.orchestratorAvailable ? "judge" : "unjudged",
    );
  if (facts.summaryPublished || !facts.orchestratorAvailable)
    return ((pinnedReturn: SynthesisStep) => pinnedReturn)("publish");
  if (!facts.synthesisSent) return ((pinnedReturn: SynthesisStep) => pinnedReturn)("synthesis");
  if (facts.repairsUsed < facts.repairLimit)
    return ((pinnedReturn: SynthesisStep) => pinnedReturn)("repair_summary");
  if (facts.recoveriesUsed < facts.recoveryLimit)
    return ((pinnedReturn: SynthesisStep) => pinnedReturn)("recover_summary");
  return ((pinnedReturn: SynthesisStep) => pinnedReturn)("publish");
}
