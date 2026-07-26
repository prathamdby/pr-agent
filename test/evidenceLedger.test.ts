import { describe, expect, it } from "vitest";
import {
  createEvidenceLedger,
  hashNormalizedLineText,
  normalizeEvidencePath,
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
});
