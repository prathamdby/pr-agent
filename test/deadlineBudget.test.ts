import { describe, expect, it } from "vitest";
import {
  computeRunDeadlineAtMs,
  resolveSpecialistDispatchStaggerMs,
  specialistTimeoutMs,
} from "../src/review/orchestrator/deadlineBudget.js";
import { SPECIALIST_DISPATCH_STAGGER_MS } from "../src/settings/index.js";

describe("deadlineBudget", () => {
  it("computes the hard deadline as queue expiry times the budget fraction", () => {
    expect(
      computeRunDeadlineAtMs({
        nowMs: 1_000,
        queueExpireInSeconds: 100,
        budgetFraction: 0.8,
      }),
    ).toBe(1_000 + 80_000);
  });

  it("caps specialist timeout at the fair share of remaining budget", () => {
    expect(
      specialistTimeoutMs({
        nowMs: 10_000,
        deadlineAtMs: 50_000,
        configTimeoutMs: 900_000,
        pendingCount: 4,
      }),
    ).toBe(10_000);
  });

  it("uses the named stagger constant by default", () => {
    expect(resolveSpecialistDispatchStaggerMs()).toBe(SPECIALIST_DISPATCH_STAGGER_MS);
    expect(resolveSpecialistDispatchStaggerMs(0)).toBe(0);
  });

  it("gives every concurrent specialist the same remaining/4 fair share at one instant", () => {
    const shared = {
      nowMs: 10_000,
      deadlineAtMs: 50_000,
      configTimeoutMs: 900_000,
      pendingCount: 4,
    };
    const timeouts = [0, 1, 2, 3].map(() => specialistTimeoutMs(shared));
    expect(timeouts).toEqual([10_000, 10_000, 10_000, 10_000]);
  });
});
