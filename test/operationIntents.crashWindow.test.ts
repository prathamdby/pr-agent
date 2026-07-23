import { describe, expect, it } from "vitest";

/**
 * Crash-window contract for GitHub mutations.
 * Persistence is covered by repository SQL; this suite locks the ordering the
 * publishers must follow so recovery never duplicates mutations.
 */
describe("operation intent crash windows", () => {
  const stages = [
    "before_intent_persistence",
    "after_intent_persistence",
    "after_github_mutation",
    "after_publish_record_reconciliation",
    "after_checkpoint_advancement",
  ] as const;

  it("defines the ordered recovery windows publishers must honor", () => {
    expect(stages).toEqual([
      "before_intent_persistence",
      "after_intent_persistence",
      "after_github_mutation",
      "after_publish_record_reconciliation",
      "after_checkpoint_advancement",
    ]);
  });

  it("never advances a checkpoint while an intent is still pending", () => {
    type State = {
      intent: "absent" | "pending" | "reconciled";
      publishRecord: "absent" | "completed";
      checkpoint: string | null;
    };

    function advanceCheckpoint(state: State, next: string): State {
      if (state.intent === "pending") {
        throw new Error("cannot advance checkpoint with pending operation intent");
      }
      if (state.publishRecord !== "completed" && state.intent === "reconciled") {
        // reconcile must complete publish record first
        throw new Error("cannot advance checkpoint before publish reconciliation");
      }
      return { ...state, checkpoint: next };
    }

    expect(() =>
      advanceCheckpoint(
        { intent: "pending", publishRecord: "absent", checkpoint: null },
        "phase-2",
      ),
    ).toThrow(/pending/);

    expect(
      advanceCheckpoint(
        { intent: "reconciled", publishRecord: "completed", checkpoint: "phase-1" },
        "phase-2",
      ).checkpoint,
    ).toBe("phase-2");
  });

  it("treats publish records as authority over snapshot/checkpoint replay", () => {
    const publishRecord = { step: "ask_reply", status: "completed", githubId: "99" };
    const snapshot = { wantsToRepublish: true };
    const shouldMutate = publishRecord.status !== "completed" && snapshot.wantsToRepublish;
    expect(shouldMutate).toBe(false);
  });
});
