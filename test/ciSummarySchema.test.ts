import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  parseCiSummaryLlmText,
  mergeCiSummaryWithFacts,
} from "../src/review/ci/authorCiSummary.js";
import { hashCiFacts, parseCiAuthoredCache } from "../src/review/ci/ciAuthoredCache.js";
import { ciSummaryFromFacts, WAITING_FOR_CI_SUMMARY } from "../src/review/ci/ciFromHeadState.js";
import { REVIEW_CI_SUMMARY_INCOMPLETE } from "../src/settings/index.js";
import { ciSummaryLlmSchema } from "../src/review/ci/ciSummarySchema.js";
import type { CiCheckFact } from "../src/review/ci/classifySnapshot.js";
import { buildCiContextUserMessage, ciGateRowContract } from "../src/review/ci/ciGatePrompt.js";

function checkFact(overrides: Partial<CiCheckFact> = {}): CiCheckFact {
  return {
    name: "lint",
    source: "check_run",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/o/r/runs/1",
    external_id: null,
    app_id: 9,
    check_run_id: 77,
    observed_at: "2026-09-13T00:00:02.000Z",
    ...overrides,
  };
}

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

  it("hashes facts by name, source, status, and conclusion only", () => {
    const left = {
      lint: checkFact(),
      unit: checkFact({
        name: "unit",
        conclusion: "success",
        observed_at: "2026-09-13T00:00:01.000Z",
      }),
    };
    const right = {
      unit: checkFact({
        name: "unit",
        conclusion: "success",
        url: "https://github.com/o/r/runs/99",
        observed_at: "2026-09-13T00:00:09.000Z",
      }),
      lint: checkFact({
        url: "https://github.com/o/r/runs/2",
        observed_at: "2026-09-13T00:00:08.000Z",
      }),
    };
    expect(hashCiFacts(left)).toBe(hashCiFacts(right));
    expect(hashCiFacts(left)).not.toBe(hashCiFacts({ lint: checkFact({ conclusion: "success" }) }));
  });

  it("rejects authored cache junk", () => {
    expect(parseCiAuthoredCache(null)).toBeNull();
    expect(parseCiAuthoredCache({})).toBeNull();
    expect(
      parseCiAuthoredCache({ factsHash: "", headline: "x", failures: [], authoredAt: "t" }),
    ).toBeNull();
    expect(
      parseCiAuthoredCache({
        factsHash: "abc",
        headline: "❌ CI failing — lint",
        failures: [{ name: "lint", reason: "fmt", fixHint: "oxfmt" }],
        authoredAt: "2026-09-13T00:00:00.000Z",
      }),
    ).toMatchObject({ factsHash: "abc", headline: "❌ CI failing — lint" });
  });

  it("renders authored cache only when the failing facts hash matches", () => {
    const failing = { lint: checkFact() };
    const cache = {
      factsHash: hashCiFacts(failing),
      headline: "❌ authored lint",
      failures: [{ name: "lint", reason: "oxfmt failed", fixHint: "run oxfmt" }],
      authoredAt: "2026-09-13T00:00:00.000Z",
    };
    const hit = ciSummaryFromFacts(failing, 4, cache);
    expect(hit.version).toBe(4);
    expect(hit.summary.status).toBe("failing");
    expect(hit.summary.headline).toBe("❌ authored lint");
    expect(hit.summary.failures[0]?.reason).toBe("oxfmt failed");

    const stale = ciSummaryFromFacts(failing, 4, { ...cache, factsHash: "other" });
    expect(stale.summary.headline).toContain("CI failing");
    expect(stale.summary.headline).not.toBe("❌ authored lint");

    const passing = { lint: checkFact({ conclusion: "success" }) };
    const passingCache = {
      factsHash: hashCiFacts(passing),
      headline: "❌ authored lint",
      failures: cache.failures,
      authoredAt: cache.authoredAt,
    };
    const ignored = ciSummaryFromFacts(passing, 2, passingCache);
    expect(ignored.summary.status).toBe("passing");
    expect(ignored.summary.headline).toContain("All CI is passing");

    expect(ciSummaryFromFacts({}, 0).summary).toEqual(WAITING_FOR_CI_SUMMARY);
  });

  it("renders an incomplete listing as unavailable instead of waiting or passing", () => {
    const incompleteEmpty = ciSummaryFromFacts({}, 3, undefined, { checkRunsComplete: false });
    expect(incompleteEmpty.summary.status).toBe("unavailable");
    expect(incompleteEmpty.summary.headline).toBe(REVIEW_CI_SUMMARY_INCOMPLETE);

    const passing = { lint: checkFact({ conclusion: "success" }) };
    const incompletePassing = ciSummaryFromFacts(passing, 3, undefined, {
      checkRunsComplete: false,
    });
    expect(incompletePassing.summary.status).toBe("unavailable");
    expect(incompletePassing.summary.headline).toBe(REVIEW_CI_SUMMARY_INCOMPLETE);
  });
});
