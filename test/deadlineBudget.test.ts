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

  it("caps specialist timeout at remaining budget minus start stagger", () => {
    expect(
      specialistTimeoutMs({
        nowMs: 10_000,
        deadlineAtMs: 50_000,
        configTimeoutMs: 900_000,
        startStaggerMs: 0,
      }),
    ).toBe(40_000);
    expect(
      specialistTimeoutMs({
        nowMs: 10_000,
        deadlineAtMs: 50_000,
        configTimeoutMs: 900_000,
        startStaggerMs: 6_000,
      }),
    ).toBe(34_000);
  });

  it("uses the named stagger constant by default", () => {
    expect(resolveSpecialistDispatchStaggerMs()).toBe(SPECIALIST_DISPATCH_STAGGER_MS);
    expect(resolveSpecialistDispatchStaggerMs(0)).toBe(0);
  });

  it("gives later-staggered specialists less remaining budget than earlier ones", () => {
    const shared = {
      nowMs: 10_000,
      deadlineAtMs: 50_000,
      configTimeoutMs: 900_000,
    };
    const timeouts = [0, 1, 2, 3].map((index) =>
      specialistTimeoutMs({ ...shared, startStaggerMs: index * 2_000 }),
    );
    expect(timeouts).toEqual([40_000, 38_000, 36_000, 34_000]);
  });

  it("never exceeds the configured specialist timeout", () => {
    expect(
      specialistTimeoutMs({
        nowMs: 0,
        deadlineAtMs: 1_000_000,
        configTimeoutMs: 90_000,
        startStaggerMs: 0,
      }),
    ).toBe(90_000);
  });
});
