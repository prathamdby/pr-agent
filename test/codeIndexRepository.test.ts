import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  deleteExpiredCodeIndexSnapshots,
  ensureBuildingSnapshot,
} from "../src/codeIndex/repository.js";
import { RETENTION_DELETE_BATCH_SIZE } from "../src/settings/index.js";

describe("ensureBuildingSnapshot", () => {
  it("rebuilds when ready snapshot has a different chunker_version", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("UPDATE code_index_snapshots")) return { rows: [] };
      if (text.includes("INSERT INTO code_index_snapshots")) {
        expect(text).toContain("chunker_version = EXCLUDED.chunker_version");
        expect(text).toContain(
          "AND code_index_snapshots.chunker_version = EXCLUDED.chunker_version",
        );
        return {
          rows: [{ id: "snap-1", status: "building", chunker_version: "1" }],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const pool = { query } as unknown as Pool;

    const snapshot = await ensureBuildingSnapshot(pool, {
      installationId: 1,
      owner: "o",
      repo: "r",
      headSha: "sha",
    });

    expect(snapshot).toEqual({ id: "snap-1", status: "building", chunkerVersion: "1" });
  });
});

describe("deleteExpiredCodeIndexSnapshots", () => {
  it("batches deletes until a short remainder and sums row counts", async () => {
    const batches = [RETENTION_DELETE_BATCH_SIZE, 2];
    let calls = 0;
    const query = vi.fn(async (text: string) => {
      expect(text).toContain("DELETE FROM code_index_snapshots");
      expect(text).toContain("status IN ('superseded', 'failed', 'ready')");
      expect(text).toContain("updated_at < now()");
      const batch = batches[calls++];
      if (batch === undefined) throw new Error("unexpected extra code_index_snapshots query");
      return { rowCount: batch };
    });
    const pool = { query } as unknown as Pool;

    const deleted = await deleteExpiredCodeIndexSnapshots(
      pool,
      2_592_000,
      RETENTION_DELETE_BATCH_SIZE,
    );

    expect(deleted).toBe(RETENTION_DELETE_BATCH_SIZE + 2);
    expect(calls).toBe(2);
  });
});
