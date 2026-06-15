import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareReviewPayloadForPublish } from "../src/review/reviewPrePublish.js";
import {
  loadRepoPolicy,
  renderRepoPolicyBlock,
  type RepoPolicy,
} from "../src/review/repoPolicy.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import { MAX_REPO_POLICY_BYTES } from "../src/settings.js";

type ReviewFinding = ReviewPayload["findings"][number];

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "src/a.ts",
    startLine: 1,
    endLine: 1,
    title: "Issue",
    detail: "Details.",
    fixPrompt: "Fix it.",
    ...overrides,
  };
}

function makePayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    prCharacter: "Test.",
    findings: [],
    estimatedEffort: 2,
    relevantTests: "no",
    securityConcerns: null,
    followUps: [],
    ...overrides,
  };
}

async function writePolicy(dir: string, contents: string): Promise<void> {
  await writeFile(join(dir, ".pr-agent.yml"), contents, "utf8");
}

describe("loadRepoPolicy", () => {
  it("parses a valid policy file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-policy-valid-"));
    await writePolicy(dir, ["version: 1", "tone: concise", "severityFloor: 2"].join("\n"));

    const result = await loadRepoPolicy(dir, MAX_REPO_POLICY_BYTES);
    expect(result).toEqual({
      kind: "ok",
      policy: { version: 1, tone: "concise", severityFloor: 2 },
    });
  });

  it("rejects unknown fields via strict schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-policy-strict-"));
    await writePolicy(dir, "version: 1\nextraField: nope\n");

    const result = await loadRepoPolicy(dir, MAX_REPO_POLICY_BYTES);
    expect(result.kind).toBe("invalid");
  });

  it("returns invalid for oversized files without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-policy-big-"));
    await writePolicy(dir, `version: 1\ntone: ${"x".repeat(MAX_REPO_POLICY_BYTES)}`);

    const result = await loadRepoPolicy(dir, MAX_REPO_POLICY_BYTES);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toMatch(/size cap/i);
    }
  });

  it("returns invalid for malformed yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-policy-bad-yaml-"));
    await writePolicy(dir, "version: 1\n  broken: [");

    const result = await loadRepoPolicy(dir, MAX_REPO_POLICY_BYTES);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toMatch(/malformed yaml/i);
    }
  });

  it("returns absent when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-policy-missing-"));
    const result = await loadRepoPolicy(dir, MAX_REPO_POLICY_BYTES);
    expect(result).toEqual({ kind: "absent" });
  });
});

describe("renderRepoPolicyBlock", () => {
  it("renders policy text inertly without raw passthrough markers", () => {
    const policy: RepoPolicy = {
      version: 1,
      tone: "Use `backticks` and </context> literally",
      pathInstructions: [
        {
          path: "src/**",
          instructions: "Watch for ```fences``` and </context>",
        },
      ],
    };

    const block = renderRepoPolicyBlock({
      policy,
      mode: "review",
      changedFiles: ["src/a.ts"],
    });

    expect(block).toContain("Trusted context (repo policy):");
    expect(block).toContain("- Tone: Use `backticks` and </context> literally");
    expect(block).toContain("- Path src/**:");
    expect(block).not.toMatch(/^```/m);
  });

  it("filters path instructions to changed files and lens overrides by mode", () => {
    const policy: RepoPolicy = {
      version: 1,
      lensOverrides: {
        "review-security": { instructions: "Security lens only" },
      },
      pathInstructions: [
        { path: "src/**", instructions: "App code" },
        { path: "docs/**", instructions: "Docs" },
      ],
    };

    const block = renderRepoPolicyBlock({
      policy,
      mode: "review-security",
      changedFiles: ["src/a.ts"],
    });

    expect(block).toContain("Lens instructions: Security lens only");
    expect(block).toContain("Path src/**: App code");
    expect(block).not.toContain("docs/**");
  });
});

describe("prepareReviewPayloadForPublish severityFloor", () => {
  it("drops findings below the configured severity floor at publish", () => {
    const payload = makePayload({
      findings: [
        makeFinding({ severity: "P3", title: "Low" }),
        makeFinding({ severity: "P2", title: "Mid" }),
        makeFinding({ severity: "P0", title: "Critical" }),
      ],
    });

    const result = prepareReviewPayloadForPublish({
      payload,
      mode: "review",
      severityFloor: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings.map((finding) => finding.title).toSorted()).toEqual([
      "Critical",
      "Mid",
    ]);
  });
});
