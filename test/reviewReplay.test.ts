import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computeSnapshotContentHash,
  validateManifest,
  runReplay,
  type ReplayManifest,
} from "../src/review/evaluation/reviewReplay.js";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures/review-replay/manifest.json");

async function loadFixtureManifest(): Promise<ReplayManifest> {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  return validateManifest(raw);
}

describe("reviewReplay", () => {
  describe("computeSnapshotContentHash", () => {
    it("produces a deterministic 16-char hex hash", () => {
      const hash = computeSnapshotContentHash({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "a",
        baseSha: "b",
        files: [{ path: "f.ts", status: "modified", patch: "patch" }],
      });
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("changes when any field changes", () => {
      const base = {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "a",
        baseSha: "b",
        files: [{ path: "f.ts", status: "modified", patch: "patch" }],
      };
      const h1 = computeSnapshotContentHash(base);
      const h2 = computeSnapshotContentHash({ ...base, headSha: "c" });
      expect(h1).not.toBe(h2);
    });
  });

  describe("validateManifest", () => {
    it("accepts the fixture manifest", async () => {
      const manifest = await loadFixtureManifest();
      expect(manifest.cases).toHaveLength(2);
    });

    it("rejects missing expected outcomes (not acceptedClean and no expectedFindings)", () => {
      expect(() =>
        validateManifest({
          version: 1,
          cases: [
            {
              caseId: "c1",
              domain: "correctness",
              sizeTag: "small",
              snapshot: {
                owner: "o",
                repo: "r",
                prNumber: 1,
                headSha: "a",
                baseSha: "b",
                files: [{ path: "f.ts", status: "modified", patch: "p" }],
                contentHash: computeSnapshotContentHash({
                  owner: "o",
                  repo: "r",
                  prNumber: 1,
                  headSha: "a",
                  baseSha: "b",
                  files: [{ path: "f.ts", status: "modified", patch: "p" }],
                }),
              },
              expectedFindings: [],
              acceptedClean: false,
            },
          ],
        }),
      ).toThrow(/no expected findings/);
    });

    it("rejects duplicate case IDs", () => {
      const snap = {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "a",
        baseSha: "b",
        files: [{ path: "f.ts", status: "modified", patch: "p" }],
      };
      const hash = computeSnapshotContentHash(snap);
      expect(() =>
        validateManifest({
          version: 1,
          cases: [
            {
              caseId: "dup",
              domain: "correctness",
              sizeTag: "small",
              snapshot: { ...snap, contentHash: hash },
              expectedFindings: [
                {
                  id: "f1",
                  file: "f.ts",
                  lineBucket: 0,
                  normalizedTitle: "t",
                  severity: "P1",
                  valid: true,
                },
              ],
              acceptedClean: false,
            },
            {
              caseId: "dup",
              domain: "security",
              sizeTag: "small",
              snapshot: { ...snap, contentHash: hash },
              expectedFindings: [],
              acceptedClean: true,
            },
          ],
        }),
      ).toThrow(/Duplicate/);
    });

    it("rejects content hash mismatch", () => {
      expect(() =>
        validateManifest({
          version: 1,
          cases: [
            {
              caseId: "c1",
              domain: "correctness",
              sizeTag: "small",
              snapshot: {
                owner: "o",
                repo: "r",
                prNumber: 1,
                headSha: "a",
                baseSha: "b",
                files: [{ path: "f.ts", status: "modified", patch: "p" }],
                contentHash: "wronghash",
              },
              expectedFindings: [
                {
                  id: "f1",
                  file: "f.ts",
                  lineBucket: 0,
                  normalizedTitle: "t",
                  severity: "P1",
                  valid: true,
                },
              ],
              acceptedClean: false,
            },
          ],
        }),
      ).toThrow(/hash mismatch/);
    });
  });

  describe("runReplay", () => {
    it("runs without installation tokens or GitHub mutation executors", async () => {
      const manifest = await loadFixtureManifest();
      const report = await runReplay({
        manifest,
        runLegacy: async () => ({ findings: [], durationMs: 10 }),
        runHybrid: async () => ({ findings: [], durationMs: 5 }),
      });
      expect(report.totalCases).toBe(2);
      expect(report.gate).toBeDefined();
    });

    it("detects when legacy found a valid finding hybrid missed (recall failure)", async () => {
      const manifest = await loadFixtureManifest();
      const report = await runReplay({
        manifest,
        runLegacy: async () => ({
          findings: [
            {
              severity: "P1",
              file: "src/handler.ts",
              startLine: 1,
              endLine: 1,
              title: "Missing error handling for failed result",
              detail: "d",
              confidence: 5,
              category: "bug",
              fixPrompt: "fix",
            },
          ],
          durationMs: 10,
        }),
        runHybrid: async () => ({ findings: [], durationMs: 5 }),
      });
      expect(report.gate.recallPass).toBe(false);
    });

    it("records hybrid-only valid finding as improvement not false positive", async () => {
      const manifest = await loadFixtureManifest();
      const report = await runReplay({
        manifest,
        runLegacy: async () => ({ findings: [], durationMs: 10 }),
        runHybrid: async () => ({
          findings: [
            {
              severity: "P1",
              file: "src/handler.ts",
              startLine: 1,
              endLine: 1,
              title: "Missing error handling for failed result",
              detail: "d",
              confidence: 5,
              category: "bug",
              fixPrompt: "fix",
            },
          ],
          durationMs: 5,
        }),
      });
      expect(report.gate.recallPass).toBe(true);
    });
  });
});
