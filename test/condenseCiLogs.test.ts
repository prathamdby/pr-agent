import { describe, expect, it } from "vitest";
import {
  boundCondensedLogBytes,
  condenseJobLogText,
  isDeprecationNoiseLine,
  mergeCondensedJobLogs,
  rawLogIntakeCap,
  selectEffectiveCiContext,
} from "../src/review/ci/condenseCiLogs.js";
import { boundRawLogIntake } from "../src/review/ci/rawLogIntake.js";

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

  it("selects downloaded job logs over check output", () => {
    const selected = selectEffectiveCiContext({
      jobs: [
        { name: "lint", text: "Error: Process completed with exit code 1.\nFormat issues found" },
      ],
      checkOutput: "### Check: lint\nthis check output must not win",
    });
    expect(selected).toContain("Job: lint");
    expect(selected).toContain("Format issues found");
    expect(selected).not.toContain("must not win");
  });

  it("falls back to check output when downloaded job text is empty", () => {
    const selected = selectEffectiveCiContext({
      jobs: [{ name: "lint", text: "   " }],
      checkOutput: "Format issues found\nError: Process completed with exit code 1.",
    });
    expect(selected).toContain("Format issues found");
    expect(selected).not.toContain("Job: lint");
  });

  it("falls back to condensed check output when no job logs exist", () => {
    const selected = selectEffectiveCiContext({
      jobs: [],
      checkOutput: [
        "Node.js 20 is deprecated.",
        "Format issues found in above 1 files.",
        "Error: Process completed with exit code 1.",
      ].join("\n"),
    });
    expect(selected).toContain("Format issues found");
    expect(selected).not.toContain("Node.js 20");
  });

  it("returns empty context when both sources are blank", () => {
    expect(selectEffectiveCiContext({ jobs: [], checkOutput: "   " })).toBe("");
    expect(selectEffectiveCiContext({ jobs: [] })).toBe("");
  });

  it("redacts secrets in the selected context", () => {
    const token = "ghp_1234567890123456789012345678901234";
    const selected = selectEffectiveCiContext({
      jobs: [],
      checkOutput: `Error: Process completed with exit code 1.\nsecret=${token}`,
    });
    expect(selected).not.toContain(token);
    expect(selected).toContain("[redacted]");
  });

  it("applies the global byte budget to check-output fallback", () => {
    const selected = selectEffectiveCiContext({
      jobs: [],
      checkOutput: `Error: Process completed with exit code 1.\n${"x".repeat(400)}`,
      maxBytes: 80,
    });
    expect(Buffer.byteLength(selected, "utf8")).toBeLessThanOrEqual(80);
    expect(selected.length).toBeGreaterThan(0);
  });

  it("keeps the tail when bounding condensed bytes", () => {
    const bounded = boundCondensedLogBytes(`head-marker\n${"y".repeat(40)}tail-marker`, 20);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(20);
    expect(bounded).toContain("tail-marker");
    expect(bounded).not.toContain("head-marker");
  });

  it("caps raw intake to the tail window and keeps the failure digest", () => {
    const tailFailure = [
      "Format issues found in above 1 files. Run without `--check` to fix.",
      "Error: Process completed with exit code 1.",
    ].join("\n");
    const headSentinel = "HEAD-ONLY-SENTINEL-do-not-keep";
    const huge = `${headSentinel}\n${"z".repeat(200_000)}\n${tailFailure}`;
    const intake = boundRawLogIntake(huge);

    expect(intake.length).toBe(rawLogIntakeCap());
    expect(intake.length).toBeLessThan(huge.length);
    expect(intake).toContain("Format issues found");
    expect(intake).not.toContain(headSentinel);

    const condensed = condenseJobLogText(huge);
    expect(condensed).toBe(condenseJobLogText(intake));
    expect(condensed).toContain("Format issues found");
    expect(condensed).toContain("exit code 1");
  });

  it("keeps an early failure when teardown fills the tail window", () => {
    const failure = [
      "Format issues found in above 1 files. Run without `--check` to fix.",
      "Error: Process completed with exit code 1.",
    ].join("\n");
    const teardown = `${"ok-line\n".repeat(20_000)}##[group]Run Post teardown`;
    const huge = `${failure}\n${teardown}`;
    const intake = boundRawLogIntake(huge);

    expect(intake.length).toBe(rawLogIntakeCap());
    expect(intake).toContain("Format issues found");
    expect(intake).toContain("exit code 1");
    expect(intake.endsWith(huge.slice(-rawLogIntakeCap()))).toBe(false);

    const condensed = condenseJobLogText(huge);
    expect(condensed).toContain("Format issues found");
    expect(condensed).toContain("exit code 1");
    expect(condensed).not.toContain("Post teardown");
  });

  it("leaves logs inside the intake window unchanged before scanning", () => {
    const raw = [
      "Checking formatting...",
      "Format issues found in above 1 files. Run without `--check` to fix.",
      "Error: Process completed with exit code 1.",
    ].join("\n");
    expect(boundRawLogIntake(raw)).toBe(raw);
    expect(condenseJobLogText(raw)).toBe(condenseJobLogText(boundRawLogIntake(raw)));
  });
});
