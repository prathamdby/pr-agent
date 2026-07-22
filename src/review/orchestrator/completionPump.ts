import { errorLogFields, toAppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import type { SpecialistId, SpecialistOutcome } from "./orchestratorTypes.js";

export async function pumpSpecialistCompletions(args: {
  readonly pending: ReadonlyMap<SpecialistId, Promise<SpecialistOutcome>>;
  readonly onOutcome: (outcome: SpecialistOutcome) => Promise<void>;
  readonly shouldContinue: () => boolean;
}): Promise<SpecialistOutcome[]> {
  const completed: SpecialistOutcome[] = [];
  let notifyCompletion: (() => void) | undefined;

  for (const promise of args.pending.values()) {
    void promise.then((outcome) => {
      completed.push(outcome);
      const notify = notifyCompletion;
      notifyCompletion = undefined;
      notify?.();
    });
  }

  async function takeCompleted(): Promise<SpecialistOutcome> {
    while (true) {
      const outcome = completed.shift();
      if (outcome !== undefined) return outcome;
      await new Promise<void>((resolve) => {
        notifyCompletion = resolve;
      });
    }
  }

  const outcomes: SpecialistOutcome[] = [];
  let consumeOutcomes = true;

  while (outcomes.length < args.pending.size) {
    const outcome = await takeCompleted();
    outcomes.push(outcome);
    if (consumeOutcomes && !args.shouldContinue()) consumeOutcomes = false;
    if (!consumeOutcomes) continue;
    try {
      await args.onOutcome(outcome);
    } catch (error) {
      const appError = toAppError(error, {
        code: "review.orchestrator_outcome_handler_failed",
        context: { specialist: outcome.specialist, outcomeKind: outcome.kind },
      });
      logWarn("review_specialist_outcome_handler_failed", {
        specialist: outcome.specialist,
        outcomeKind: outcome.kind,
        durationMs: outcome.durationMs,
        ...errorLogFields(appError),
      });
    }
  }

  return outcomes;
}
