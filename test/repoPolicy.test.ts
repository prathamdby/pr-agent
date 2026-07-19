import { describe, expect, it } from "vitest";
import {
  MAX_REPO_POLICY_INSTRUCTION_CHARS,
  MAX_REPO_POLICY_PATH_PATTERN_CHARS,
} from "../src/settings/reviewConstants.js";
import { renderPolicySuggestionForDismissed } from "../src/review/repoPolicy.js";

function quotedScalar(result: string, key: "path" | "instructions"): string {
  const match = result.match(new RegExp(`${key}: "((?:\\\\.|[^"\\\\])*)"`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("renderPolicySuggestionForDismissed", () => {
  it("renders a full starter file when policy is absent", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/auth/login.ts",
      dismissalEvidence: "False positive: the input is already sanitized upstream.",
    });

    expect(result).toContain("Create `.pr-agent.yml` with:");
    expect(result).toContain("```yaml");
    expect(result).toContain("version: 1");
    expect(result).toContain("pathInstructions:");
    expect(result).toContain('path: "src/auth/login.ts"');
    expect(result).toContain(
      'instructions: "False positive: the input is already sanitized upstream."',
    );
    expect(result).toContain("```");
  });

  it("renders an append fragment when a valid policy already exists", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/auth/login.ts",
      dismissalEvidence: "False positive",
      policyResult: {
        kind: "ok",
        policy: {
          version: 1,
          pathInstructions: [{ path: "src/**", instructions: "keep quiet" }],
        },
      },
    });

    expect(result).toContain("Append this entry under `pathInstructions`");
    expect(result).toContain('path: "src/auth/login.ts"');
    expect(result).not.toContain("version: 1");
    expect(result).not.toContain("pathInstructions:");
  });

  it("renders a full starter with reason when existing policy is invalid", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/app.ts",
      dismissalEvidence: "intentional",
      policyResult: { kind: "invalid", reason: "malformed yaml" },
    });

    expect(result).toContain("could not be used (malformed yaml)");
    expect(result).toContain("version: 1");
    expect(result).toContain("pathInstructions:");
  });

  it("collapses multiline evidence into a single line", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/app.ts",
      dismissalEvidence: "Not a bug.\nThis is intentional.",
    });

    expect(result).toContain('instructions: "Not a bug. This is intentional."');
    expect(result).not.toContain("\nThis is intentional.");
  });

  it("truncates overly long file paths and instructions", () => {
    const longPath = "src/".repeat(50) + "file.ts";
    const longEvidence = "x".repeat(2000);
    const result = renderPolicySuggestionForDismissed({
      filePath: longPath,
      dismissalEvidence: longEvidence,
    });

    const path = quotedScalar(result, "path");
    const instructions = quotedScalar(result, "instructions");
    expect(path.length).toBe(MAX_REPO_POLICY_PATH_PATTERN_CHARS);
    expect(instructions.length).toBe(MAX_REPO_POLICY_INSTRUCTION_CHARS);
    expect(result).toContain("```yaml");
    expect(result).toContain("```");
  });

  it("escapes embedded double quotes in path and instructions", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: 'src/"weird".ts',
      dismissalEvidence: 'contains "quotes"',
    });

    expect(result).toContain('path: "src/\\"weird\\".ts"');
    expect(result).toContain('instructions: "contains \\"quotes\\""');
    expect(quotedScalar(result, "path")).toBe('src/\\"weird\\".ts');
    expect(quotedScalar(result, "instructions")).toBe('contains \\"quotes\\"');
  });
});
