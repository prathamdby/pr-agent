import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { describe, expect, it, afterEach } from "vitest";
import {
  buildWorkspaceTools,
  type LocalWorkspaceToolLimits,
} from "../src/agent/tools/workspaceToolset.js";
import {
  disposeSpillFile,
  READ_SPILL_FILENAME_PREFIX,
} from "../src/agent/tools/readWorkspaceTextFile.js";
import { createAskPathGate } from "../src/agent/ask/askSafety.js";
import { createCachedPrDiffIndex } from "../src/review/placement/reviewDiffIndex.js";
import {
  type LocalPrWorkspace,
  prepareLocalPrWorkspace,
} from "../src/prWorkspace/localPrWorkspace.js";
import {
  buildCheckoutCoverage,
  gitGrepWorkspace,
  type GitGrepWorkspaceParams,
  isTriageSearchPathAllowed,
  createWritableRepositoryReader,
} from "../src/prWorkspace/repositoryReader.js";
import {
  LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE,
  LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
} from "../src/settings/index.js";
import { createTestEvidenceLedger } from "./helpers/evidenceTestHelpers.js";
import {
  buildSymbolIndex,
  querySymbolIndex,
  symbolIndexStatus,
} from "../src/prWorkspace/symbolIndex.js";
import {
  type ListPullRequestFilesResult,
  type PullRequestFileEntry,
} from "../src/github/listPullRequestFiles.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import {
  buildTriageWorkspaceTools,
  createTriageWorkspaceToolState,
} from "../src/agent/triage/triageWorkspaceTools.js";
import { type WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import { type BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";

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
    checkoutMode?: LocalPrWorkspace["reader"]["checkoutMode"];
    stats?: LocalPrWorkspace["reader"]["stats"];
    getDiffForPath?: (path: string) => Promise<string>;
    getBlameForPath?: (path: string) => Promise<string>;
    lookupSymbol?: LocalPrWorkspace["reader"]["lookupSymbol"];
    getSymbolIndexStatus?: LocalPrWorkspace["reader"]["getSymbolIndexStatus"];
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
    reader: {
      ...createWritableRepositoryReader(agentCwd),
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
    },
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
    const { piTools } = buildWorkspaceTools(mockWorkspace("/tmp", ["src/changed.ts"]).reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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

  it("readWorkspaceFile spills oversized reads to a session file with a tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const body = `${"x".repeat(200)}\n`.repeat(2_000);
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/large.ts": body,
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/large.ts"]);
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildWorkspaceTools(workspace.reader, {
        limits: testLimits({ maxFileBytes: 1_000_000 }),
        evidenceLedger,
        headSha: "deadbeef",
        spillScope: { workItemId: "wi-spill", toolCall: "readWorkspaceFile" },
      });
      const out = (await executors.readWorkspaceFile?.({ path: "src/large.ts" })) as {
        spilled: boolean;
        spillPath: string;
        size: number;
        tail: string;
        truncated: boolean;
        note: string;
      };

      expect(out.spilled).toBe(true);
      expect(out.truncated).toBe(true);
      expect(out.size).toBeGreaterThan(256_000);
      expect(out.tail.length).toBeGreaterThan(0);
      expect(out.note).toContain("not read evidence");
      // Spilled content is not read evidence: the ledger must stay empty even
      // though the tool ran against a ledger-backed workspace.
      expect(evidenceLedger.snapshot()).toHaveLength(0);
      // Spill filenames carry the owned prefix so a future tmp sweeper can
      // recognize them; disposeSpillFile removes exactly this file.
      expect(basename(out.spillPath).startsWith(READ_SPILL_FILENAME_PREFIX)).toBe(true);
      await disposeSpillFile(out.spillPath);
      await expect(access(out.spillPath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readWorkspaceFile returns a fitting line window inline with evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const body = `${"y".repeat(200)}\n`.repeat(2_000);
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/large.ts": body,
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/large.ts"]);
      const evidenceLedger = createTestEvidenceLedger("deadbeef");
      const { executors } = buildWorkspaceTools(workspace.reader, {
        limits: testLimits({ maxFileBytes: 1_000_000 }),
        evidenceLedger,
        headSha: "deadbeef",
        spillScope: { workItemId: "wi-spill", toolCall: "readWorkspaceFile" },
      });
      const out = (await executors.readWorkspaceFile?.({
        path: "src/large.ts",
        startLine: 10,
        maxLines: 5,
      })) as {
        spilled?: boolean;
        content: string;
        startLine: number;
        endLine: number;
        truncated: boolean;
      };

      expect(out.spilled).toBeUndefined();
      expect(out.truncated).toBe(true);
      expect(out.startLine).toBe(10);
      expect(out.endLine).toBe(14);
      expect(out.content.length).toBeGreaterThan(0);
      expect(evidenceLedger.covers("src/large.ts", 10, 14)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("disposeSpillFile ignores non-spill paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const keepPath = join(root, "keep.txt");
      await writeFile(keepPath, "do not delete");
      await disposeSpillFile(keepPath);
      await disposeSpillFile(join(root, "missing.txt"));
      const content = await readFile(keepPath, "utf8");
      expect(content).toBe("do not delete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("disposeSpillFiles returns failed paths instead of re-queuing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-tools-"));
    try {
      const body = `${"x".repeat(200)}\n`.repeat(2_000);
      await writeWorkspaceFiles(root, {
        "src/changed.ts": "export const changed = true;\n",
        "src/large-a.ts": body,
        "src/large-b.ts": body,
      });

      const workspace = mockWorkspace(root, ["src/changed.ts", "src/large-a.ts", "src/large-b.ts"]);
      const { executors, disposeSpillFiles } = buildWorkspaceTools(workspace.reader, {
        limits: testLimits({ maxFileBytes: 1_000_000 }),
        headSha: "deadbeef",
        spillScope: { workItemId: "wi-spill", toolCall: "readWorkspaceFile" },
      });
      const outA = (await executors.readWorkspaceFile?.({ path: "src/large-a.ts" })) as {
        spilled: boolean;
        spillPath: string;
      };
      const outB = (await executors.readWorkspaceFile?.({ path: "src/large-b.ts" })) as {
        spilled: boolean;
        spillPath: string;
      };
      expect(outA.spilled).toBe(true);
      expect(outB.spilled).toBe(true);

      // Sabotage one spill: a non-empty directory at the spill path makes
      // rm(force:true) reject with ERR_FS_EISDIR while keeping the path live.
      await rm(outA.spillPath, { force: true });
      await mkdir(outA.spillPath);
      await writeFile(join(outA.spillPath, "child.txt"), "blocked");

      // Resolves with the failed path reported; the good spill is still deleted.
      expect(await disposeSpillFiles()).toEqual([outA.spillPath]);
      await expect(access(outB.spillPath)).rejects.toThrow();
      await expect(access(outA.spillPath)).resolves.toBeUndefined();

      // Nothing left tracked: a second dispose reports no failures.
      await rm(outA.spillPath, { recursive: true, force: true });
      expect(await disposeSpillFiles()).toEqual([]);
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });

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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
        reader: {
          ...base.reader,
          grepLiteral: async (params) => {
            seen.push(params);
            return base.reader.grepLiteral(params);
          },
        },
      };
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
      const out = (await executors.searchWorkspace?.({ query: "needle" })) as {
        matches: Array<{ path: string }>;
        truncated: boolean;
        pathsSearched: number;
        filesScanned: number;
      };

      expect(out.matches.map((match) => match.path).toSorted()).toEqual(["src/a.ts", "src/b.ts"]);
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });

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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
    const { piTools } = buildWorkspaceTools(mockWorkspace("/tmp", ["src/changed.ts"]).reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, {
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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
      const { executors } = buildWorkspaceTools(workspace.reader, { limits: testLimits() });
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

{
  const exec = promisify(execFile);
  const WORKSPACE_TEST_TIMEOUT_MS = 20_000;

  const APP_PATCH = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1,2 @@",
    " export {};",
    "+export const needle = 1;",
  ].join("\n");

  const GONE_PATCH = [
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const removed = true;",
  ].join("\n");

  type SetupOptions = {
    readonly deletedFiles?: Readonly<Record<string, string>>;
    readonly patches?: Readonly<Record<string, string>>;
    readonly omittedPatchPaths?: readonly string[];
    readonly absentPatchPaths?: readonly string[];
  };

  async function writeTree(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
  }

  function prFileEntry(
    path: string,
    status: string,
    options: SetupOptions,
  ): PullRequestFileEntry | null {
    const omitted = options.omittedPatchPaths?.includes(path) === true;
    const absent = options.absentPatchPaths?.includes(path) === true;
    const patch = options.patches?.[path];
    if (patch == null && !omitted && !absent && status !== "removed") return null;
    return {
      filename: path,
      status,
      additions: status === "removed" ? 0 : 1,
      deletions: status === "removed" ? 1 : 0,
      changes: 1,
      ...(omitted ? { patchOmitted: true } : {}),
      ...(patch != null && !omitted ? { patch } : {}),
    };
  }

  describe("buildWorkspaceTools", { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
    const sources: string[] = [];
    const workspaces: LocalPrWorkspace[] = [];

    afterEach(async () => {
      await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
      await Promise.all(
        sources.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    async function setup(files: Readonly<Record<string, string>>, options: SetupOptions = {}) {
      const root = await mkdtemp(join(tmpdir(), "verification-ws-tools-"));
      sources.push(root);
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      await exec("git", ["init", repo]);
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Test"], { cwd: repo });
      await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repo });

      const deletedFiles = options.deletedFiles ?? {};
      if (Object.keys(deletedFiles).length > 0) {
        await writeTree(repo, { ...files, ...deletedFiles });
        await exec("git", ["add", "."], { cwd: repo });
        await exec("git", ["commit", "-m", "base"], { cwd: repo });
        for (const path of Object.keys(deletedFiles)) {
          await exec("git", ["rm", "-f", "--", path], { cwd: repo });
        }
        await writeTree(repo, files);
        await exec("git", ["add", "-A"], { cwd: repo });
        await exec("git", ["commit", "-m", "head"], { cwd: repo });
      } else {
        await writeTree(repo, files);
        await exec("git", ["add", "."], { cwd: repo });
        await exec("git", ["commit", "-m", "head"], { cwd: repo });
      }

      const headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await exec("git", ["init", "--bare", remote]);
      await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
      await exec("git", ["push", "origin", "HEAD:refs/pull/1/head"], { cwd: repo });

      const prFilesList: PullRequestFileEntry[] = [];
      for (const path of Object.keys(files)) {
        const entry = prFileEntry(path, "modified", options);
        if (entry) prFilesList.push(entry);
      }
      for (const path of Object.keys(deletedFiles)) {
        const entry = prFileEntry(path, "removed", options);
        if (entry) prFilesList.push(entry);
      }
      const prFiles: ListPullRequestFilesResult = {
        files: prFilesList,
        truncated: false,
        omittedCountLowerBound: 0,
        totalChanges: prFilesList.length,
        headSha,
      };

      const workspace = await prepareLocalPrWorkspace({
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        headSha,
        installationToken: "unused",
        prFiles,
        remoteUrlOverride: remote,
      });
      workspaces.push(workspace);
      const { executors } = buildWorkspaceTools({
        profile: "verification",
        reader: workspace.reader,
      });
      return { root, repo, workspace, executors };
    }

    describe("readWorkspaceFile", () => {
      it("caps oversized reads at the shared response budget with a resume offset", async () => {
        const bigFile = ("x".repeat(1_000) + "\n").repeat(400);
        const { executors } = await setup({ "src/big.txt": bigFile });

        const out = (await executors.readWorkspaceFile({ path: "src/big.txt" })) as {
          truncated?: boolean;
          truncationReason?: string;
          resumeStartLine?: number;
          endLine?: number;
          returnedBytes?: number;
        };

        expect(out.truncated).toBe(true);
        expect(out.truncationReason).toBe("response byte budget exceeded");
        expect(out.returnedBytes).toBeLessThanOrEqual(LOCAL_WORKSPACE_READ_RESPONSE_BYTES);
        expect(out.endLine).toBeGreaterThan(1);
        expect(out.resumeStartLine).toBe(out.endLine);
      });

      it("supports line-window reads like every other feature", async () => {
        const { executors } = await setup({ "src/app.ts": "a\nb\nc\nd\n" });

        const out = (await executors.readWorkspaceFile({
          path: "src/app.ts",
          startLine: 2,
          maxLines: 2,
        })) as {
          content?: string;
          startLine?: number;
          endLine?: number;
          truncated?: boolean;
          resumeStartLine?: number;
          note?: string;
        };

        expect(out.content).toBe("b\nc");
        expect(out.startLine).toBe(2);
        expect(out.endLine).toBe(3);
        expect(out.truncated).toBe(true);
        expect(out.resumeStartLine).toBe(4);
        expect(out.note).toBe("Line window ended at line 3 of 4. Resume with startLine 4.");
      });
    });

    describe("searchWorkspace and getWorkspaceDiff", () => {
      it("records a Git version supported by the NUL-delimited literal grep", async () => {
        const { stdout } = await exec("git", ["--version"]);
        // Shared grep omits --max-count, preserving Git 2.39 compatibility.
        expect(stdout.trim()).toMatch(
          /^git version (?:2\.(?:(?:39|4[0-9])|[5-9]\d|\d{3,})|[3-9]|[1-9]\d)/,
        );
      });

      it("reads, searches, and returns the cached PR patch from a production workspace", async () => {
        const { workspace, executors } = await setup(
          { "src/app.ts": "export const needle = 1;\n" },
          { patches: { "src/app.ts": APP_PATCH } },
        );

        await expect(stat(join(workspace.agentCwd, ".git"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect((await stat(workspace.privateGitDir)).isDirectory()).toBe(true);
        expect(workspace.privateGitDir.startsWith(`${workspace.agentCwd}/`)).toBe(false);

        const read = (await executors.readWorkspaceFile({ path: "src/app.ts" })) as {
          content?: string;
        };
        expect(read.content).toBe("export const needle = 1;\n");

        const search = await executors.searchWorkspace({ query: "needle" });
        expect(search).toEqual({
          matches: [{ path: "src/app.ts", line: 1, text: "export const needle = 1;" }],
          truncated: false,
        });

        const diff = await executors.getWorkspaceDiff({ path: "src/app.ts" });
        expect(diff).toEqual({ path: "src/app.ts", diff: APP_PATCH });
      });

      it("returns empty matches when searchWorkspace finds nothing", async () => {
        const { executors } = await setup({ "src/app.ts": "const value = 1;\n" });
        const out = await executors.searchWorkspace({ query: "no-such-token-xyz" });
        expect(out).toEqual({ matches: [], truncated: false });
      });

      it("returns clean-path hits without a filtered marker", async () => {
        const { executors } = await setup({
          "src/safe-a.ts": "export const safeA = needle;\n",
          "src/safe-b.ts": "export const safeB = needle;\n",
        });

        const out = await executors.searchWorkspace({ query: "needle" });
        expect(out).toEqual({
          matches: [
            { path: "src/safe-a.ts", line: 1, text: "export const safeA = needle;" },
            { path: "src/safe-b.ts", line: 1, text: "export const safeB = needle;" },
          ],
          truncated: false,
        });
      });

      it("filters blocked paths before applying the result cap", async () => {
        const blockedText = "verify-private-value-540";
        const { executors } = await setup({
          ".env": `TOKEN=${blockedText} needle\n`,
          ".npmrc": `//registry.example/:_authToken=${blockedText} needle\n`,
          ".aws/credentials": `[default]\naws_secret_access_key=${blockedText} needle\n`,
          "certs/signing.pem": `-----BEGIN PRIVATE KEY----- ${blockedText} needle\n`,
          ".github/workflows/ci.yml": `name: ${blockedText} needle\n`,
          "src/safe-a.ts": "export const safeA = needle;\n",
          "src/safe-b.ts": "export const safeB = needle;\n",
          "src/safe-c.ts": "export const safeC = needle;\n",
        });

        const out = (await executors.searchWorkspace({ query: "needle", maxResults: 2 })) as {
          matches: Array<{ path: string; line: number; text: string }>;
          truncated: boolean;
          filtered?: boolean;
        };

        expect(out).toEqual({
          matches: [
            { path: "src/safe-a.ts", line: 1, text: "export const safeA = needle;" },
            { path: "src/safe-b.ts", line: 1, text: "export const safeB = needle;" },
          ],
          truncated: true,
          filtered: true,
        });
        expect(JSON.stringify(out)).not.toContain(blockedText);
        expect(JSON.stringify(out)).not.toContain(".env");
        expect(JSON.stringify(out)).not.toContain(".npmrc");
      });

      it("strips source symlinks and withholds blocked checkout paths", async () => {
        const root = await mkdtemp(join(tmpdir(), "verification-ws-symlink-"));
        sources.push(root);
        const repo = join(root, "repo");
        const remote = join(root, "remote.git");
        await exec("git", ["init", repo]);
        await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
        await exec("git", ["config", "user.name", "Test"], { cwd: repo });
        await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
        await writeTree(repo, {
          ".env": "TOKEN=verify-private-value-540\n",
          "src/safe.ts": "export const safe = true;\n",
        });
        await mkdir(join(repo, "docs"), { recursive: true });
        await symlink("../.env", join(repo, "docs", "config.ts"));
        await exec("git", ["add", "."], { cwd: repo });
        await exec("git", ["commit", "-m", "head"], { cwd: repo });
        const headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
        await exec("git", ["init", "--bare", remote]);
        await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
        await exec("git", ["push", "origin", "HEAD:refs/pull/1/head"], { cwd: repo });

        const workspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles: {
            files: [],
            truncated: false,
            omittedCountLowerBound: 0,
            totalChanges: 0,
            headSha,
          },
          remoteUrlOverride: remote,
        });
        workspaces.push(workspace);
        const { executors } = buildWorkspaceTools({
          profile: "verification",
          reader: workspace.reader,
        });

        await expect(stat(join(workspace.agentCwd, "docs", "config.ts"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(isTriageSearchPathAllowed(workspace.agentCwd, "././.env")).resolves.toBe(
          false,
        );
        await expect(isTriageSearchPathAllowed(workspace.agentCwd, "src/safe.ts")).resolves.toBe(
          true,
        );
        await expect(executors.searchWorkspace({ query: "TOKEN" })).resolves.toEqual({
          matches: [],
          truncated: false,
          filtered: true,
        });
        await expect(executors.searchWorkspace({ query: "safe" })).resolves.toEqual({
          matches: [{ path: "src/safe.ts", line: 1, text: "export const safe = true;" }],
          truncated: false,
          filtered: true,
        });
      });

      it("withholds key-extension and control-path hits", async () => {
        const blockedText = "verify-private-value-540";
        const { executors } = await setup({
          "certs/server.key": `secret=${blockedText}\n`,
          "package.json": `{"name":"${blockedText}"}\n`,
          "src/key-utils.ts": "export const helper = true;\n",
        });

        const secretOut = (await executors.searchWorkspace({ query: blockedText })) as {
          matches: unknown[];
          truncated?: boolean;
          filtered?: boolean;
        };
        expect(secretOut.matches).toEqual([]);
        expect(secretOut.truncated).toBe(false);
        expect(secretOut.filtered).toBe(true);
        expect(JSON.stringify(secretOut)).not.toContain(blockedText);

        const cleanOut = await executors.searchWorkspace({ query: "helper" });
        expect(cleanOut).toEqual({
          matches: [{ path: "src/key-utils.ts", line: 1, text: "export const helper = true;" }],
          truncated: false,
          filtered: true,
        });
      });

      it("matches literal punctuation and unusual filenames", async () => {
        const { executors } = await setup({
          "src/colon:name.ts": "export const token = 'a.b*c';\n",
        });

        const out = await executors.searchWorkspace({ query: "a.b*c" });
        expect(out).toEqual({
          matches: [{ path: "src/colon:name.ts", line: 1, text: "export const token = 'a.b*c';" }],
          truncated: false,
        });
      });

      it("returns a deleted path's cached PR patch without requiring the file at head", async () => {
        const { workspace, executors } = await setup(
          { "src/app.ts": "export {};\n" },
          {
            deletedFiles: { "src/gone.ts": "export const removed = true;\n" },
            patches: { "src/gone.ts": GONE_PATCH },
          },
        );

        await expect(stat(join(workspace.agentCwd, "src", "gone.ts"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(executors.getWorkspaceDiff({ path: "src/gone.ts" })).resolves.toEqual({
          path: "src/gone.ts",
          diff: GONE_PATCH,
        });
      });

      it("returns an omitted-patch notice and an empty string for an absent patch", async () => {
        const { executors } = await setup(
          {
            "src/omitted.ts": "export const omitted = true;\n",
            "src/absent.ts": "export const absent = true;\n",
          },
          {
            omittedPatchPaths: ["src/omitted.ts"],
            absentPatchPaths: ["src/absent.ts"],
          },
        );

        await expect(executors.getWorkspaceDiff({ path: "src/omitted.ts" })).resolves.toEqual({
          path: "src/omitted.ts",
          diff: "[patch omitted: exceeds configured PR patch byte cap]",
        });
        await expect(executors.getWorkspaceDiff({ path: "src/absent.ts" })).resolves.toEqual({
          path: "src/absent.ts",
          diff: "",
        });
      });

      it("forwards workspace search truncation and the shared byte cap", async () => {
        const root = await mkdtemp(join(tmpdir(), "verification-ws-budget-"));
        sources.push(root);
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/app.ts"), "export const needle = 1;\n");
        let seenBytes: number | undefined;
        const workspace = {
          ...mockLocalPrWorkspace(root, { checkoutPaths: new Set(["src/app.ts"]) }),
          reader: {
            ...mockLocalPrWorkspace(root, { checkoutPaths: new Set(["src/app.ts"]) }).reader,
            grepLiteral: async (params: { readonly maxOutputBytes?: number }) => {
              seenBytes = params.maxOutputBytes;
              return {
                matches: [{ path: "src/app.ts", line: 1, text: "export const needle = 1;" }],
                truncated: true,
              };
            },
          },
        };
        const { executors } = buildWorkspaceTools({
          profile: "verification",
          reader: workspace.reader,
        });

        const out = await executors.searchWorkspace({ query: "needle" });
        expect(seenBytes).toBe(LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES);
        expect(out).toEqual({
          matches: [{ path: "src/app.ts", line: 1, text: "export const needle = 1;" }],
          truncated: true,
        });
      });
    });
  });
}

{
  const exec = promisify(execFile);

  function findingThread(overrides: Partial<BotFindingThread> = {}): BotFindingThread {
    return {
      rootCommentId: 101,
      lens: "review",
      path: "src/app.ts",
      line: 1,
      severity: "P1",
      titleSnippet: "P1 · bug",
      humanReplies: [],
      threadUrl: "https://example.test/thread/101",
      ...overrides,
    };
  }

  function mockCheckout(
    dir: string,
    commitImpl?: WritablePrCheckout["commit"],
  ): WritablePrCheckout {
    return {
      dir,
      reader: createWritableRepositoryReader(dir),
      headRef: "feature",
      baseSha: "a".repeat(40),
      commit:
        commitImpl ??
        (async ({ files, subject }) => ({
          sha: "b".repeat(40),
          diff: `diff for ${files.join(",")} (${subject})`,
        })),
      push: async () => {},
      listCommittedShas: () => [],
      listCommittedDetails: () => [],
    };
  }

  async function initCheckout(files: Readonly<Record<string, string>>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "triage-ws-tools-"));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-m", "seed"], { cwd: root });
    return root;
  }

  describe("triage read profile", () => {
    const roots: string[] = [];

    afterEach(async () => {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function setup(params?: {
      files?: Readonly<Record<string, string>>;
      inventory?: readonly BotFindingThread[];
      commit?: WritablePrCheckout["commit"];
    }) {
      const root = await initCheckout(
        params?.files ?? {
          "src/app.ts": "const value = 1;\n",
          "package.json": '{"name":"app"}\n',
        },
      );
      roots.push(root);
      const inventory = params?.inventory ?? [findingThread()];
      const state = createTriageWorkspaceToolState();
      const { executors } = buildTriageWorkspaceTools({
        cfg: makeTestConfig(),
        checkout: mockCheckout(root, params?.commit),
        inventory,
        state,
      });
      return { root, executors, state, inventory };
    }

    it("bounds triage grep at the shared byte cap and reports incomplete output", async () => {
      const { executors } = await setup({
        files: {
          "src/app.ts": ("needle " + "x".repeat(1000) + "\n").repeat(
            Math.ceil(LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES / 1000) + 100,
          ),
        },
      });
      const out = await executors.searchWorkspace({ query: "needle", maxResults: 100_000 });
      expect(out).toMatchObject({ truncated: true });
      expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(
        LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES * 2,
      );
    });

    it("searches literal punctuation in colon-containing paths without dropping hits", async () => {
      const { executors } = await setup({ files: { "src/colon:name.ts": "a.b*c\n" } });
      await expect(executors.searchWorkspace({ query: "a.b*c" })).resolves.toEqual({
        matches: [{ path: "src/colon:name.ts", line: 1, text: "a.b*c" }],
        truncated: false,
      });
    });

    it("blocks read of control-plane paths", async () => {
      const { executors } = await setup();
      await expect(executors.readWorkspaceFile({ path: "package.json" })).rejects.toMatchObject({
        code: "triage.sensitive_path_blocked",
      });
    });

    it("caps oversized reads at the shared response budget with a resume offset", async () => {
      // Lines stay under the per-line clamp so the byte budget is what fires.
      const bigFile = ("x".repeat(1_000) + "\n").repeat(400);
      const { executors } = await setup({ files: { "src/app.ts": bigFile } });

      const out = (await executors.readWorkspaceFile({ path: "src/app.ts" })) as {
        truncated?: boolean;
        truncationReason?: string;
        resumeStartLine?: number;
        endLine?: number;
        returnedBytes?: number;
      };

      expect(out.truncated).toBe(true);
      expect(out.truncationReason).toBe("response byte budget exceeded");
      expect(out.returnedBytes).toBeLessThanOrEqual(LOCAL_WORKSPACE_READ_RESPONSE_BYTES);
      // A byte-cap cut lands mid-line, so the next read resumes on that line.
      expect(out.endLine).toBeGreaterThan(1);
      expect(out.resumeStartLine).toBe(out.endLine);
    });

    it("supports line-window reads like every other feature", async () => {
      const { executors } = await setup({ files: { "src/app.ts": "a\nb\nc\nd\n" } });

      const out = (await executors.readWorkspaceFile({
        path: "src/app.ts",
        startLine: 2,
        maxLines: 2,
      })) as {
        content?: string;
        startLine?: number;
        endLine?: number;
        truncated?: boolean;
        resumeStartLine?: number;
        note?: string;
      };

      expect(out.content).toBe("b\nc");
      expect(out.startLine).toBe(2);
      expect(out.endLine).toBe(3);
      expect(out.truncated).toBe(true);
      expect(out.resumeStartLine).toBe(4);
      expect(out.note).toBe("Line window ended at line 3 of 4. Resume with startLine 4.");
    });

    it("blocks read through absolute symlink escapes", async () => {
      const outside = await mkdtemp(join(tmpdir(), "triage-ws-outside-"));
      roots.push(outside);
      await writeFile(join(outside, "secret.env"), "TOKEN=leak\n");
      const root = await initCheckout({ "src/app.ts": "export {};\n" });
      roots.push(root);
      await mkdir(join(root, "docs"), { recursive: true });
      await symlink(join(outside, "secret.env"), join(root, "docs/notes.md"));

      const { executors } = buildTriageWorkspaceTools({
        cfg: makeTestConfig(),
        checkout: mockCheckout(root),
        inventory: [findingThread()],
        state: createTriageWorkspaceToolState(),
      });

      await expect(executors.readWorkspaceFile({ path: "docs/notes.md" })).rejects.toMatchObject({
        code: "pr_workspace.symlink_escape",
      });
    });

    it("returns empty matches when searchWorkspace finds nothing", async () => {
      const { executors } = await setup();
      const out = await executors.searchWorkspace({ query: "no-such-token-xyz" });
      expect(out).toEqual({ matches: [], truncated: false });
    });

    it("filters blocked paths before applying the result cap", async () => {
      const blockedText = "triage-private-value-475";
      const { executors } = await setup({
        files: {
          ".env": `TOKEN=${blockedText} needle\n`,
          ".npmrc": `//registry.example/:_authToken=${blockedText} needle\n`,
          ".aws/credentials": `[default]\naws_secret_access_key=${blockedText} needle\n`,
          "certs/signing.pem": `-----BEGIN PRIVATE KEY----- ${blockedText} needle\n`,
          ".github/workflows/ci.yml": `name: ${blockedText} needle\n`,
          "src/safe-a.ts": "export const safeA = needle;\n",
          "src/safe-b.ts": "export const safeB = needle;\n",
          "src/safe-c.ts": "export const safeC = needle;\n",
        },
      });

      const out = (await executors.searchWorkspace({ query: "needle", maxResults: 2 })) as {
        matches: Array<{ path: string; line: number; text: string }>;
        truncated: boolean;
        filtered?: boolean;
      };

      expect(out).toEqual({
        matches: [
          { path: "src/safe-a.ts", line: 1, text: "export const safeA = needle;" },
          { path: "src/safe-b.ts", line: 1, text: "export const safeB = needle;" },
        ],
        truncated: true,
        filtered: true,
      });
      expect(JSON.stringify(out)).not.toContain(blockedText);
      expect(JSON.stringify(out)).not.toContain(".env");
      expect(JSON.stringify(out)).not.toContain(".npmrc");
    });

    it("filters a symlink alias to a blocked target without exposing its text", async () => {
      const { root, executors } = await setup({
        files: {
          ".env": "TOKEN=triage-private-value-475\n",
          "src/safe.ts": "export const safe = true;\n",
        },
      });
      await mkdir(join(root, "docs"), { recursive: true });
      await symlink("../.env", join(root, "docs", "config.ts"));
      await exec("git", ["add", "docs/config.ts"], { cwd: root });
      await symlink("../.env.dangling", join(root, "docs", "broken.ts"));
      await exec("git", ["add", "docs/broken.ts"], { cwd: root });
      await exec("git", ["commit", "-m", "add symlink fixture"], { cwd: root });

      await expect(isTriageSearchPathAllowed(root, "docs/config.ts")).resolves.toBe(false);
      await expect(isTriageSearchPathAllowed(root, "././.env")).resolves.toBe(false);
      await expect(isTriageSearchPathAllowed(root, "src/safe.ts")).resolves.toBe(true);
      await expect(isTriageSearchPathAllowed(root, "././src/safe.ts")).resolves.toBe(true);
      await expect(isTriageSearchPathAllowed(root, "docs/broken.ts")).resolves.toBe(false);
      await expect(executors.searchWorkspace({ query: "../.env" })).resolves.toEqual({
        matches: [],
        truncated: false,
      });
      await expect(executors.searchWorkspace({ query: "../.env.dangling" })).resolves.toEqual({
        matches: [],
        truncated: false,
      });
    });
  });
}
