import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildLocalWorkspaceTools,
  type LocalWorkspaceToolLimits,
} from "../src/agent/localWorkspaceTools.js";
import { createAskPathGate } from "../src/agent/askSafety.js";
import { createCachedPrDiffIndex } from "../src/review/reviewDiffIndex.js";
import {
  gitGrepWorkspace,
  type GitGrepWorkspaceParams,
  type LocalPrWorkspace,
} from "../src/prWorkspace/localPrWorkspace.js";
import { LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE } from "../src/settings.js";

const exec = promisify(execFile);

function testLimits(overrides: Partial<LocalWorkspaceToolLimits> = {}): LocalWorkspaceToolLimits {
  return {
    searchMaxFiles: 100,
    searchMaxTotalBytes: 1_000_000,
    maxFileBytes: 100_000,
    ...overrides,
  };
}

function mockWorkspace(agentCwd: string, checkoutPaths: Iterable<string>): LocalPrWorkspace {
  const paths = new Set(checkoutPaths);
  const privateGitDir = join(agentCwd, ".git");
  const changedFiles = [{ path: "src/changed.ts", status: "modified" }] as const;
  return {
    rootDir: agentCwd,
    privateGitDir,
    agentCwd,
    checkoutMode: "full",
    changedFiles,
    changedFileByPath: new Map(changedFiles.map((file) => [file.path, file])),
    checkoutPaths: paths,
    sortedCheckoutPaths: [...paths].toSorted(),
    diffIndex: createCachedPrDiffIndex(),
    stats: { truncated: false, totalChanges: 1, fileCount: 1 },
    grepLiteral: (params: GitGrepWorkspaceParams) =>
      gitGrepWorkspace({ privateGitDir, agentCwd }, { ...params, timeoutMs: 5_000 }),
    getDiffForPath: async () => "",
    getBlameForPath: async () => "",
    isPathInCheckout: (path) => paths.has(path),
    cleanup: async () => {},
  };
}

async function writeWorkspaceFiles(root: string, files: Readonly<Record<string, string>>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
}

describe("local workspace tools", () => {
  it("searchWorkspace finds matches in unchanged files", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/unchanged.ts": "export const needle = 1;\n",
        "lib/helper.ts": "// needle helper\n",
      });

      const workspace = mockWorkspace(root, [
        "src/changed.ts",
        "src/unchanged.ts",
        "lib/helper.ts",
      ]);
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string; line: number; text: string }>;
        truncated: boolean;
        filesScanned: number;
      };

      expect(out).toEqual({
        matches: [
          { path: "lib/helper.ts", line: 1, text: "// needle helper" },
          { path: "src/unchanged.ts", line: 1, text: "export const needle = 1;" },
        ],
        truncated: false,
        filesScanned: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace skips sensitive paths not in PR changed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        ".env": "SECRET=needle\n",
        "src/ok.ts": "const needle = 1;\n",
      });

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

  it("searchWorkspace applies the path gate before the grep output cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        ".env": Array.from({ length: 5 }, () => `SECRET=needle ${"x".repeat(200)}`).join("\n"),
        "src/changed.ts": "export const changed = true;\n",
        "zzz/allowed.ts": "export const needle = true;\n",
      });

      const workspace = mockWorkspace(root, [".env", "src/changed.ts", "zzz/allowed.ts"]);
      const pathGate = createAskPathGate();
      pathGate.addPaths(["zzz/allowed.ts"]);
      const { executors } = buildLocalWorkspaceTools(
        workspace,
        testLimits({ searchMaxTotalBytes: 500 }),
        { pathGate },
      );
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string; text: string }>;
        truncated: boolean;
      };

      expect(out).toMatchObject({
        matches: [{ path: "zzz/allowed.ts", text: "export const needle = true;" }],
        truncated: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace honors maxResults truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/a.ts": "needle one\nneedle two\n",
        "src/b.ts": "needle three\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/a.ts", "src/b.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const out = (await executors.searchWorkspace?.({
        query: "needle",
        maxResults: 2,
      })) as {
        matches: Array<{ path: string }>;
        truncated: boolean;
      };

      expect(out.matches).toHaveLength(2);
      expect(out.truncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace treats dash-prefixed queries as literals", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/flag.ts": "const literal = '--max-count=1';\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/flag.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const out = (await executors.searchWorkspace?.({ query: "--max-count=1" })) as {
        matches: Array<{ path: string; text: string }>;
      };

      expect(out.matches).toEqual([
        { path: "src/flag.ts", line: 1, text: "const literal = '--max-count=1';" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace returns an empty result when nothing matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/other.ts": "const value = 1;\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/other.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());

      await expect(executors.searchWorkspace?.({ query: "needle" })).resolves.toEqual({
        matches: [],
        truncated: false,
        filesScanned: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace returns partial truncated output when git grep exceeds the output cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const files: Record<string, string> = {
        "src/changed.ts": "export const changed = true;\n",
      };
      for (let i = 0; i < 30; i++) {
        files[`src/file-${i}.ts`] = `const value = "needle ${"x".repeat(80)}";\n`;
      }
      await writeWorkspaceFiles(root, files);

      const workspace = mockWorkspace(root, Object.keys(files));
      const { executors } = buildLocalWorkspaceTools(
        workspace,
        testLimits({ searchMaxTotalBytes: 200 }),
      );
      const out = (await executors.searchWorkspace?.({
        query: "needle",
        maxResults: 20,
      })) as {
        matches: Array<{ path: string }>;
        truncated: boolean;
      };

      expect(out.truncated).toBe(true);
      expect(out.matches.length).toBeGreaterThan(0);
      expect(out.matches.length).toBeLessThanOrEqual(20);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace searches the git worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/worktree.ts": "const value = 'old';\n",
      });
      await writeFile(join(root, "src", "worktree.ts"), "const value = 'needle';\n");

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/worktree.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string; text: string }>;
      };

      expect(out.matches).toEqual([
        { path: "src/worktree.ts", line: 1, text: "const value = 'needle';" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace handles a 1000-file fixture without JS file scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const files: Record<string, string> = {
        "src/changed.ts": "export const changed = true;\n",
      };
      for (let i = 0; i < 1000; i++) {
        files[`src/file-${i}.ts`] = i === 999 ? "const needle = true;\n" : "const other = true;\n";
      }
      await writeWorkspaceFiles(root, files);

      const workspace = mockWorkspace(root, Object.keys(files));
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const startedAt = performance.now();
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string }>;
      };
      const durationMs = performance.now() - startedAt;

      expect(out.matches.map((match) => match.path)).toEqual(["src/file-999.ts"]);
      expect(durationMs).toBeLessThan(1000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace searches allowed paths across grep pathspec chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const files: Record<string, string> = {
        "src/changed.ts": "export const changed = true;\n",
      };
      const fileCount = LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE + 5;
      for (let i = 0; i < fileCount; i++) {
        files[`src/chunk-${i.toString().padStart(4, "0")}.ts`] =
          i === fileCount - 1 ? "const needle = true;\n" : "const other = true;\n";
      }
      await writeWorkspaceFiles(root, files);

      const workspace = mockWorkspace(root, Object.keys(files));
      const { executors } = buildLocalWorkspaceTools(workspace, testLimits());
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string }>;
      };

      expect(out.matches.map((match) => match.path)).toEqual([
        `src/chunk-${(fileCount - 1).toString().padStart(4, "0")}.ts`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
