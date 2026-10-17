import { describe, expect, it } from "vitest";
import { recordMarshalledEvidence } from "../src/agent/execution/marshal.js";
import {
  createEvidenceLedger,
  hashNormalizedLineText,
  normalizeEvidencePath,
  unreadChangedFilesNote,
  unreadChangedPaths,
} from "../src/review/findings/evidenceLedger.js";

describe("evidenceLedger", () => {
  const headSha = "a".repeat(40);

  it("normalizes paths consistently with workspace tools", () => {
    expect(normalizeEvidencePath(".\\src\\a.ts")).toBe("src/a.ts");
    expect(normalizeEvidencePath("./src/a.ts")).toBe("src/a.ts");
  });

  it("covers inclusive line ranges on the same path and headSha", () => {
    const ledger = createEvidenceLedger(headSha);
    ledger.record({
      path: "src/a.ts",
      startLine: 5,
      endLine: 10,
      contentHash: hashNormalizedLineText("slice"),
      headSha,
      tool: "readWorkspaceFile",
    });

    expect(ledger.covers("src/a.ts", 6, 8)).toBe(true);
    expect(ledger.covers("src/a.ts", 5, 10)).toBe(true);
    expect(ledger.covers("src/a.ts", 4, 8)).toBe(false);
    expect(ledger.covers("src/a.ts", 6, 11)).toBe(false);
    expect(ledger.covers("src/b.ts", 6, 8)).toBe(false);
  });

  it("rejects coverage when headSha mismatches", () => {
    const ledger = createEvidenceLedger(headSha);
    ledger.record({
      path: "src/a.ts",
      startLine: 1,
      endLine: 3,
      contentHash: hashNormalizedLineText("slice"),
      headSha,
      tool: "readWorkspaceFile",
    });

    const otherLedger = createEvidenceLedger("b".repeat(40));
    otherLedger.record({
      path: "src/a.ts",
      startLine: 1,
      endLine: 3,
      contentHash: hashNormalizedLineText("slice"),
      headSha: "b".repeat(40),
      tool: "readWorkspaceFile",
    });

    expect(ledger.covers("src/a.ts", 2, 2)).toBe(true);
    expect(otherLedger.covers("src/a.ts", 2, 2)).toBe(true);
    expect(ledger.snapshot()).toHaveLength(1);
    expect(ledger.snapshot()[0]?.headSha).toBe(headSha);
  });

  it("returns an immutable snapshot of recorded reads", () => {
    const ledger = createEvidenceLedger(headSha);
    ledger.record({
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      contentHash: hashNormalizedLineText("x"),
      headSha,
      tool: "readWorkspaceFile",
    });

    const snapshot = ledger.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.tool).toBe("readWorkspaceFile");
  });

  it("treats an in-checkout changed file as unread until a path is opened", () => {
    const ledger = createEvidenceLedger(headSha);
    const changedFiles = [
      { path: "src/a.ts", status: "modified" },
      { path: "src/gone.ts", status: "deleted" },
      { path: "src/missing.ts", status: "modified" },
    ];
    const isPathInCheckout = (path: string) => path !== "src/missing.ts";
    expect(unreadChangedPaths({ ledger, changedFiles, isPathInCheckout })).toEqual(["src/a.ts"]);
    ledger.noteOpened("src/a.ts");
    expect(unreadChangedPaths({ ledger, changedFiles, isPathInCheckout })).toEqual([]);
  });

  it("treats a dot-slash open as the normalized changed path", () => {
    const ledger = createEvidenceLedger(headSha);
    ledger.noteOpened("./src/a.ts");
    expect(
      unreadChangedPaths({
        ledger,
        changedFiles: [{ path: "src/a.ts", status: "modified" }],
        isPathInCheckout: () => true,
      }),
    ).toEqual([]);
    expect(normalizeEvidencePath("./src/a.ts")).toBe("src/a.ts");
  });

  it("names the first three unread files and counts the rest", () => {
    expect(unreadChangedFilesNote(["a.ts", "b.ts", "c.ts", "d.ts"])).toBe(
      "Unread changed files: a.ts, b.ts, c.ts (+1 more).",
    );
  });

  it("counts a deletion-only diff and an emptied file as opened", () => {
    const ledger = createEvidenceLedger(headSha);
    recordMarshalledEvidence(
      { path: "src/a.ts", diff: "@@ -1,1 +1,0 @@\n-old\n" },
      { tool: "getWorkspaceDiff", ledger, headSha },
    );
    recordMarshalledEvidence(
      { path: "src/empty.ts", content: "" },
      { tool: "readWorkspaceFile", ledger, headSha },
    );
    expect(ledger.hasOpened("src/a.ts")).toBe(true);
    expect(ledger.hasOpened("src/empty.ts")).toBe(true);
    expect(ledger.covers("src/a.ts", 1, 1)).toBe(false);
  });
});
