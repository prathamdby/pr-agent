import { describe, expect, it } from "vitest";
import {
  assertSameModelAssignment,
  modelAssignmentForRole,
  resolveModelPolicy,
} from "../src/agent/runtime/modelPolicy.js";
import { makeTestConfig } from "./helpers/config.js";

describe("resolveModelPolicy", () => {
  it("uses general primary for specialists and other sessions", () => {
    const policy = resolveModelPolicy(
      makeTestConfig({ piProvider: "openai", piModel: "gpt-4o-mini" }),
    );
    expect(modelAssignmentForRole(policy, "specialist")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(modelAssignmentForRole(policy, "ask")).toEqual(policy.generalPrimary);
    expect(modelAssignmentForRole(policy, "ci_summary")).toEqual(policy.generalPrimary);
  });

  it("uses the general primary for the legacy orchestrator role", () => {
    const policy = resolveModelPolicy(
      makeTestConfig({
        piProvider: "openai",
        piModel: "gpt-4o-mini",
        piFallbackProvider: "openai",
        piFallbackModel: "gpt-4o",
      }),
    );
    expect(modelAssignmentForRole(policy, "orchestrator")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(policy.fallback).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("disables fallback when unset", () => {
    const policy = resolveModelPolicy(makeTestConfig());
    expect(policy.fallback).toBeUndefined();
  });

  it("forbids mid-session model switches on a healthy session", () => {
    expect(() =>
      assertSameModelAssignment(
        { provider: "openai", model: "gpt-4o-mini" },
        { provider: "openai", model: "gpt-4o" },
        { role: "ask", reason: "steer" },
      ),
    ).toThrow(/one model/);
  });
});
