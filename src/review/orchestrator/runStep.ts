/**
 * Orchestration step selection as data. `nextStep` reads only the last executed
 * step and facts about the run; it performs no I/O, so every route through
 * recon, specialists, synthesis, and deterministic fallback is a table case.
 */
export type ReviewStep =
  | { readonly kind: "recon" }
  | { readonly kind: "repair_brief" }
  | { readonly kind: "stop_on_host_abort" }
  | { readonly kind: "dispatch_specialists" }
  | { readonly kind: "terminal_tick" }
  | { readonly kind: "finalize_deadline" }
  | { readonly kind: "failure_notice" }
  | { readonly kind: "synthesis" }
  | { readonly kind: "repair_summary" }
  | { readonly kind: "recover_summary" }
  | { readonly kind: "settle_summary" }
  | { readonly kind: "deterministic_summary" }
  | { readonly kind: "done" };

export type ReviewStepKind = ReviewStep["kind"];

export type ReviewStepFacts = {
  /** A model session was created for this run. */
  readonly hasSession: boolean;
  readonly sessionRetired: boolean;
  readonly briefSubmitted: boolean;
  readonly hostAborted: boolean;
  readonly lifecycle: "running" | "stopped" | "finalizing" | "complete";
  readonly failedSpecialists: number;
  readonly specialistCount: number;
  readonly summaryPublished: boolean;
  readonly recoveryRoundsRun: number;
  readonly recoveryRoundLimit: number;
};

const STEPS = {
  recon: { kind: "recon" },
  repair_brief: { kind: "repair_brief" },
  stop_on_host_abort: { kind: "stop_on_host_abort" },
  dispatch_specialists: { kind: "dispatch_specialists" },
  terminal_tick: { kind: "terminal_tick" },
  finalize_deadline: { kind: "finalize_deadline" },
  failure_notice: { kind: "failure_notice" },
  synthesis: { kind: "synthesis" },
  repair_summary: { kind: "repair_summary" },
  recover_summary: { kind: "recover_summary" },
  settle_summary: { kind: "settle_summary" },
  deterministic_summary: { kind: "deterministic_summary" },
  done: { kind: "done" },
} as const satisfies { readonly [K in ReviewStepKind]: Extract<ReviewStep, { kind: K }> };

const step = <K extends ReviewStepKind>(kind: K) => STEPS[kind];

function afterBrief(facts: ReviewStepFacts): ReviewStep {
  if (facts.hostAborted && facts.lifecycle === "running") return step("stop_on_host_abort");
  return afterAbortCheck(facts);
}

function afterAbortCheck(facts: ReviewStepFacts): ReviewStep {
  return facts.lifecycle !== "stopped" ? step("dispatch_specialists") : finish(facts);
}

function finish(facts: ReviewStepFacts): ReviewStep {
  if (facts.lifecycle === "stopped") return step("terminal_tick");
  if (facts.lifecycle === "finalizing") return step("finalize_deadline");
  if (facts.failedSpecialists === facts.specialistCount) return step("failure_notice");
  if (!facts.sessionRetired && facts.hasSession) return step("synthesis");
  return step("deterministic_summary");
}

function summaryLoopOpen(facts: ReviewStepFacts): boolean {
  return !facts.summaryPublished && !facts.sessionRetired && facts.lifecycle === "running";
}

function recoverOrSettle(facts: ReviewStepFacts): ReviewStep {
  return summaryLoopOpen(facts) && facts.recoveryRoundsRun < facts.recoveryRoundLimit
    ? step("recover_summary")
    : step("settle_summary");
}

export function nextStep(last: ReviewStepKind | null, facts: ReviewStepFacts): ReviewStep {
  switch (last) {
    case null:
      return facts.hasSession ? step("recon") : briefOrAfter(facts);
    case "recon":
      return briefOrAfter(facts);
    case "repair_brief":
      return afterBrief(facts);
    case "stop_on_host_abort":
      return afterAbortCheck(facts);
    case "dispatch_specialists":
      return finish(facts);
    case "synthesis":
      return summaryLoopOpen(facts) ? step("repair_summary") : recoverOrSettle(facts);
    case "repair_summary":
    case "recover_summary":
      return recoverOrSettle(facts);
    case "terminal_tick":
    case "finalize_deadline":
    case "failure_notice":
    case "settle_summary":
    case "deterministic_summary":
    case "done":
      return step("done");
    default: {
      const exhaustive: never = last;
      return exhaustive;
    }
  }
}

function briefOrAfter(facts: ReviewStepFacts): ReviewStep {
  return !facts.briefSubmitted && !facts.sessionRetired && facts.hasSession
    ? step("repair_brief")
    : afterBrief(facts);
}
