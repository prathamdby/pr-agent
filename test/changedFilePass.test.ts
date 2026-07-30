import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEvidenceLedger } from "../src/review/findings/evidenceLedger.js";
import { runChangedFilePass } from "../src/review/orchestrator/changedFilePass.js";
import type { LocalPrWorkspace } from "../src/prWorkspace/index.js";
import { buildCheckoutCoverage } from "../src/prWorkspace/localPrWorkspace.js";

function workspaceAt(
  agentCwd: string,
  files: readonly { readonly path: string; readonly status?: "modified" | "deleted" | "added" }[],
): LocalPrWorkspace {
  const changedFiles = files.map((file) => ({
    path: file.path,
    status: file.status ?? ("modified" as const),
  }));
  const checkoutPaths = new Set(
    changedFiles.filter((file) => file.status !== "deleted").map((file) => file.path),
  );
  return {
    rootDir: agentCwd,
    privateGitDir: join(agentCwd, ".git"),
    agentCwd,
    changedFiles,
    changedFileByPath: new Map(changedFiles.map((file) => [file.path, file])),
    checkoutPaths,
    sortedCheckoutPaths: [...checkoutPaths].toSorted(),
    checkoutMode: "full",
    diffIndex: { files: new Map(), truncated: false, listPullRequestFilesIngested: false },
    stats: { truncated: false, totalChanges: files.length, fileCount: files.length },
    grepLiteral: async () => ({ matches: [], truncated: false }),
    getDiffForPath: async () => "",
    getBlameForPath: async () => "",
    isPathInCheckout: (path) => checkoutPaths.has(path),
    getCoverage: () =>
      buildCheckoutCoverage({
        checkoutMode: "full",
        checkoutPaths,
        changedFiles,
        stats: { truncated: false },
      }),
    noteSearchTruncated: () => undefined,
    lookupSymbol: () => [],
    getSymbolIndexStatus: () => ({ available: false }),
    cleanup: async () => undefined,
  };
}

describe("runChangedFilePass", () => {
  it("records every readable changed path into the evidence ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "file-pass-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "README.md"), "# docs\n");

    const headSha = "a".repeat(40);
    const ledger = createEvidenceLedger(headSha);
    const result = await runChangedFilePass({
      workspace: workspaceAt(dir, [{ path: "src/a.ts" }, { path: "README.md" }]),
      evidenceLedger: ledger,
      headSha,
      shouldContinue: () => true,
    });

    expect(result.stoppedForBudget).toBe(false);
    expect(result.inspectedPathCount).toBe(2);
    expect(result.unreadPaths).toEqual([]);
    const paths = ledger.snapshot().map((read) => read.path).toSorted();
    expect(paths).toEqual(["README.md", "src/a.ts"]);
    expect(ledger.snapshot().every((read) => read.tool === "server_changed_file_pass")).toBe(true);
  });

  it("records bounded receipts for missing and deleted paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "file-pass-bound-"));
    const headSha = "b".repeat(40);
    const ledger = createEvidenceLedger(headSha);
    const result = await runChangedFilePass({
      workspace: workspaceAt(dir, [
        { path: "gone.ts", status: "deleted" },
        { path: "missing.ts", status: "modified" },
      ]),
      evidenceLedger: ledger,
      headSha,
      shouldContinue: () => true,
    });

    expect(result.inspectedPathCount).toBe(2);
    expect(result.boundedFailures.map((item) => item.reason).toSorted()).toEqual([
      "deleted",
      "missing from checkout",
    ]);
    expect(ledger.snapshot().map((read) => read.path).toSorted()).toEqual([
      "gone.ts",
      "missing.ts",
    ]);
  });

  it("stops mid-pass when the budget gate closes and leaves unread paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "file-pass-budget-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "a\n");
    await writeFile(join(dir, "src", "b.ts"), "b\n");
    await writeFile(join(dir, "src", "c.ts"), "c\n");

    const headSha = "c".repeat(40);
    const ledger = createEvidenceLedger(headSha);
    let remaining = 1;
    const result = await runChangedFilePass({
      workspace: workspaceAt(dir, [
        { path: "src/a.ts" },
        { path: "src/b.ts" },
        { path: "src/c.ts" },
      ]),
      evidenceLedger: ledger,
      headSha,
      shouldContinue: () => {
        if (remaining <= 0) return false;
        remaining -= 1;
        return true;
      },
    });

    expect(result.stoppedForBudget).toBe(true);
    expect(result.inspectedPathCount).toBe(1);
    expect(result.unreadPaths).toEqual(["src/b.ts", "src/c.ts"]);
    expect(ledger.snapshot()).toHaveLength(1);
    expect(ledger.snapshot()[0]?.path).toBe("src/a.ts");
  });

  it("records a bounded receipt when the file exceeds the byte cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "file-pass-cap-"));
    await writeFile(join(dir, "big.bin"), "x".repeat(100));
    const headSha = "d".repeat(40);
    const ledger = createEvidenceLedger(headSha);
    const result = await runChangedFilePass({
      workspace: workspaceAt(dir, [{ path: "big.bin" }]),
      evidenceLedger: ledger,
      headSha,
      maxFileBytes: 10,
      shouldContinue: () => true,
    });

    expect(result.inspectedPathCount).toBe(1);
    expect(result.boundedFailures[0]?.reason).toContain("byte read limit");
    expect(ledger.snapshot()).toHaveLength(1);
  });
});
