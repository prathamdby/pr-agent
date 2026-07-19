import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_REPO_POLICY_BYTES,
  MAX_REPO_POLICY_INSTRUCTION_CHARS,
} from "../src/settings/reviewConstants.js";
import {
  loadRepoPolicy,
  renderPolicySuggestionForDismissed,
  renderRepoPolicyBlock,
} from "../src/review/repoPolicy.js";

async function policyFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repo-policy-mdc-"));
  const dir = join(root, ".pr-agent");
  await mkdir(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return root;
}

describe("loadRepoPolicy", () => {
  it("returns absent when .pr-agent directory is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-policy-absent-"));
    await expect(loadRepoPolicy(root, MAX_REPO_POLICY_BYTES)).resolves.toEqual({
      kind: "absent",
    });
  });

  it("returns absent when .pr-agent has no .mdc files", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-policy-empty-"));
    await mkdir(join(root, ".pr-agent"));
    await writeFile(join(root, ".pr-agent", "readme.txt"), "ignore", "utf8");
    await expect(loadRepoPolicy(root, MAX_REPO_POLICY_BYTES)).resolves.toEqual({
      kind: "absent",
    });
  });

  it("loads a .mdc with no frontmatter as always-apply", async () => {
    const root = await policyFixture({
      "security.mdc": "Double-check auth on all new endpoints.",
    });
    const result = await loadRepoPolicy(root, MAX_REPO_POLICY_BYTES);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.policy.rules).toHaveLength(1);
    expect(result.policy.rules[0]).toMatchObject({
      filename: "security.mdc",
      relativePath: ".pr-agent/security.mdc",
      alwaysApply: true,
      globs: [],
      body: "Double-check auth on all new endpoints.",
    });
  });

  it("parses globs and alwaysApply frontmatter", async () => {
    const root = await policyFixture({
      "auth.mdc": `---
globs:
  - "src/auth/**"
alwaysApply: false
---

Treat missing session checks as P1.
`,
    });
    const result = await loadRepoPolicy(root, MAX_REPO_POLICY_BYTES);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.policy.rules[0]).toMatchObject({
      alwaysApply: false,
      globs: ["src/auth/**"],
      body: "Treat missing session checks as P1.",
    });
  });

  it("ignores legacy .pr-agent.yml at checkout root", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-policy-yaml-ignored-"));
    await writeFile(join(root, ".pr-agent.yml"), "version: 1\ntone: ignored\n", "utf8");
    await expect(loadRepoPolicy(root, MAX_REPO_POLICY_BYTES)).resolves.toEqual({
      kind: "absent",
    });
  });
});

describe("renderRepoPolicyBlock", () => {
  it("includes always-apply rules and matching globs only", () => {
    const block = renderRepoPolicyBlock({
      changedFiles: ["src/auth/login.ts", "README.md"],
      policy: {
        rules: [
          {
            filename: "global.mdc",
            relativePath: ".pr-agent/global.mdc",
            alwaysApply: true,
            globs: [],
            body: "Be direct.",
          },
          {
            filename: "auth.mdc",
            relativePath: ".pr-agent/auth.mdc",
            alwaysApply: false,
            globs: ["src/auth/**"],
            body: "Check sessions.",
          },
          {
            filename: "db.mdc",
            relativePath: ".pr-agent/db.mdc",
            alwaysApply: false,
            globs: ["src/db/**"],
            body: "Migrations need down scripts.",
          },
        ],
      },
    });

    expect(block).toContain("Trusted context (repo policy):");
    expect(block).toContain("Rule `.pr-agent/global.mdc`: Be direct.");
    expect(block).toContain("Rule `.pr-agent/auth.mdc`: Check sessions.");
    expect(block).not.toContain("db.mdc");
  });
});

describe("renderPolicySuggestionForDismissed", () => {
  it("renders a new .mdc starter when policy is absent", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/auth/login.ts",
      dismissalEvidence: "False positive: the input is already sanitized upstream.",
    });

    expect(result).toContain("Create `.pr-agent/login.mdc` with:");
    expect(result).toContain("```mdc");
    expect(result).toContain("globs:");
    expect(result).toContain('- "src/auth/login.ts"');
    expect(result).toContain("alwaysApply: false");
    expect(result).toContain("False positive: the input is already sanitized upstream.");
    expect(result).not.toContain(".pr-agent.yml");
    expect(result).not.toContain("pathInstructions");
    expect(result).not.toContain("```yaml");
  });

  it("renders an append fragment when exactly one rule matches", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/auth/login.ts",
      dismissalEvidence: "False positive",
      policyResult: {
        kind: "ok",
        policy: {
          rules: [
            {
              filename: "auth.mdc",
              relativePath: ".pr-agent/auth.mdc",
              alwaysApply: false,
              globs: ["src/auth/**"],
              body: "existing auth rules",
            },
          ],
        },
      },
    });

    expect(result).toContain("Append this to `.pr-agent/auth.mdc`:");
    expect(result).toContain("```md");
    expect(result).toContain("False positive");
    expect(result).not.toContain("Create `");
    expect(result).not.toContain("alwaysApply");
  });

  it("renders a new .mdc when multiple rules match", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/auth/login.ts",
      dismissalEvidence: "intentional",
      policyResult: {
        kind: "ok",
        policy: {
          rules: [
            {
              filename: "a.mdc",
              relativePath: ".pr-agent/a.mdc",
              alwaysApply: true,
              globs: [],
              body: "global",
            },
            {
              filename: "b.mdc",
              relativePath: ".pr-agent/b.mdc",
              alwaysApply: false,
              globs: ["src/auth/**"],
              body: "auth",
            },
          ],
        },
      },
    });

    expect(result).toContain("Create `.pr-agent/login.mdc` with:");
    expect(result).toContain("```mdc");
  });

  it("renders a full starter with reason when existing policy is invalid", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/app.ts",
      dismissalEvidence: "intentional",
      policyResult: { kind: "invalid", reason: "no usable .mdc rules" },
    });

    expect(result).toContain("could not be used (no usable .mdc rules)");
    expect(result).toContain("Create `.pr-agent/app.mdc` with:");
    expect(result).toContain("```mdc");
  });

  it("collapses multiline evidence into a single line", () => {
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/app.ts",
      dismissalEvidence: "Not a bug.\nThis is intentional.",
    });

    expect(result).toContain("Not a bug. This is intentional.");
    expect(result).not.toContain("\nThis is intentional.");
  });

  it("truncates overly long instructions", () => {
    const longEvidence = "x".repeat(2000);
    const result = renderPolicySuggestionForDismissed({
      filePath: "src/app.ts",
      dismissalEvidence: longEvidence,
    });

    const bodyMatch = result.match(/---\n\n([\s\S]*?)\n```/);
    expect(bodyMatch?.[1]?.length).toBe(MAX_REPO_POLICY_INSTRUCTION_CHARS);
  });
});
