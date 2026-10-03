import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  boundCondensedLogBytes,
  condenseJobLogText,
  isDeprecationNoiseLine,
  mergeCondensedJobLogs,
  rawLogIntakeCap,
  selectEffectiveCiContext,
  boundRawLogIntake,
  parseCiSummaryLlmText,
  mergeCiSummaryWithFacts,
  ciSummaryLlmSchema,
  buildCiContextUserMessage,
  ciGateRowContract,
  fetchCiAuthorContext,
} from "../src/review/ci/ciAuthor.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

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

describe("ciSummarySchema and author prompt", () => {
  it("accepts valid LLM fields", () => {
    const parsed = v.parse(ciSummaryLlmSchema, {
      headline: "❌ CI failing — lint",
      failures: [
        {
          name: "lint",
          reason: "oxfmt --check failed on src/foo.ts.",
          fixHint: "Run oxfmt and re-push.",
        },
      ],
    });
    expect(parsed.failures).toHaveLength(1);
  });

  it("rejects empty headline", () => {
    expect(() =>
      v.parse(ciSummaryLlmSchema, {
        headline: "",
        failures: [],
      }),
    ).toThrow();
  });

  it("parses fenced JSON from model text", () => {
    const fields = parseCiSummaryLlmText(`Here you go:
\`\`\`json
{"headline":"❌ CI failing — unit","failures":[{"name":"unit","reason":"1 test failed","fixHint":"Re-run vitest locally."}]}
\`\`\`
`);
    expect(fields.failures[0]?.name).toBe("unit");
  });

  it("overwrites model status drift with server failing names", () => {
    const merged = mergeCiSummaryWithFacts(
      {
        status: "failing",
        checkNames: ["lint", "unit"],
        failingNames: ["lint"],
        failingUrls: new Map([["lint", "https://example.com/lint"]]),
        condensedLogs: "Format issues",
      },
      {
        headline: "Everything is fine",
        failures: [
          {
            name: "wrong-name",
            reason: "ignored",
            fixHint: "ignored",
          },
          {
            name: "lint",
            reason: "Format issues found.",
            fixHint: "Run oxfmt.",
          },
        ],
      },
    );
    expect(merged.status).toBe("failing");
    expect(merged.failures).toHaveLength(1);
    expect(merged.failures[0]?.name).toBe("lint");
    expect(merged.failures[0]?.reason).toContain("Format issues");
    expect(merged.failures[0]?.url).toBe("https://example.com/lint");
  });

  it("uses server headlines for passing, pending, and none", () => {
    const llm = {
      headline: "model should not win",
      failures: [{ name: "lint", reason: "x", fixHint: "y" }],
    };
    const base = {
      checkNames: ["lint"] as const,
      failingNames: [] as const,
      failingUrls: new Map<string, string | undefined>(),
      condensedLogs: "",
    };
    expect(mergeCiSummaryWithFacts({ ...base, status: "passing" }, llm)).toEqual({
      status: "passing",
      headline: "✅ All CI is passing",
      failures: [],
    });
    expect(mergeCiSummaryWithFacts({ ...base, status: "pending" }, llm)).toEqual({
      status: "pending",
      headline: "⏳ CI still running",
      failures: [],
    });
    expect(mergeCiSummaryWithFacts({ ...base, status: "none" }, llm)).toEqual({
      status: "none",
      headline: "No CI checks on this head",
      failures: [],
    });
  });

  it("throws when model text has no JSON object", () => {
    expect(() => parseCiSummaryLlmText("sorry, no structured output")).toThrow(/no JSON object/i);
  });

  it("exports the CI gate contract block", () => {
    expect(ciGateRowContract).toContain("CI gate row contract");
    expect(ciGateRowContract).toContain("deprecation");
  });

  it("puts one condensed context inside the untrusted ci_context block", () => {
    const message = buildCiContextUserMessage({
      status: "failing",
      checkNames: ["lint"],
      failingNames: ["lint"],
      condensedLogs: "Format issues found",
    });
    expect(message).toContain('<ci_context untrusted="true">');
    expect(message).toContain("Format issues found");
    expect(message).toContain("Condensed CI context:");
    expect(message).not.toContain("checkOutputFallback");
    expect(message).not.toMatch(/check output:/i);
  });

  it("uses a facts-only empty placeholder when condensed context is blank", () => {
    const message = buildCiContextUserMessage({
      status: "failing",
      checkNames: ["lint"],
      failingNames: ["lint"],
      condensedLogs: "   ",
    });
    expect(message).toContain("(no logs available)");
    expect(message).toContain('<ci_context untrusted="true">');
  });
});

describe("fetchCiAuthorContext", () => {
  it("downloads Actions logs by check_run_id before listing workflow jobs", async () => {
    const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    fake.controls.setJobLogs(
      11,
      ["Format issues found in above 1 files.", "Error: Process completed with exit code 1."].join(
        "\n",
      ),
    );
    fake.controls.setFailingJobs("abc", [{ id: 99, name: "other", conclusion: "failure" }]);
    const context = await fetchCiAuthorContext({
      prSurface: fake.surface,
      headSha: "abc",
      checks: {
        lint: {
          name: "lint",
          source: "check_run",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/o/r/actions/runs/1",
          external_id: null,
          app_id: 1,
          check_run_id: 11,
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    expect(context.condensedLogs).toContain("Format issues found");
    expect(fake.controls.events.filter((event) => event.kind === "downloadActionsJobLogs")).toEqual(
      [{ kind: "downloadActionsJobLogs", jobId: 11 }],
    );
    expect(fake.controls.events.some((event) => event.kind === "listFailingActionsJobs")).toBe(
      false,
    );
  });

  it("bounds a huge downloaded log to its failure digest before it reaches the author", async () => {
    const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const headSentinel = "HEAD-ONLY-SENTINEL-do-not-keep";
    fake.controls.setJobLogs(
      11,
      `${headSentinel}\n${"z".repeat(200_000)}\nFormat issues found in above 1 files.\nError: Process completed with exit code 1.`,
    );
    const context = await fetchCiAuthorContext({
      prSurface: fake.surface,
      headSha: "abc",
      checks: {
        lint: {
          name: "lint",
          source: "check_run",
          status: "completed",
          conclusion: "failure",
          url: null,
          external_id: null,
          app_id: 1,
          check_run_id: 11,
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    expect(context.condensedLogs).toContain("Format issues found");
    expect(context.condensedLogs).not.toContain(headSentinel);
  });

  it("lists failing Actions jobs when check_run_id logs are empty", async () => {
    const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    fake.controls.setFailingJobs("abc", [
      {
        id: 99,
        name: "lint",
        conclusion: "failure",
        htmlUrl: "https://github.com/o/r/actions/runs/99",
      },
    ]);
    fake.controls.setJobLogs(
      99,
      ["Format issues found in above 1 files.", "Error: Process completed with exit code 1."].join(
        "\n",
      ),
    );
    const context = await fetchCiAuthorContext({
      prSurface: fake.surface,
      headSha: "abc",
      checks: {
        lint: {
          name: "lint",
          source: "check_run",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/o/r/actions/runs/1",
          external_id: null,
          app_id: 1,
          check_run_id: 11,
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    expect(context.condensedLogs).toContain("Format issues found");
    expect(
      fake.controls.events
        .filter((event) => event.kind === "downloadActionsJobLogs")
        .map((event) => (event.kind === "downloadActionsJobLogs" ? event.jobId : null)),
    ).toEqual([11, 99]);
    expect(fake.controls.events.some((event) => event.kind === "listFailingActionsJobs")).toBe(
      true,
    );
  });
});
