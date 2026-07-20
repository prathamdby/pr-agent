import { describe, expect, it } from "vitest";
import {
  condenseJobLogText,
  isDeprecationNoiseLine,
  mergeCondensedJobLogs,
} from "../src/review/ci/condenseCiLogs.js";

describe("condenseCiLogs", () => {
  it("detects Node 20 deprecation as noise", () => {
    expect(
      isDeprecationNoiseLine(
        "Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/cache@v4, actions/checkout@v4.",
      ),
    ).toBe(true);
  });

  it("keeps format failure and drops deprecation noise", () => {
    const raw = [
      "Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/cache@v4.",
      "Checking formatting...",
      "src/foo.ts (0ms)",
      "Format issues found in above 1 files. Run without `--check` to fix.",
      "Error: Process completed with exit code 1.",
    ].join("\n");

    const condensed = condenseJobLogText(raw);
    expect(condensed).toContain("Format issues found");
    expect(condensed).not.toContain("Node.js 20");
  });

  it("does not let warning-only deprecation beat a real error line", () => {
    const raw = [
      "##[warning]Node.js 20 is deprecated.",
      "oxfmt --check",
      "Format issues found in above 1 files.",
      "Error: Process completed with exit code 1.",
    ].join("\n");
    const condensed = condenseJobLogText(raw);
    expect(condensed.toLowerCase()).toMatch(/format|oxfmt|exit code 1/);
    expect(condensed).not.toContain("Node.js 20");
  });

  it("falls back to last lines when only deprecation noise exists", () => {
    const raw = "Node.js 20 is deprecated.\nStill only noise.\n";
    const condensed = condenseJobLogText(raw);
    // Sole-signal path may keep deprecation when nothing else remains.
    expect(condensed.length).toBeGreaterThan(0);
  });

  it("merges jobs under a byte budget", () => {
    const merged = mergeCondensedJobLogs(
      [
        { name: "lint", text: "a".repeat(100) },
        { name: "test", text: "b".repeat(100) },
      ],
      { maxBytes: 180 },
    );
    expect(merged).toContain("Job: lint");
    expect(merged.length).toBeLessThanOrEqual(200);
  });

  it("keeps the tail when condensed text exceeds maxChars", () => {
    const raw = [
      "Error: first failure marker near the top",
      "context-a",
      "context-b",
      "context-c",
      "Error: Process completed with exit code 1.",
      "tail-marker-zzzz",
    ].join("\n");
    const condensed = condenseJobLogText(raw, 40);
    expect(condensed.length).toBeLessThanOrEqual(40);
    expect(condensed).toContain("tail-marker-zzzz");
    expect(condensed).not.toContain("first failure marker");
  });
});
