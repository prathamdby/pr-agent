import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  parseCiSummaryLlmText,
  mergeCiSummaryWithFacts,
} from "../src/review/ci/authorCiSummary.js";
import { ciSummaryLlmSchema } from "../src/review/ci/ciSummarySchema.js";
import { ciGateRowContract } from "../src/review/ci/ciGatePrompt.js";

describe("ciSummarySchema", () => {
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
        checkOutputFallback: "",
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
      checkOutputFallback: "",
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
});
