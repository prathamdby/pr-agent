import { describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import { AppError } from "../src/errors/appError.js";
import { pumpSpecialistCompletions } from "../src/review/orchestrator/completionPump.js";
import type {
  SpecialistId,
  SpecialistOutcome,
} from "../src/review/orchestrator/specialistReport.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function outcome(
  specialist: SpecialistId,
  kind: SpecialistOutcome["kind"] = "empty",
): SpecialistOutcome {
  if (kind === "error") {
    return {
      specialist,
      kind: "error",
      error: new AppError({ code: "review.specialist_failed", message: "boom" }),
      durationMs: 1,
    };
  }
  if (kind === "report") {
    return {
      specialist,
      kind: "report",
      report: {
        status: "findings",
        findings: [
          {
            severity: "P1",
            file: "a.ts",
            startLine: 1,
            endLine: 1,
            title: "t",
            detail: "d",
            fixPrompt: "f",
          },
        ],
      },
      durationMs: 1,
    };
  }
  return { specialist, kind: "empty", durationMs: 1 };
}

describe("pumpSpecialistCompletions", () => {
  it("delivers outcomes in completion order, not dispatch order", async () => {
    const a = deferred<SpecialistOutcome>();
    const b = deferred<SpecialistOutcome>();
    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>([
      ["correctness", a.promise],
      ["security", b.promise],
    ]);
    const seen: SpecialistId[] = [];

    const pump = pumpSpecialistCompletions({
      pending,
      onOutcome: async (item) => {
        seen.push(item.specialist);
      },
      shouldContinue: () => true,
    });

    b.resolve(outcome("security"));
    await Promise.resolve();
    a.resolve(outcome("correctness"));

    const all = await pump;
    expect(seen).toEqual(["security", "correctness"]);
    expect(all.map((item) => item.specialist)).toEqual(["security", "correctness"]);
  });

  it("invokes onOutcome serially even when the next specialist already resolved", async () => {
    const a = deferred<SpecialistOutcome>();
    const b = deferred<SpecialistOutcome>();
    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>([
      ["correctness", a.promise],
      ["security", b.promise],
    ]);
    const events: string[] = [];
    const aGate = deferred<void>();
    const aStarted = deferred<void>();

    const pump = pumpSpecialistCompletions({
      pending,
      onOutcome: async (item) => {
        events.push(`start:${item.specialist}`);
        if (item.specialist === "correctness") {
          aStarted.resolve();
          b.resolve(outcome("security"));
          await aGate.promise;
        }
        events.push(`end:${item.specialist}`);
      },
      shouldContinue: () => true,
    });

    a.resolve(outcome("correctness"));
    await aStarted.promise;
    expect(events).toEqual(["start:correctness"]);
    expect(events).not.toContain("start:security");

    aGate.resolve();
    await pump;
    expect(events).toEqual([
      "start:correctness",
      "end:correctness",
      "start:security",
      "end:security",
    ]);
  });

  it("preserves true settlement order when C settles before B while A onOutcome is blocked", async () => {
    // Map insertion order is A, B, C — if the pump re-races settled promises, B would
    // incorrectly win over C after A's handler unblocks.
    const a = deferred<SpecialistOutcome>();
    const b = deferred<SpecialistOutcome>();
    const c = deferred<SpecialistOutcome>();
    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>([
      ["correctness", a.promise],
      ["security", b.promise],
      ["quality", c.promise],
    ]);
    const seen: SpecialistId[] = [];
    const aGate = deferred<void>();
    const aStarted = deferred<void>();
    const cSettledWhileBlocked = deferred<void>();

    const pump = pumpSpecialistCompletions({
      pending,
      onOutcome: async (item) => {
        seen.push(item.specialist);
        if (item.specialist === "correctness") {
          aStarted.resolve();
          c.resolve(outcome("quality"));
          await Promise.resolve();
          await Promise.resolve();
          cSettledWhileBlocked.resolve();
          await aGate.promise;
        }
      },
      shouldContinue: () => true,
    });

    a.resolve(outcome("correctness"));
    await aStarted.promise;
    await cSettledWhileBlocked.promise;
    b.resolve(outcome("security"));
    await Promise.resolve();
    aGate.resolve();

    const all = await pump;
    expect(seen).toEqual(["correctness", "quality", "security"]);
    expect(all.map((item) => item.specialist)).toEqual(["correctness", "quality", "security"]);
  });

  it("stops further onOutcome when shouldContinue flips but still awaits remaining promises", async () => {
    const a = deferred<SpecialistOutcome>();
    const b = deferred<SpecialistOutcome>();
    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>([
      ["correctness", a.promise],
      ["security", b.promise],
    ]);
    let continuePump = true;
    const seen: SpecialistId[] = [];

    const pump = pumpSpecialistCompletions({
      pending,
      onOutcome: async (item) => {
        seen.push(item.specialist);
        continuePump = false;
      },
      shouldContinue: () => continuePump,
    });

    a.resolve(outcome("correctness"));
    await Promise.resolve();
    b.resolve(outcome("security"));
    const all = await pump;

    expect(seen).toEqual(["correctness"]);
    expect(all.map((item) => item.specialist)).toEqual(["correctness", "security"]);
  });

  it("supports AbortSignal cancellation the same way as shouldContinue", async () => {
    const a = deferred<SpecialistOutcome>();
    const b = deferred<SpecialistOutcome>();
    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>([
      ["correctness", a.promise],
      ["security", b.promise],
    ]);
    const controller = new AbortController();
    const seen: SpecialistId[] = [];

    const pump = pumpSpecialistCompletions({
      pending,
      onOutcome: async (item) => {
        seen.push(item.specialist);
        controller.abort();
      },
      shouldContinue: () => true,
      signal: controller.signal,
    });

    a.resolve(outcome("correctness"));
    await Promise.resolve();
    b.resolve(outcome("security"));
    const all = await pump;

    expect(seen).toEqual(["correctness"]);
    expect(all).toHaveLength(2);
  });

  it("catches onOutcome failures without losing remaining outcomes", async () => {
    const warn = vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    const a = deferred<SpecialistOutcome>();
    const b = deferred<SpecialistOutcome>();
    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>([
      ["correctness", a.promise],
      ["security", b.promise],
    ]);
    const seen: SpecialistId[] = [];

    const pump = pumpSpecialistCompletions({
      pending,
      onOutcome: async (item) => {
        seen.push(item.specialist);
        if (item.specialist === "correctness") {
          throw new Error("handler blew up");
        }
      },
      shouldContinue: () => true,
    });

    a.resolve(outcome("correctness"));
    await Promise.resolve();
    b.resolve(outcome("security"));
    const all = await pump;

    expect(seen).toEqual(["correctness", "security"]);
    expect(all).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      "review_specialist_outcome_handler_failed",
      expect.objectContaining({ specialist: "correctness" }),
    );
    warn.mockRestore();
  });
});
