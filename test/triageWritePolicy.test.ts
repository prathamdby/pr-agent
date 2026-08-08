import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertTriageStagePaths,
  assertTriageWritablePath,
  isTriageControlPath,
  isTriageSafeNewFilePath,
  normalizeRepoRelativePath,
} from "../src/agent/triage/triageWritePolicy.js";

describe("triageWritePolicy", () => {
  async function tempRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "triage-write-policy-"));
  }

  it("normalizes repo-relative paths", () => {
    expect(normalizeRepoRelativePath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeRepoRelativePath("./src/a.ts")).toBe("src/a.ts");
  });

  it.each([
    ".github/workflows/ci.yml",
    ".husky/pre-commit",
    "deploy/prod.yaml",
    "Dockerfile",
    "CODEOWNERS",
    ".npmrc",
    "helm/Chart.yaml",
    ".buildkite/pipeline.yml",
    "azure-pipelines.yml",
    ".travis.yml",
    "bitbucket-pipelines.yml",
    "appveyor.yml",
    ".drone.yml",
    "Taskfile.yml",
    "Makefile",
    "package.json",
    "nub.jsonc",
  ] as const)("denies control-plane path %s", (path) => {
    expect(isTriageControlPath(path)).toBe(true);
  });

  it.each(["src/app.ts", "docs/guide.md", "test/foo.test.ts"] as const)(
    "allows non-control path %s",
    (path) => {
      expect(isTriageControlPath(path)).toBe(false);
    },
  );

  it("requires safe path classes for new files", () => {
    expect(isTriageSafeNewFilePath("docs/note.md")).toBe(true);
    expect(isTriageSafeNewFilePath("src/app.test.ts")).toBe(true);
    expect(isTriageSafeNewFilePath("src/newHelper.ts")).toBe(false);
    expect(isTriageSafeNewFilePath(".github/workflows/x.yml")).toBe(false);
  });

  it("blocks edits outside the finding inventory", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/app.ts"), "export {};\n");
    await writeFile(join(root, "src/other.ts"), "export {};\n");

    await expect(
      assertTriageWritablePath({
        root,
        path: "src/other.ts",
        mode: "edit",
        implicatedPaths: new Set(["src/app.ts"]),
      }),
    ).rejects.toMatchObject({
      code: "triage.path_not_implicated",
    });
  });

  it("allows edits to implicated finding files", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/app.ts"), "export {};\n");

    const resolved = await assertTriageWritablePath({
      root,
      path: "src/app.ts",
      mode: "edit",
      implicatedPaths: new Set(["src/app.ts"]),
    });
    expect(resolved.relativePath).toBe("src/app.ts");
  });

  it("blocks creating workflows and other control-plane files", async () => {
    const root = await tempRoot();
    await expect(
      assertTriageWritablePath({
        root,
        path: ".github/workflows/evil.yml",
        mode: "create",
        implicatedPaths: new Set(),
      }),
    ).rejects.toMatchObject({ code: "triage.control_path_blocked" });
  });

  it("blocks creating files outside safe path classes", async () => {
    const root = await tempRoot();
    await expect(
      assertTriageWritablePath({
        root,
        path: "src/newHelper.ts",
        mode: "create",
        implicatedPaths: new Set(),
      }),
    ).rejects.toMatchObject({ code: "triage.unsafe_new_file_blocked" });
  });

  it("allows creating markdown docs under safe classes", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "docs"), { recursive: true });
    const resolved = await assertTriageWritablePath({
      root,
      path: "docs/fix-note.md",
      mode: "create",
      implicatedPaths: new Set(),
    });
    expect(resolved.relativePath).toBe("docs/fix-note.md");
  });

  it("blocks staging control-plane paths even when implicated", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, ".github/workflows/ci.yml"), "name: ci\n");

    await expect(
      assertTriageStagePaths({
        root,
        files: [".github/workflows/ci.yml"],
        implicatedPaths: new Set([".github/workflows/ci.yml"]),
      }),
    ).rejects.toMatchObject({ code: "triage.control_path_blocked" });
  });

  it("rejects symlink escapes outside the checkout root", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(join(tmpdir(), "triage-outside-"));
    await writeFile(join(outside, "secret.ts"), "export {};\n");
    await mkdir(join(root, "src"), { recursive: true });
    await symlink(join(outside, "secret.ts"), join(root, "src/escaped.ts"));

    await expect(
      assertTriageWritablePath({
        root,
        path: "src/escaped.ts",
        mode: "edit",
        implicatedPaths: new Set(["src/escaped.ts"]),
      }),
    ).rejects.toMatchObject({ code: "triage.symlink_escape_blocked" });
  });

  it("rejects path traversal via normalization", async () => {
    const root = await tempRoot();
    await expect(
      assertTriageWritablePath({
        root,
        path: "../outside.ts",
        mode: "edit",
        implicatedPaths: new Set(["../outside.ts"]),
      }),
    ).rejects.toThrow();
  });
});
