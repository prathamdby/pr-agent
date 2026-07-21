import { logWarn } from "../../evlog.js";
import { AppError, errorLogFields, isAppError } from "../../errors/appError.js";
import type { SpecialistId, SpecialistOutcome } from "./specialistReport.js";

type TaggedOutcome = {
  readonly specialist: SpecialistId;
  readonly outcome: SpecialistOutcome;
};

function shouldKeepConsuming(args: {
  shouldContinue: () => boolean;
  signal?: AbortSignal;
}): boolean {
  if (!args.shouldContinue()) return false;
  if (args.signal != null && args.signal.aborted) return false;
  return true;
}

function rejectedSpecialistOutcome(
  specialist: SpecialistId,
  error: unknown,
): Extract<SpecialistOutcome, { kind: "error" }> {
  return {
    specialist,
    kind: "error",
    error: isAppError(error)
      ? error
      : new AppError({
          code: "review.specialist_promise_rejected",
          message: error instanceof Error ? error.message : String(error),
          context: { specialist },
          cause: error,
        }),
    durationMs: 0,
  };
}

/**
 * Invokes `onOutcome` serially in true settlement order while remaining specialists
 * keep running. Each promise is tagged once at dispatch into a FIFO settlement queue
 * so peers that settle during an earlier handler cannot be reordered by Map insertion
 * order on a later `Promise.race`. Never rejects.
 */
export async function pumpSpecialistCompletions(args: {
  pending: ReadonlyMap<SpecialistId, Promise<SpecialistOutcome>>;
  onOutcome: (outcome: SpecialistOutcome) => Promise<void>;
  shouldContinue: () => boolean;
  signal?: AbortSignal;
}): Promise<SpecialistOutcome[]> {
  const total = args.pending.size;
  if (total === 0) return [];

  const settlementQueue: TaggedOutcome[] = [];
  let remainingSettlements = total;
  let wake: (() => void) | null = null;

  const wakeWaiter = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  for (const [specialist, promise] of args.pending) {
    void promise.then(
      (outcome) => {
        settlementQueue.push({ specialist, outcome });
        remainingSettlements -= 1;
        wakeWaiter();
      },
      (error: unknown) => {
        settlementQueue.push({
          specialist,
          outcome: rejectedSpecialistOutcome(specialist, error),
        });
        remainingSettlements -= 1;
        wakeWaiter();
      },
    );
  }

  const collected: SpecialistOutcome[] = [];
  let stopConsuming = false;

  while (collected.length < total) {
    if (settlementQueue.length === 0) {
      if (remainingSettlements === 0) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (settlementQueue.length > 0 || remainingSettlements === 0) {
          wakeWaiter();
        }
      });
      continue;
    }

    const tagged = settlementQueue.shift();
    if (tagged == null) continue;

    collected.push(tagged.outcome);

    if (stopConsuming) continue;
    if (!shouldKeepConsuming(args)) {
      stopConsuming = true;
      continue;
    }

    try {
      await args.onOutcome(tagged.outcome);
    } catch (error) {
      logWarn("review_specialist_outcome_handler_failed", {
        specialist: tagged.specialist,
        kind: tagged.outcome.kind,
        message: error instanceof Error ? error.message : String(error),
        ...errorLogFields(error),
      });
    }

    if (!shouldKeepConsuming(args)) {
      stopConsuming = true;
    }
  }

  return collected;
}
