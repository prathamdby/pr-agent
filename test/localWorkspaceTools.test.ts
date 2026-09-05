import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildLocalWorkspaceTools,
  type LocalWorkspaceToolLimits,
} from "../src/agent/tools/localWorkspaceTools.js";
import { createAskPathGate } from "../src/agent/ask/askSafety.js";
import { createCachedPrDiffIndex } from "../src/review/placement/reviewDiffIndex.js";
import {
  buildCheckoutCoverage,
  gitGrepWorkspace,
  type GitGrepWorkspaceParams,
  type LocalPrWorkspace,
} from "../src/prWorkspace/localPrWorkspace.js";
import {
  LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE,
  LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS,
} from "../src/settings/index.js";
import { createTestEvidenceLedger } from "./helpers/evidenceTestHelpers.js";
import {
  buildSymbolIndex,
  querySymbolIndex,
  symbolIndexStatus,
} from "../src/prWorkspace/symbolIndex.js";

const exec = promisify(execFile);

function testLimits(overrides: Partial<LocalWorkspaceToolLimits> = {}): LocalWorkspaceToolLimits {
  return {
    searchMaxFiles: 100,
    searchMaxTotalBytes: 1_000_000,
    maxFileBytes: 100_000,
    readResponseBytes: 8_000,
    diffResponseBytes: 4_000,
    ...overrides,
  };
}

function mockWorkspace(
  agentCwd: string,
  checkoutPaths: Iterable<string>,
  overrides?: {
    checkoutMode?: LocalPrWorkspace["checkoutMode"];
    stats?: LocalPrWorkspace["stats"];
    getDiffForPath?: (path: string) => Promise<string>;
    getBlameForPath?: (path: string) => Promise<string>;
    lookupSymbol?: LocalPrWorkspace["lookupSymbol"];
    getSymbolIndexStatus?: LocalPrWorkspace["getSymbolIndexStatus"];
  },
): LocalPrWorkspace {
  const paths = new Set(checkoutPaths);
  const privateGitDir = join(agentCwd, ".git");
  const changedFiles = [{ path: "src/changed.ts", status: "modified" as const }];
  const checkoutMode = overrides?.checkoutMode ?? "full";
  const stats = overrides?.stats ?? { truncated: false, totalChanges: 1, fileCount: 1 };
  let searchTruncated = false;
  return {
    rootDir: agentCwd,
    privateGitDir,
    agentCwd,
    checkoutMode,
    changedFiles,
    changedFileByPath: new Map(changedFiles.map((file) => [file.path, file])),
    checkoutPaths: paths,
    sortedCheckoutPaths: [...paths].toSorted(),
    diffIndex: createCachedPrDiffIndex(),
    stats,
    grepLiteral: (params: GitGrepWorkspaceParams) =>
      gitGrepWorkspace({ privateGitDir, agentCwd }, { ...params, timeoutMs: 5_000 }),
    getDiffForPath: overrides?.getDiffForPath ?? (async () => ""),
    getBlameForPath: overrides?.getBlameForPath ?? (async () => ""),
    isPathInCheckout: (path) => paths.has(path),
    getCoverage: () =>
      buildCheckoutCoverage({
        checkoutMode,
        checkoutPaths: paths,
        changedFiles,
        stats,
        searchTruncated,
      }),
    noteSearchTruncated: () => {
      searchTruncated = true;
    },
    lookupSymbol: overrides?.lookupSymbol ?? (() => []),
    getSymbolIndexStatus: overrides?.getSymbolIndexStatus ?? (() => ({ available: false })),
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
  it("exposes investigation-protocol guidance on each tool description", () => {
    const { piTools } = buildLocalWorkspaceTools(mockWorkspace("/tmp", ["src/changed.ts"]), {
      limits: testLimits(),
    });
    const byName = Object.fromEntries(piTools.map((tool) => [tool.name, tool.description]));

    expect(byName.listChangedFiles).toContain("Start here");
    expect(byName.getWorkspaceDiff).toContain("before opening whole files");
    expect(byName.searchWorkspace).toContain("literal string");
    expect(byName.searchWorkspace).toContain("not a regex");
    expect(byName.readWorkspaceFile).toContain("do not retry the same call unchanged");
    expect(byName.getWorkspaceBlame).toContain("only when authorship genuinely decides");
  });

  it("readWorkspaceFile returns full content under the response cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "line one\nline two\n",
        "src/small.ts": "hello\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/small.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "src/small.ts" })) as {
        content: string;
        size: number;
        startLine: number;
        endLine: number;
        truncated: boolean;
        returnedBytes: number;
      };

      expect(out).toMatchObject({
        content: "hello\n",
        size: 6,
        startLine: 1,
        endLine: 1,
        truncated: false,
        returnedBytes: 6,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile caps oversized responses with truncation metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const body = `${"x".repeat(200)}\n`.repeat(100);
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/large.ts": body,
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/large.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ readResponseBytes: 500 }),
      });
      const out = (await executors.readWorkspaceFile?.({ path: "src/large.ts" })) as {
        truncated: boolean;
        returnedBytes: number;
        truncationReason?: string;
        startLine: number;
        endLine: number;
      };

      expect(out.truncated).toBe(true);
      expect(out.returnedBytes).toBeLessThanOrEqual(500);
      expect(out.truncationReason).toBe("response byte budget exceeded");
      expect(out.startLine).toBe(1);
      expect(out.endLine).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile clamps a minified mega-line instead of letting it eat the budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const minified = `"use strict";${"m".repeat(50_000)}`;
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/bundle.js": `${minified}\nexport const after = 1;\n`,
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/bundle.js"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "src/bundle.js" })) as {
        content: string;
        truncated: boolean;
        endLine: number;
      };

      expect(out.truncated).toBe(false);
      expect(out.content).toBe(
        `[line 1 clamped: ${minified.length} characters elided]\nexport const after = 1;\n`,
      );
      expect(out.endLine).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile strips a leading BOM and normalizes CRLF", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/legacy.ts": "\uFEFFone\r\ntwo\r\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/legacy.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "src/legacy.ts" })) as {
        content: string;
        startLine: number;
        endLine: number;
      };

      expect(out.content).toBe("one\ntwo\n");
      expect(out.startLine).toBe(1);
      expect(out.endLine).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile supports line-window reads with line metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/window.ts": "a\nb\nc\nd\ne\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/window.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({
        path: "src/window.ts",
        startLine: 2,
        maxLines: 2,
      })) as {
        content: string;
        startLine: number;
        endLine: number;
        truncated: boolean;
        truncationReason?: string;
      };

      expect(out).toMatchObject({
        content: "b\nc",
        startLine: 2,
        endLine: 3,
        truncated: true,
        truncationReason: "line window limit exceeded",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile refuses oversized files before response capping", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/huge.ts": "x".repeat(200),
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/huge.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ maxFileBytes: 100, readResponseBytes: 50 }),
      });
      const out = (await executors.readWorkspaceFile?.({ path: "src/huge.ts" })) as {
        refused?: boolean;
        reason?: string;
      };

      expect(out).toMatchObject({
        refused: true,
        reason: "File exceeds 100 byte read limit.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile refuses binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
      });
      await writeFile(join(root, "src/binary.bin"), Buffer.from([0, 1, 2, 3]));

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/binary.bin"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "src/binary.bin" })) as {
        refused?: boolean;
        reason?: string;
      };

      expect(out).toMatchObject({
        refused: true,
        reason: "Binary file cannot be read as text.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("getWorkspaceDiff caps diff output with truncation metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, { "src/changed.ts": "export const changed = true;\n" });
      const workspace = mockWorkspace(root, ["src/changed.ts"], {
        getDiffForPath: async () => "x".repeat(10_000),
      });
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ diffResponseBytes: 100 }),
      });
      const out = (await executors.getWorkspaceDiff?.({ path: "src/changed.ts" })) as {
        diff: string;
        truncated: boolean;
        returnedBytes: number;
        truncationReason?: string;
      };

      expect(out.truncated).toBe(true);
      expect(out.returnedBytes).toBeLessThanOrEqual(100);
      expect(out.truncationReason).toBe("response byte budget exceeded");
      expect(out.diff.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("getWorkspaceBlame caps blame output with truncation metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, { "src/changed.ts": "export const changed = true;\n" });
      const workspace = mockWorkspace(root, ["src/changed.ts"], {
        getBlameForPath: async () => "author-mail user@example.com\n".repeat(200),
      });
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ diffResponseBytes: 100 }),
      });
      const out = (await executors.getWorkspaceBlame?.({ path: "src/changed.ts" })) as {
        blame: string;
        truncated: boolean;
        returnedBytes: number;
        truncationReason?: string;
      };

      expect(out.truncated).toBe(true);
      expect(out.returnedBytes).toBeLessThanOrEqual(100);
      expect(out.truncationReason).toBe("response byte budget exceeded");
      expect(out.blame).toContain("author-mail [redacted]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
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
        pathsSearched: 3,
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
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits(),
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
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ searchMaxTotalBytes: 500 }),
        pathGate,
      });
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
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
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

  it("searchWorkspace keeps paths with spaces intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/my file.ts": "const needle = 1;\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/my file.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string; line: number; text: string }>;
      };

      expect(out.matches).toEqual([{ path: "src/my file.ts", line: 1, text: "const needle = 1;" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace succeeds when git rejects --max-count", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "workspace-git-compat-"));
    const previousPath = process.env.PATH ?? "";
    try {
      await writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          "for arg; do",
          '  case "$arg" in',
          "    --max-count|--max-count=*)",
          '      echo "error: unknown option $arg" >&2',
          "      exit 129",
          "      ;;",
          "  esac",
          "done",
          'exec /usr/bin/git "$@"',
          "",
        ].join("\n"),
      );
      await chmod(join(bin, "git"), 0o755);
      process.env.PATH = `${bin}:${previousPath}`;

      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/compat.ts": "const needle = 1;\n",
      });
      const workspace = mockWorkspace(root, ["src/changed.ts", "src/compat.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string; line: number; text: string }>;
      };

      expect(out.matches).toEqual([{ path: "src/compat.ts", line: 1, text: "const needle = 1;" }]);
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
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
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
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
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });

      await expect(executors.searchWorkspace?.({ query: "needle" })).resolves.toEqual({
        matches: [],
        truncated: false,
        pathsSearched: 2,
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
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ searchMaxTotalBytes: 200 }),
      });
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
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
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
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
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
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
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

  it("searchWorkspace uses the single-shot scan at full coverage with identical reporting", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const files: Record<string, string> = {
        "src/changed.ts": "export const changed = true;\n",
        "src/a.ts": "const needle = true;\n",
        "src/b.ts": "const needle = true;\n",
      };
      await writeWorkspaceFiles(root, files);

      const base = mockWorkspace(root, Object.keys(files));
      const seen: GitGrepWorkspaceParams[] = [];
      const workspace: LocalPrWorkspace = {
        ...base,
        grepLiteral: async (params) => {
          seen.push(params);
          return base.grepLiteral(params);
        },
      };
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string }>;
        truncated: boolean;
        pathsSearched: number;
        filesScanned: number;
      };

      expect(out.matches.map((match) => match.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
      expect(out.truncated).toBe(false);
      expect(out.pathsSearched).toBe(3);
      expect(out.filesScanned).toBe(2);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.paths).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile records evidence in the ledger on success", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-evidence-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/small.ts": "line one\nline two\nline three\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/small.ts"]);
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits(),
        evidenceLedger,
        headSha: "deadbeef",
      });
      await executors.readWorkspaceFile?.({
        path: "src/small.ts",
        startLine: 2,
        maxLines: 2,
      });

      expect(evidenceLedger.covers("src/small.ts", 2, 3)).toBe(true);
      expect(evidenceLedger.covers("src/small.ts", 1, 1)).toBe(false);
      expect(evidenceLedger.snapshot()).toHaveLength(1);
      expect(evidenceLedger.snapshot()[0]?.tool).toBe("readWorkspaceFile");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile does not record evidence for a clamped line", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-evidence-"));
    try {
      // The clamp elides the line's contents, so a finding on it must not
      // pass the range-coverage check in assertFindingsHaveEvidence.
      await writeWorkspaceFiles(root, {
        "src/min.ts": `line one\n${"x".repeat(LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS + 1)}\nline three\n`,
      });

      const workspace = mockWorkspace(root, ["src/min.ts"]);
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ readResponseBytes: 500_000 }),
        evidenceLedger,
        headSha: "deadbeef",
      });
      await executors.readWorkspaceFile?.({ path: "src/min.ts" });

      expect(evidenceLedger.covers("src/min.ts", 2, 2)).toBe(false);
      expect(evidenceLedger.covers("src/min.ts", 1, 3)).toBe(false);
      expect(evidenceLedger.covers("src/min.ts", 1, 1)).toBe(true);
      expect(evidenceLedger.covers("src/min.ts", 3, 3)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("getWorkspaceDiff records evidence for commentable diff lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-evidence-"));
    try {
      await writeWorkspaceFiles(root, { "src/changed.ts": "export const changed = true;\n" });
      const patch = ["@@ -1,1 +1,3 @@", " x", "+added", "+more"].join("\n");
      const workspace = mockWorkspace(root, ["src/changed.ts"], {
        getDiffForPath: async () => patch,
      });
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits(),
        evidenceLedger,
        headSha: "deadbeef",
      });

      await executors.getWorkspaceDiff?.({ path: "src/changed.ts" });

      expect(evidenceLedger.covers("src/changed.ts", 2, 3)).toBe(true);
      expect(evidenceLedger.snapshot()[0]?.tool).toBe("getWorkspaceDiff");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile includes coverage when path is missing from checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts"], { checkoutMode: "sparse" });
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "src/missing.ts" })) as {
        refused?: boolean;
        coverage?: { mode: string };
      };

      expect(out.refused).toBe(true);
      expect(out.coverage).toMatchObject({ mode: "sparse" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searchWorkspace reports pathsSearched separately from filesScanned and sets truncated on caps", async () => {
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
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ searchMaxTotalBytes: 200 }),
      });
      const out = (await executors.searchWorkspace?.({
        query: "needle",
        maxResults: 20,
      })) as {
        matches: Array<{ path: string }>;
        truncated: boolean;
        pathsSearched: number;
        filesScanned: number;
        coverage?: { searchTruncated?: boolean };
        warning?: string;
      };

      expect(out.truncated).toBe(true);
      expect(out.pathsSearched).toBe(Object.keys(files).length);
      expect(out.filesScanned).toBeGreaterThan(0);
      expect(out.filesScanned).toBeLessThanOrEqual(out.pathsSearched);
      expect(out.coverage).toBeDefined();
      expect(out.warning).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolveSymbol returns defining file and line for known symbols", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-symbol-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/symbols.ts": "export function foo() {\n  return 1;\n}\n",
      });

      const index = await buildSymbolIndex(["src/symbols.ts"], async (path) => {
        if (path === "src/symbols.ts") return "export function foo() {\n  return 1;\n}\n";
        return null;
      });
      const workspace = mockWorkspace(root, ["src/changed.ts", "src/symbols.ts"], {
        lookupSymbol: (name, maxResults) => querySymbolIndex(index, name, maxResults),
        getSymbolIndexStatus: () => symbolIndexStatus(index),
      });
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.resolveSymbol?.({ name: "foo" })) as {
        available: boolean;
        matches: Array<{ path: string; line: number; kind: string }>;
      };

      expect(out.available).toBe(true);
      expect(out.matches).toEqual([{ path: "src/symbols.ts", line: 1, kind: "function" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolveSymbol does not index symbols for sparse paths missing from checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-symbol-sparse-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/on-disk.ts": "function foo() {}\n",
        "src/off-disk.ts": "function bar() {}\n",
      });

      const index = await buildSymbolIndex(["src/on-disk.ts", "src/off-disk.ts"], async (path) => {
        if (path === "src/on-disk.ts") return "function foo() {}\n";
        return null;
      });
      const workspace = mockWorkspace(root, ["src/on-disk.ts"], {
        checkoutMode: "sparse",
        lookupSymbol: (name, maxResults) => querySymbolIndex(index, name, maxResults),
        getSymbolIndexStatus: () => symbolIndexStatus(index),
      });
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });

      const foo = (await executors.resolveSymbol?.({ name: "foo" })) as {
        matches: Array<{ path: string }>;
      };
      const bar = (await executors.resolveSymbol?.({ name: "bar" })) as {
        matches: Array<{ path: string }>;
      };

      expect(foo.matches).toEqual([{ path: "src/on-disk.ts", line: 1, kind: "function" }]);
      expect(bar.matches).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolveSymbol hits do not satisfy evidence ledger without readWorkspaceFile", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-symbol-evidence-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/symbols.ts": "export function foo() {\n  return 1;\n}\n",
      });

      const index = await buildSymbolIndex(["src/symbols.ts"], async (path) => {
        if (path === "src/symbols.ts") return "export function foo() {\n  return 1;\n}\n";
        return null;
      });
      const workspace = mockWorkspace(root, ["src/changed.ts", "src/symbols.ts"], {
        lookupSymbol: (name, maxResults) => querySymbolIndex(index, name, maxResults),
        getSymbolIndexStatus: () => symbolIndexStatus(index),
      });
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits(),
        evidenceLedger,
        headSha: "deadbeef",
      });

      await executors.resolveSymbol?.({ name: "foo" });

      expect(evidenceLedger.covers("src/symbols.ts", 1, 1)).toBe(false);
      expect(evidenceLedger.snapshot()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolveSymbol description requires readWorkspaceFile before citing", () => {
    const { piTools } = buildLocalWorkspaceTools(mockWorkspace("/tmp", ["src/changed.ts"]), {
      limits: testLimits(),
    });
    const resolveSymbol = piTools.find((tool) => tool.name === "resolveSymbol");
    expect(resolveSymbol?.description).toContain("readWorkspaceFile");
  });

  it("readWorkspaceFile names a FIFO instead of reporting it missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, { "src/changed.ts": "export {};\n" });
      await mkdir(join(root, "logs"), { recursive: true });
      await exec("mkfifo", [join(root, "logs", "live.pipe")]);

      const workspace = mockWorkspace(root, ["src/changed.ts", "logs/live.pipe"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "logs/live.pipe" })) as {
        refused?: boolean;
        reason?: string;
      };

      expect(out.refused).toBe(true);
      expect(out.reason).toContain("FIFO");
      expect(out.reason).not.toContain("missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile names a directory reached through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, { "src/changed.ts": "export {};\n" });
      await mkdir(join(root, "docs"), { recursive: true });
      await symlink(join(root, "docs"), join(root, "docs-link"));

      const workspace = mockWorkspace(root, ["src/changed.ts", "docs-link"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "docs-link" })) as {
        refused?: boolean;
        reason?: string;
      };

      expect(out.refused).toBe(true);
      expect(out.reason).toContain("directory");
      expect(out.reason).not.toContain("missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile names a FIFO reached through an innocent-looking symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, { "src/changed.ts": "export {};\n" });
      await mkdir(join(root, "logs"), { recursive: true });
      await exec("mkfifo", [join(root, "logs", "live.pipe")]);
      await symlink(join(root, "logs", "live.pipe"), join(root, "logs", "innocent.txt"));

      const workspace = mockWorkspace(root, ["src/changed.ts", "logs/innocent.txt"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "logs/innocent.txt" })) as {
        refused?: boolean;
        reason?: string;
      };

      expect(out.refused).toBe(true);
      expect(out.reason).toContain("FIFO");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const HOSTILE_NAME = "Meeting\u202fnotes\u2019 re\u0301sume\u0301 3.04\u202fPM.txt";
  const CLEAN_NAME = "Meeting notes\u2019 r\u00e9sum\u00e9 3.04 PM.txt";

  it("readWorkspaceFile names a socket instead of reporting it missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    const server = createServer();
    try {
      await writeWorkspaceFiles(root, { "src/changed.ts": "export {};\n" });
      await mkdir(join(root, "logs"), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(root, "logs", "agent.sock"), resolve);
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "logs/agent.sock"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "logs/agent.sock" })) as {
        refused?: boolean;
        reason?: string;
      };

      expect(out.refused).toBe(true);
      expect(out.reason).toContain("socket");
    } finally {
      if (server.listening) server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile notes the repair but still refuses a too-large resolved twin", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const nfcPath = "docs/caf\u00e9.md";
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        [nfcPath]: "x".repeat(200),
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", nfcPath]);
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits({ maxFileBytes: 100 }),
        evidenceLedger,
        headSha: "deadbeef",
      });
      const out = (await executors.readWorkspaceFile?.({ path: "docs/caf\u0065\u0301.md" })) as {
        path: string;
        refused?: boolean;
        reason?: string;
        note?: string;
        content?: string;
      };

      expect(out.path).toBe(nfcPath);
      expect(out.refused).toBe(true);
      expect(out.reason).toBe("File exceeds 100 byte read limit.");
      expect(out.note).toContain("unicode-equivalent");
      expect(out.content).toBeUndefined();
      expect(evidenceLedger.snapshot()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile suggests a sibling at exactly the similarity threshold", async () => {
    // bigramDiceSimilarity("ci.yml", "cd.yml") is exactly 0.6, the configured minimum.
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        "cd.yml": "name: ci\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "cd.yml"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "ci.yml" })) as {
        refused?: boolean;
        similarPaths?: string[];
      };

      expect(out.refused).toBe(true);
      expect(out.similarPaths).toEqual(["cd.yml"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile caps similarPaths at five suggestions", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const siblings = [
        "config-a.ts",
        "config-b.ts",
        "config-c.ts",
        "config-d.ts",
        "config-e.ts",
        "config-f.ts",
        "config-g.ts",
        "config-h.ts",
        "config-i.ts",
      ];
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        ...Object.fromEntries(siblings.map((name) => [name, "export {};\n"])),
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", ...siblings]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "config.ts" })) as {
        refused?: boolean;
        similarPaths?: string[];
      };

      expect(out.refused).toBe(true);
      expect(out.similarPaths).toHaveLength(5);
      expect(out.similarPaths).toContain("config-g.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile repairs a unicode-equivalent filename and records evidence under the resolved path", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const hostilePath = `notes/${HOSTILE_NAME}`;
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        [hostilePath]: "- rotate the keys\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", hostilePath]);
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits(),
        evidenceLedger,
        headSha: "deadbeef",
      });
      const out = (await executors.readWorkspaceFile?.({ path: `notes/${CLEAN_NAME}` })) as {
        path: string;
        content?: string;
        note?: string;
      };

      expect(out.path).toBe(hostilePath);
      expect(out.content).toContain("rotate the keys");
      expect(out.note).toContain("unicode-equivalent");
      expect(evidenceLedger.covers(hostilePath, 1, 1)).toBe(true);
      expect(evidenceLedger.covers(`notes/${CLEAN_NAME}`, 1, 1)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile adds no repair note for the exact on-disk spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const hostilePath = `notes/${HOSTILE_NAME}`;
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        [hostilePath]: "- rotate the keys\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", hostilePath]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: hostilePath })) as {
        content?: string;
        note?: string;
      };

      expect(out.content).toContain("rotate the keys");
      expect(out.note).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile refuses to guess between homoglyph twins", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        "a\u2019b.txt": "curly\n",
        "a'b.txt": "straight\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "a\u2019b.txt", "a'b.txt"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      // Left single quote canonicalizes to the same spelling as both twins.
      const out = (await executors.readWorkspaceFile?.({ path: "a\u2018b.txt" })) as {
        refused?: boolean;
        note?: string;
      };

      expect(out.refused).toBe(true);
      expect(out.note ?? "").not.toContain("unicode-equivalent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile suggests but does not repair a visibly different spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const hostilePath = `notes/${HOSTILE_NAME}`;
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        [hostilePath]: "- rotate the keys\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", hostilePath]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({
        path: "notes/Meeting notes' resume 3.04 PM.txt",
      })) as {
        refused?: boolean;
        note?: string;
        similarPaths?: string[];
      };

      expect(out.refused).toBe(true);
      expect(out.note ?? "").not.toContain("unicode-equivalent");
      expect(out.similarPaths).toEqual([hostilePath]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile suggests AGENTS.md for AGENT.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        "AGENTS.md": "npm run build:prod\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "AGENTS.md"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "AGENT.md" })) as {
        refused?: boolean;
        similarPaths?: string[];
      };

      expect(out.refused).toBe(true);
      expect(out.similarPaths).toEqual(["AGENTS.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile offers no suggestions for an unrelated name", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        "AGENTS.md": "npm run build:prod\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "AGENTS.md"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "zzz_qqq.bin" })) as {
        refused?: boolean;
        similarPaths?: string[];
      };

      expect(out.refused).toBe(true);
      expect(out.similarPaths).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile keeps gated sensitive paths out of similarPaths", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        "config/keys.pem": "KEY\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "config/keys.pem"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({ path: "config/keys.pub" })) as {
        refused?: boolean;
        similarPaths?: string[];
      };

      expect(out.refused).toBe(true);
      expect(out.similarPaths).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile notes an empty file and records no evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        "src/empty.ts": "",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/empty.ts"]);
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits(),
        evidenceLedger,
        headSha: "deadbeef",
      });
      const out = (await executors.readWorkspaceFile?.({ path: "src/empty.ts" })) as {
        content?: string;
        note?: string;
        refused?: boolean;
      };

      expect(out.content).toBe("");
      expect(out.note).toBe("File is empty (0 bytes).");
      expect(out.refused).toBeUndefined();
      expect(evidenceLedger.snapshot()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile notes a startLine beyond end of file and records no evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        "src/window.ts": "a\nb\nc\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/window.ts"]);
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: testLimits(),
        evidenceLedger,
        headSha: "deadbeef",
      });
      const out = (await executors.readWorkspaceFile?.({
        path: "src/window.ts",
        startLine: 900,
        maxLines: 50,
      })) as {
        content?: string;
        note?: string;
        truncated?: boolean;
      };

      expect(out.content).toBe("");
      expect(out.note).toContain("beyond the end of the file (3 lines total)");
      expect(out.note).toContain("startLine <= 3");
      expect(out.truncated).toBe(false);
      expect(evidenceLedger.snapshot()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("getWorkspaceBlame names a FIFO instead of reporting it missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, { "src/changed.ts": "export {};\n" });
      await mkdir(join(root, "logs"), { recursive: true });
      await exec("mkfifo", [join(root, "logs", "live.pipe")]);

      const workspace = mockWorkspace(root, ["src/changed.ts", "logs/live.pipe"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.getWorkspaceBlame?.({ path: "logs/live.pipe" })) as {
        refused?: boolean;
        reason?: string;
        blame?: string | null;
      };

      expect(out.refused).toBe(true);
      expect(out.reason).toContain("FIFO");
      expect(out.blame).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile still reads when startLine equals the last line", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export {};\n",
        "src/window.ts": "a\nb\nc\n",
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/window.ts"]);
      const { executors } = buildLocalWorkspaceTools(workspace, { limits: testLimits() });
      const out = (await executors.readWorkspaceFile?.({
        path: "src/window.ts",
        startLine: 3,
        maxLines: 10,
      })) as {
        content?: string;
        startLine?: number;
        endLine?: number;
        note?: string;
      };

      expect(out.content).toBe("c");
      expect(out.startLine).toBe(3);
      expect(out.endLine).toBe(3);
      expect(out.note).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
