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

function mockWorkspace(agentCwd: string, checkoutPaths: Iterable<string>): LocalPrWorkspace {
  const paths = new Set(checkoutPaths);
  return {
    rootDir: agentCwd,
    privateGitDir: agentCwd,
    agentCwd,
    checkoutMode: "full",
    changedFiles: [{ path: "src/changed.ts", status: "modified" }],
    checkoutPaths: paths,
    diffIndex: createCachedPrDiffIndex(),
    stats: { truncated: false, totalChanges: 1, fileCount: 1 },
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
});
