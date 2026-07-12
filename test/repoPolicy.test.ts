import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import { loadRepoPolicy, renderPolicySuggestionForDismissed } from "../src/review/repoPolicy.js";

describe("renderPolicySuggestionForDismissed", () => {
  it("renders a paste-ready yaml snippet with file path and dismissal evidence", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/auth/login.ts",
      dismissalEvidence: "False positive: the input is already sanitized upstream.",
    });

    expect(result).toContain("```yaml");
    expect(result).toContain("version: 1");
    expect(result).toContain("pathInstructions:");
    expect(result).toContain('path: "src/auth/login.ts"');
    expect(result).toContain(
      'instructions: "False positive: the input is already sanitized upstream."',
    );
    expect(result).toContain("```");
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

    expect(result).toContain('path: "');
    expect(result).toContain('instructions: "');
    // The yaml block should still be well-formed
    expect(result).toContain("```yaml");
    expect(result).toContain("```");
  });
});

describe("loadRepoPolicy", () => {
  it("soft-ignores deprecated lensOverrides while preserving unified policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-policy-"));
    const warn = vi.spyOn(evlog, "logWarn");
    try {
      await writeFile(
        join(dir, ".pr-agent.yml"),
        [
          "version: 1",
          "tone: Be direct",
          "severityFloor: 2",
          "lensOverrides:",
          "  review-security:",
          "    tone: Be alarmist",
        ].join("\n"),
      );

      await expect(loadRepoPolicy(dir, 32_768)).resolves.toEqual({
        kind: "ok",
        policy: {
          version: 1,
          tone: "Be direct",
          severityFloor: 2,
        },
      });
      expect(warn).toHaveBeenCalledWith("repo_policy_lens_overrides_ignored", {
        path: join(dir, ".pr-agent.yml"),
      });
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
