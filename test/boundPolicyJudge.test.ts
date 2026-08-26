import { describe, expect, it, vi } from "vitest";
import { reviewFindingPlacementKey } from "../src/review/placement/reviewDiffPlacement.js";
import {
  attachJudgedBoundPaths,
  BOUND_POLICY_JUDGE_SYSTEM_PROMPT,
  buildBoundPolicyJudgeUserMessage,
  citedSnippetForFinding,
  numberCandidatePairs,
  parseBoundPolicyYesIds,
  resolveBoundPolicyFooters,
  type BoundPolicyJudgePair,
} from "../src/review/publish/boundPolicyJudge.js";
import { candidatePolicyPairs, type RepoPolicyRule } from "../src/review/repoPolicy.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { createTestEvidenceLedger, seedEvidenceForFinding } from "./helpers/evidenceTestHelpers.js";

const alwaysApply: RepoPolicyRule = {
  filename: "always.mdc",
  relativePath: ".pr-agent/always.mdc",
  alwaysApply: true,
  globs: [],
  body: "Never swallow errors.",
};

const authRule: RepoPolicyRule = {
  filename: "auth.mdc",
  relativePath: ".pr-agent/auth.mdc",
  alwaysApply: false,
  globs: ["src/auth/**"],
  body: "Auth only.",
};

const layoutRule: RepoPolicyRule = {
  filename: "module-layout.mdc",
  relativePath: ".pr-agent/module-layout.mdc",
  alwaysApply: false,
  globs: ["src/review/**"],
  body: "Layout.",
};

function findingAt(file: string, line: number, title = `Finding ${line}`): ReviewFinding {
  return {
    severity: "P1",
    file,
    startLine: line,
    endLine: line,
    title,
    detail: `Detail at ${file}:${line}.`,
    fixPrompt: "Do not send this to the judge.",
    suggestedCode: "secret-suggested",
  };
}

function sameRepoPolicy(rules: readonly RepoPolicyRule[]) {
  return { kind: "ok" as const, policy: { rules } };
}

describe("parseBoundPolicyYesIds", () => {
  it("keeps asked ids and drops extras", () => {
    expect(
      parseBoundPolicyYesIds(
        '{"yes":["p1",".pr-agent/always.mdc","p9","p0"]}',
        new Set(["p0", "p1"]),
      ),
    ).toEqual(["p1", "p0"]);
  });

  it("returns nothing on parse failure or missing object", () => {
    expect(parseBoundPolicyYesIds("not json", new Set(["p0"]))).toEqual([]);
    expect(parseBoundPolicyYesIds('{"yes":[1]}', new Set(["p0"]))).toEqual([]);
  });
});

describe("attachJudgedBoundPaths", () => {
  it("lists two yes paths on one finding in pair order", () => {
    const finding = findingAt("src/review/foo.ts", 4);
    const attached = attachJudgedBoundPaths({
      pairs: numberCandidatePairs([
        { finding, rule: layoutRule },
        { finding, rule: alwaysApply },
      ]),
      yesIds: ["p0", "p1"],
    });
    expect(attached.get(reviewFindingPlacementKey(finding))).toEqual([
      ".pr-agent/module-layout.mdc",
      ".pr-agent/always.mdc",
    ]);
  });

  it("drops a yes on a glob-mismatch pair", () => {
    const finding = findingAt("src/db/query.ts", 2);
    const attached = attachJudgedBoundPaths({
      pairs: numberCandidatePairs([{ finding, rule: authRule }]),
      yesIds: ["p0"],
    });
    expect(attached.size).toBe(0);
  });
});

describe("buildBoundPolicyJudgeUserMessage", () => {
  it("asks only for yes ids and fences finding text", () => {
    const message = buildBoundPolicyJudgeUserMessage([
      {
        id: "p0",
        relativePath: alwaysApply.relativePath,
        body: alwaysApply.body,
        file: "src/a.ts",
        startLine: 10,
        endLine: 10,
        title: "Missing null check",
        detail: "Payload can be null.",
        severity: "P1",
      },
    ]);
    expect(message).toContain("Asked ids: p0");
    expect(message).toContain("Return the yes subset");
    expect(message).toContain('<bound_policy_finding untrusted="true">');
    expect(message).toContain("Rule `.pr-agent/always.mdc`");
    expect(message).not.toContain("fixPrompt");
    expect(message).not.toContain("suggestedCode");
  });
});

describe("citedSnippetForFinding", () => {
  it("returns a checkout slice only when evidence already covers the finding", async () => {
    const finding = findingAt("src/a.ts", 2);
    const ledger = createTestEvidenceLedger();
    seedEvidenceForFinding(ledger, finding);
    const snippet = await citedSnippetForFinding({
      finding,
      evidenceLedger: ledger,
      isPathInCheckout: () => true,
      readCheckoutFile: async () => "line1\nline2\nline3",
    });
    expect(snippet).toBe("line2");
  });

  it("skips a snippet when evidence does not cover the finding", async () => {
    const finding = findingAt("src/a.ts", 2);
    const snippet = await citedSnippetForFinding({
      finding,
      evidenceLedger: createTestEvidenceLedger(),
      isPathInCheckout: () => true,
      readCheckoutFile: async () => "line1\nline2",
    });
    expect(snippet).toBeUndefined();
  });
});

describe("resolveBoundPolicyFooters snippet reads", () => {
  it("starts checkout reads for asked pairs together", async () => {
    const findings = [findingAt("src/a.ts", 1), findingAt("src/b.ts", 1)];
    const ledger = createTestEvidenceLedger();
    for (const finding of findings) seedEvidenceForFinding(ledger, finding);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const judge = vi.fn(async (pairs: readonly BoundPolicyJudgePair[]) => {
      expect(pairs.map((pair) => pair.snippet)).toEqual(["alpha", "beta"]);
      return [];
    });
    await resolveBoundPolicyFooters({
      policy: sameRepoPolicy([alwaysApply]),
      sameRepo: true,
      findings,
      judge,
      evidenceLedger: ledger,
      isPathInCheckout: () => true,
      readCheckoutFile: async (path) => {
        started += 1;
        if (started === 2) release();
        await gate;
        return path === "src/a.ts" ? "alpha" : "beta";
      },
    });
    expect(started).toBe(2);
    expect(judge).toHaveBeenCalledTimes(1);
  });
});

describe("resolveBoundPolicyFooters", () => {
  it("skips the pass when .pr-agent is absent", async () => {
    const judge = vi.fn(async () => ["p0"]);
    const bound = await resolveBoundPolicyFooters({
      policy: { kind: "absent" },
      sameRepo: true,
      findings: [findingAt("src/a.ts", 10)],
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(bound.size).toBe(0);
  });

  it("skips the pass for fork or invalid policy", async () => {
    const judge = vi.fn(async () => ["p0"]);
    const finding = findingAt("src/auth/login.ts", 3);
    const fork = await resolveBoundPolicyFooters({
      policy: sameRepoPolicy([alwaysApply, authRule]),
      sameRepo: false,
      findings: [finding],
      judge,
    });
    const invalid = await resolveBoundPolicyFooters({
      policy: { kind: "invalid", reason: "no usable .mdc rules" },
      sameRepo: true,
      findings: [finding],
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(fork.size).toBe(0);
    expect(invalid.size).toBe(0);
  });

  it("never sends a glob-mismatch pair to the judge", async () => {
    const judge = vi.fn(async (pairs: readonly BoundPolicyJudgePair[]) => {
      expect(pairs).toHaveLength(0);
      return ["p0"];
    });
    const bound = await resolveBoundPolicyFooters({
      policy: sameRepoPolicy([authRule]),
      sameRepo: true,
      findings: [findingAt("src/db/query.ts", 8)],
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(bound.size).toBe(0);
    expect(
      candidatePolicyPairs({
        policy: sameRepoPolicy([authRule]),
        sameRepo: true,
        findings: [findingAt("src/db/query.ts", 8)],
      }),
    ).toEqual([]);
  });

  it("attaches always-apply only on the judged-yes subset", async () => {
    const findings = Array.from({ length: 10 }, (_, index) =>
      findingAt("src/a.ts", index + 1, `Finding ${index + 1}`),
    );
    const judge = vi.fn(async (pairs: readonly BoundPolicyJudgePair[]) => {
      expect(pairs).toHaveLength(10);
      expect(pairs.every((pair) => pair.relativePath === ".pr-agent/always.mdc")).toBe(true);
      return ["p1", "p4"];
    });
    const bound = await resolveBoundPolicyFooters({
      policy: sameRepoPolicy([alwaysApply]),
      sameRepo: true,
      findings,
      judge,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(bound.get(reviewFindingPlacementKey(findings[1]!))).toEqual([".pr-agent/always.mdc"]);
    expect(bound.get(reviewFindingPlacementKey(findings[4]!))).toEqual([".pr-agent/always.mdc"]);
    expect(bound.size).toBe(2);
  });

  it("drops a timeout or extra path", async () => {
    const finding = findingAt("src/a.ts", 10);
    const timedOut = await resolveBoundPolicyFooters({
      policy: sameRepoPolicy([alwaysApply]),
      sameRepo: true,
      findings: [finding],
      judge: async () => {
        throw new Error("deadline");
      },
    });
    const extra = await resolveBoundPolicyFooters({
      policy: sameRepoPolicy([alwaysApply]),
      sameRepo: true,
      findings: [finding],
      judge: async () => [".pr-agent/always.mdc", "p9"],
    });
    expect(timedOut.size).toBe(0);
    expect(extra.size).toBe(0);
  });

  it("returns nothing without a judge", async () => {
    const bound = await resolveBoundPolicyFooters({
      policy: sameRepoPolicy([alwaysApply]),
      sameRepo: true,
      findings: [findingAt("src/a.ts", 10)],
    });
    expect(bound.size).toBe(0);
  });
});

describe("bound policy judge prompt contract", () => {
  it("tells the judge most always-apply pairs are no", () => {
    expect(BOUND_POLICY_JUDGE_SYSTEM_PROMPT).toContain(
      "Most findings do not violate a given always-apply rule",
    );
    expect(BOUND_POLICY_JUDGE_SYSTEM_PROMPT).toContain("Default no");
    expect(BOUND_POLICY_JUDGE_SYSTEM_PROMPT).not.toContain("violatedRule");
  });
});
