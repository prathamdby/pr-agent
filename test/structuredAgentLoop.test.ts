import { describe, expect, it, vi } from "vitest";
import {
  runStructuredAgentLoop,
  runValidationRepairLoop,
} from "../src/agentRun/structuredAgentLoop.js";

describe("runStructuredAgentLoop", () => {
  it("runs phases in order and records phase entry", async () => {
    const events: string[] = [];

    await runStructuredAgentLoop({
      phases: [
        {
          name: "investigation",
          run: async () => {
            events.push("run:investigation");
          },
        },
        {
          name: "pre_submit",
          run: async () => {
            events.push("run:pre_submit");
          },
        },
      ],
      shouldContinue: () => true,
      onPhaseEnter: (phase) => events.push(`enter:${phase}`),
    });

    expect(events).toEqual([
      "enter:investigation",
      "run:investigation",
      "enter:pre_submit",
      "run:pre_submit",
    ]);
  });

  it("stops before the next phase when shouldContinue turns false", async () => {
    const secondPhase = vi.fn();
    let keepGoing = true;

    await runStructuredAgentLoop({
      phases: [
        {
          name: "investigation",
          run: async () => {
            keepGoing = false;
          },
        },
        { name: "validation_repair", run: secondPhase },
      ],
      shouldContinue: () => keepGoing,
    });

    expect(secondPhase).not.toHaveBeenCalled();
  });
});

describe("runValidationRepairLoop", () => {
  it("repairs each validation error until the payload is valid", async () => {
    const errors = ["missing summary", "missing finding body"];
    const repaired: string[] = [];

    await runValidationRepairLoop({
      rounds: 3,
      shouldContinue: () => true,
      getValidationError: () => errors.shift(),
      clearValidationError: vi.fn(),
      repair: async (validationError) => {
        repaired.push(validationError);
      },
    });

    expect(repaired).toEqual(["missing summary", "missing finding body"]);
  });

  it("does not repair after shouldContinue aborts", async () => {
    const repair = vi.fn();

    await runValidationRepairLoop({
      rounds: 2,
      shouldContinue: () => false,
      getValidationError: () => "missing summary",
      clearValidationError: vi.fn(),
      repair,
    });

    expect(repair).not.toHaveBeenCalled();
  });
});
