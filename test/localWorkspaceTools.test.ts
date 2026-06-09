import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLocalWorkspaceTools,
  type LocalWorkspaceToolLimits,
} from "../src/agent/localWorkspaceTools.js";
import { createAskPathGate } from "../src/agent/askSafety.js";
import { createCachedPrDiffIndex } from "../src/review/reviewDiffIndex.js";
import type { LocalPrWorkspace } from "../src/prWorkspace/localPrWorkspace.js";

function testLimits(): LocalWorkspaceToolLimits {
  return {
    searchMaxFiles: 100,
    searchMaxTotalBytes: 1_000_000,
    maxFileBytes: 100_000,
  };
}

function mockWorkspace(
  agentCwd: string,
  checkoutPaths: Iterable<string>,
  changedFiles: LocalPrWorkspace["changedFiles"] = [{ path: "src/changed.ts", status: "modified" }],
): LocalPrWorkspace {
  const paths = new Set(checkoutPaths);
  return {
    rootDir: agentCwd,
    privateGitDir: agentCwd,
    agentCwd,
    changedFiles,
    checkoutPaths: paths,
    diffIndex: createCachedPrDiffIndex(),
    stats: { truncated: false, totalChanges: 1, fileCount: changedFiles.length },
    getDiffForPath: async () => "",
    getBlameForPath: async () => "",
    isPathInCheckout: (path) => paths.has(path),
    cleanup: async () => {},
  };
}

describe("local workspace tools", () => {
  it("searchWorkspace finds matches in unchanged files", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "lib"), { recursive: true });
      await writeFile(join(root, "src", "changed.ts"), "export const changed = true;\n");
      await writeFile(join(root, "src", "unchanged.ts"), "export const needle = 1;\n");
      await writeFile(join(root, "lib", "helper.ts"), "// needle helper\n");

      const workspace = mockWorkspace(root, [
        "src/changed.ts",
        "src/unchanged.ts",
        "lib/helper.ts",
      ]);
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string }>;
      };

      expect(out.matches.map((m) => m.path).toSorted()).toEqual([
        "lib/helper.ts",
        "src/unchanged.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace skips sensitive paths not in PR changed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, ".env"), "SECRET=needle\n");
      await writeFile(join(root, "src", "ok.ts"), "const needle = 1;\n");

      const workspace = mockWorkspace(root, [".env", "src/ok.ts"]);
      const pathGate = createAskPathGate();
      pathGate.addPaths(["src/ok.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits(), {
        pathGate,
      });
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string }>;
      };

      expect(out.matches.map((m) => m.path)).toEqual(["src/ok.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("listChangedFiles hides ignored files and reports the count", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const workspace = mockWorkspace(
        root,
        [],
        [
          { path: "src/index.ts", status: "modified" },
          { path: "pnpm-lock.yaml", status: "modified" },
          { path: "src/api/__generated__/types.ts", status: "added" },
        ],
      );
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const out = (await executors.listChangedFiles?.({})) as {
        files: Array<{ path: string }>;
        ignored?: number;
      };
      expect(out.files.map((f) => f.path)).toEqual(["src/index.ts"]);
      expect(out.ignored).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace skips ignored generated and vendored files", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "src", "ok.ts"), "const needle = 1;\n");
      await writeFile(join(root, "dist", "bundle.js"), "var needle = 2;\n");

      const workspace = mockWorkspace(root, ["src/ok.ts", "dist/bundle.js"]);
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string }>;
      };

      expect(out.matches.map((m) => m.path)).toEqual(["src/ok.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
