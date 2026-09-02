import { afterEach, describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import type {
  SpecialistId,
  SpecialistOutcome,
} from "../src/review/orchestrator/orchestratorTypes.js";
import { pumpSpecialistCompletions } from "../src/review/orchestrator/completionPump.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emptyOutcome(specialist: SpecialistId): SpecialistOutcome {
  return { kind: "empty", specialist, durationMs: 1 };
}

describe("pumpSpecialistCompletions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns immediately when no specialists are pending", async () => {
    const onOutcome = vi.fn(async () => undefined);
    const shouldContinue = vi.fn(() => true);

    await expect(
      pumpSpecialistCompletions({
        pending: new Map(),
        onOutcome,
        shouldContinue,
      }),
    ).resolves.toEqual([]);
    expect(shouldContinue).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("delivers outcomes in completion order instead of dispatch order", async () => {
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    const quality = deferred<SpecialistOutcome>();
    const handled: SpecialistId[] = [];
    const pump = pumpSpecialistCompletions({
      pending: new Map([
        ["correctness", correctness.promise],
        ["security", security.promise],
        ["quality", quality.promise],
      ]),
      onOutcome: async (outcome) => {
        handled.push(outcome.specialist);
      },
      shouldContinue: () => true,
    });

    quality.resolve(emptyOutcome("quality"));
    correctness.resolve(emptyOutcome("correctness"));
    security.resolve(emptyOutcome("security"));

    const outcomes = await pump;

    expect(handled).toEqual(["quality", "correctness", "security"]);
    expect(outcomes.map((outcome) => outcome.specialist)).toEqual([
      "quality",
      "correctness",
      "security",
    ]);
  });

  it("preserves settlement order while awaiting each handler serially", async () => {
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    const quality = deferred<SpecialistOutcome>();
    const correctnessHandlingStarted = deferred<void>();
    const finishCorrectnessHandling = deferred<void>();
    const events: string[] = [];
    const pump = pumpSpecialistCompletions({
      pending: new Map([
        ["correctness", correctness.promise],
        ["security", security.promise],
        ["quality", quality.promise],
      ]),
      onOutcome: async (outcome) => {
        events.push(`start:${outcome.specialist}`);
        if (outcome.specialist === "correctness") {
          correctnessHandlingStarted.resolve(undefined);
          await finishCorrectnessHandling.promise;
        }
        events.push(`end:${outcome.specialist}`);
      },
      shouldContinue: () => true,
    });

    correctness.resolve(emptyOutcome("correctness"));
    await correctnessHandlingStarted.promise;
    quality.resolve(emptyOutcome("quality"));
    security.resolve(emptyOutcome("security"));
    finishCorrectnessHandling.resolve(undefined);

    const outcomes = await pump;

    expect(events).toEqual([
      "start:correctness",
      "end:correctness",
      "start:quality",
      "end:quality",
      "start:security",
      "end:security",
    ]);
    expect(outcomes.map((outcome) => outcome.specialist)).toEqual([
      "correctness",
      "quality",
      "security",
    ]);
  });

  it("stops handling after the run gate closes but still joins every specialist", async () => {
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    const quality = deferred<SpecialistOutcome>();
    const handled: SpecialistId[] = [];
    let gateChecks = 0;
    const pump = pumpSpecialistCompletions({
      pending: new Map([
        ["correctness", correctness.promise],
        ["security", security.promise],
        ["quality", quality.promise],
      ]),
      onOutcome: async (outcome) => {
        handled.push(outcome.specialist);
      },
      shouldContinue: () => {
        gateChecks += 1;
        return gateChecks !== 2;
      },
    });

    correctness.resolve(emptyOutcome("correctness"));
    quality.resolve(emptyOutcome("quality"));
    security.resolve(emptyOutcome("security"));

    const outcomes = await pump;

    expect(handled).toEqual(["correctness"]);
    expect(outcomes.map((outcome) => outcome.specialist)).toEqual([
      "correctness",
      "quality",
      "security",
    ]);
  });

  it("does not start another handler when the run gate closes during active handling", async () => {
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    const quality = deferred<SpecialistOutcome>();
    const correctnessHandlingStarted = deferred<void>();
    const finishCorrectnessHandling = deferred<void>();
    const handled: SpecialistId[] = [];
    let shouldContinue = true;
    const pump = pumpSpecialistCompletions({
      pending: new Map([
        ["correctness", correctness.promise],
        ["security", security.promise],
        ["quality", quality.promise],
      ]),
      onOutcome: async (outcome) => {
        handled.push(outcome.specialist);
        if (outcome.specialist === "correctness") {
          correctnessHandlingStarted.resolve(undefined);
          await finishCorrectnessHandling.promise;
        }
      },
      shouldContinue: () => shouldContinue,
    });

    correctness.resolve(emptyOutcome("correctness"));
    await correctnessHandlingStarted.promise;
    quality.resolve(emptyOutcome("quality"));
    security.resolve(emptyOutcome("security"));
    shouldContinue = false;
    finishCorrectnessHandling.resolve(undefined);

    const outcomes = await pump;

    expect(handled).toEqual(["correctness"]);
    expect(outcomes.map((outcome) => outcome.specialist)).toEqual([
      "correctness",
      "quality",
      "security",
    ]);
  });

  it("polls the watch while waiting and stops handling once it closes the gate", async () => {
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    const handled: SpecialistId[] = [];
    const pollCount = { value: 0 };
    let gateOpen = true;
    const pump = pumpSpecialistCompletions({
      pending: new Map([
        ["correctness", correctness.promise],
        ["security", security.promise],
      ]),
      onOutcome: async (outcome) => {
        handled.push(outcome.specialist);
      },
      shouldContinue: () => gateOpen,
      watch: {
        intervalMs: 5,
        onPoll: async () => {
          pollCount.value += 1;
          // The poll observed a durable cancel request mid-run.
          gateOpen = false;
        },
      },
    });

    // No specialist settles on its own; only the watch fires during the wait.
    await new Promise((resolve) => setTimeout(resolve, 20));
    correctness.resolve(emptyOutcome("correctness"));
    security.resolve(emptyOutcome("security"));

    const outcomes = await pump;

    expect(pollCount.value).toBeGreaterThanOrEqual(1);
    expect(handled).toEqual([]);
    expect(outcomes.map((outcome) => outcome.specialist)).toEqual(["correctness", "security"]);
  });

  it("logs a watch poll failure and keeps delivering later outcomes", async () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    const handled: SpecialistId[] = [];
    let gateOpen = true;
    let pollFails = true;
    const pump = pumpSpecialistCompletions({
      pending: new Map([
        ["correctness", correctness.promise],
        ["security", security.promise],
      ]),
      onOutcome: async (outcome) => {
        handled.push(outcome.specialist);
      },
      shouldContinue: () => gateOpen,
      watch: {
        intervalMs: 5,
        onPoll: async () => {
          if (pollFails) throw new Error("db read failed");
          gateOpen = false;
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    pollFails = false;
    await new Promise((resolve) => setTimeout(resolve, 15));
    correctness.resolve(emptyOutcome("correctness"));
    security.resolve(emptyOutcome("security"));

    await pump;

    expect(logWarn).toHaveBeenCalledWith(
      "review_specialist_gate_poll_failed",
      expect.objectContaining({ errorMessage: "db read failed" }),
    );
    expect(handled).toEqual([]);
  });

  it("turns a rejected specialist promise into an error outcome without hanging", async () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    const correctness = deferred<SpecialistOutcome>();
    const security = Promise.reject(new Error("specialist crashed"));
    const handled: SpecialistId[] = [];
    const pump = pumpSpecialistCompletions({
      pending: new Map([
        ["correctness", correctness.promise],
        ["security", security],
      ]),
      onOutcome: async (outcome) => {
        handled.push(outcome.specialist);
      },
      shouldContinue: () => true,
    });

    correctness.resolve(emptyOutcome("correctness"));

    const outcomes = await pump;

    expect(handled).toEqual(["correctness", "security"]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toContainEqual(emptyOutcome("correctness"));
    const rejected = outcomes.find((outcome) => outcome.specialist === "security");
    expect(rejected).toMatchObject({
      kind: "error",
      specialist: "security",
      durationMs: 0,
      error: expect.objectContaining({
        code: "review.specialist_promise_rejected",
        message: "specialist crashed",
      }),
    });
    expect(logWarn).toHaveBeenCalledWith(
      "review_specialist_promise_rejected",
      expect.objectContaining({
        specialist: "security",
        errorCode: "review.specialist_promise_rejected",
        errorMessage: "specialist crashed",
      }),
    );
  });

  it("logs a handler failure and continues with later specialist outcomes", async () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    const handled: SpecialistId[] = [];
    const pump = pumpSpecialistCompletions({
      pending: new Map([
        ["correctness", correctness.promise],
        ["security", security.promise],
      ]),
      onOutcome: async (outcome) => {
        handled.push(outcome.specialist);
        if (outcome.specialist === "correctness") throw new Error("send failed");
      },
      shouldContinue: () => true,
    });

    correctness.resolve(emptyOutcome("correctness"));
    security.resolve(emptyOutcome("security"));

    await expect(pump).resolves.toEqual([emptyOutcome("correctness"), emptyOutcome("security")]);
    expect(handled).toEqual(["correctness", "security"]);
    expect(logWarn).toHaveBeenCalledWith(
      "review_specialist_outcome_handler_failed",
      expect.objectContaining({
        specialist: "correctness",
        outcomeKind: "empty",
        errorCode: "review.orchestrator_outcome_handler_failed",
        errorMessage: "send failed",
      }),
    );
  });
});
