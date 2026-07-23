import { describe, expect, it } from "vitest";
import {
  clampThinkingLevel,
  clampToModelSupportedLevel,
  resolveThinkingLevel,
  thinkingPolicyFromCeiling,
} from "../src/agent/runtime/thinkingPolicy.js";

describe("thinkingPolicy", () => {
  const policy = thinkingPolicyFromCeiling("high");

  it("maps investigation phases higher than formatting/repair", () => {
    const recon = resolveThinkingLevel({ policy, phase: "recon" });
    const repair = resolveThinkingLevel({ policy, phase: "validation_repair" });
    expect(recon).toBe("medium");
    expect(repair).toBe("low");
  });

  it("respects configured ceilings", () => {
    expect(clampThinkingLevel("xhigh", "medium")).toBe("medium");
    const capped = thinkingPolicyFromCeiling("low");
    expect(resolveThinkingLevel({ policy: capped, phase: "judgment" })).toBe("low");
  });

  it("clamps unsupported levels to the nearest model-supported level", () => {
    expect(clampToModelSupportedLevel("high", ["off", "low", "medium"])).toBe("medium");
    expect(clampToModelSupportedLevel("minimal", ["low", "medium"])).toBe("low");
    expect(clampToModelSupportedLevel("high", [])).toBe("off");
  });

  it("applies model support after ceiling", () => {
    expect(
      resolveThinkingLevel({
        policy,
        phase: "specialist",
        modelSupportedLevels: ["off", "low"],
      }),
    ).toBe("low");
  });
});
