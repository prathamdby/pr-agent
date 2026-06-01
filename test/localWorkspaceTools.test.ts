import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { buildLocalWorkspaceTools } from "../src/agent/localWorkspaceTools.js";
import { createCachedPrDiffIndex } from "../src/review/reviewDiffIndex.js";
import type { LocalPrWorkspace } from "../src/prWorkspace/localPrWorkspace.js";

function testConfig(): Config {
  return {
    localWorkspaceSearchMaxFiles: 100,
    localWorkspaceSearchMaxTotalBytes: 1_000_000,
    localWorkspaceMaxFileBytes: 100_000,
  } as Config;
}

function mockWorkspace(agentCwd: string): LocalPrWorkspace {
  return {
    rootDir: agentCwd,
    privateGitDir: agentCwd,
    agentCwd,
    changedFiles: [{ path: "src/changed.ts", status: "modified" }],
    materializedPaths: new Set(["src/changed.ts", "src/unchanged.ts", "lib/helper.ts"]),
    diffIndex: createCachedPrDiffIndex(),
    stats: { truncated: false, totalChanges: 1, fileCount: 1 },
    getDiffForPath: async () => "",
    getBlameForPath: async () => "",
    materializePath: async (path) =>
      path === "src/changed.ts" || path === "src/unchanged.ts" || path === "lib/helper.ts"
        ? "already"
        : "refused",
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

      const workspace = mockWorkspace(root);
      const { executors } = buildLocalWorkspaceTools(workspace, testConfig());
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string }>;
      };

      expect(out.matches.map((m) => m.path).toSorted()).toEqual(["lib/helper.ts", "src/unchanged.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
