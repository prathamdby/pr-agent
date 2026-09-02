import { errorLogFields, toAppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import type { SpecialistId, SpecialistOutcome } from "./orchestratorTypes.js";

export async function pumpSpecialistCompletions(args: {
  readonly pending: ReadonlyMap<SpecialistId, Promise<SpecialistOutcome>>;
  readonly onOutcome: (outcome: SpecialistOutcome) => Promise<void>;
  readonly shouldContinue: () => boolean;
  /** Optional poll while waiting: races each wait against intervalMs. */
  readonly watch?: {
    readonly intervalMs: number;
    readonly onPoll: () => Promise<void>;
  };
}): Promise<SpecialistOutcome[]> {
  const completed: SpecialistOutcome[] = [];
  let notifyCompletion: (() => void) | undefined;

  for (const [specialist, promise] of args.pending.entries()) {
    void promise
      .then((outcome) => {
        completed.push(outcome);
        const notify = notifyCompletion;
        notifyCompletion = undefined;
        notify?.();
      })
      .catch((error: unknown) => {
        const appError = toAppError(error, {
          code: "review.specialist_promise_rejected",
        });
        logWarn("review_specialist_promise_rejected", {
          specialist,
          ...errorLogFields(appError),
        });
        completed.push({
          kind: "error",
          specialist,
          error: appError,
          durationMs: 0,
        });
        const notify = notifyCompletion;
        notifyCompletion = undefined;
        notify?.();
      });
  }

  async function takeCompleted(): Promise<SpecialistOutcome> {
    while (true) {
      const outcome = completed.shift();
      if (outcome !== undefined) return outcome;
      const timedOut = await new Promise<boolean>((resolve) => {
        let settled = false;
        const timer =
          args.watch == null
            ? undefined
            : setTimeout(() => {
                if (!settled) {
                  settled = true;
                  resolve(true);
                }
              }, args.watch.intervalMs);
        notifyCompletion = () => {
          if (!settled) {
            settled = true;
            if (timer != null) clearTimeout(timer);
            resolve(false);
          }
        };
      });
      if (!timedOut) continue;
      try {
        await args.watch?.onPoll();
      } catch (error) {
        const appError = toAppError(error, {
          code: "review.orchestrator_gate_poll_failed",
        });
        logWarn("review_specialist_gate_poll_failed", {
          ...errorLogFields(appError),
        });
      }
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
