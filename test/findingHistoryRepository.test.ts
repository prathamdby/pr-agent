import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  formatFindingHistoryTrustedBlock,
  loadCrossPrSuppressionFingerprints,
  lookupThreadFingerprint,
  recordFindingHistoryOutcome,
  safeLoadCrossPrSuppressionFingerprints,
  safeUpsertFindingHistoryOpen,
  upsertFindingHistoryOpen,
} from "../src/agentWork/findingHistoryRepository.js";

const cfg = {
  findingHistoryEnabled: true,
  findingHistoryDismissSuppressAfter: 3,
  findingHistoryLookbackDays: 180,
};

const openScope = {
  installationId: 9,
  owner: "acme",
  repo: "app",
  prNumber: 12,
  workItemId: "wi-1",
  headSha: "abc123",
} as const;

function mockPool() {
  const query = vi.fn(async () => ({ rowCount: 1 }));
  return { query, pool: { query } as unknown as Pool };
}

function upsertSqlAndValues(query: ReturnType<typeof vi.fn>): [string, unknown[]] {
  expect(query).toHaveBeenCalledTimes(1);
  return query.mock.calls[0] as unknown as [string, unknown[]];
}

describe("upsertFindingHistoryOpen", () => {
  it("skips the database when the fingerprint list is empty", async () => {
    const { query, pool } = mockPool();

    await upsertFindingHistoryOpen(pool, openScope, []);

    expect(query).not.toHaveBeenCalled();
  });

  it("issues one unnest upsert for a single fingerprint", async () => {
    const { query, pool } = mockPool();

    await upsertFindingHistoryOpen(pool, openScope, ["fp-a"]);

    const [sql, values] = upsertSqlAndValues(query);
    expect(sql).toContain("INSERT INTO repo_finding_history");
    expect(sql).toContain("FROM unnest($7::text[])");
    expect(sql).toContain("ON CONFLICT (installation_id, owner, repo, fingerprint)");
    expect(sql).toContain("last_work_item_id IS NOT DISTINCT FROM EXCLUDED.last_work_item_id");
    expect(sql).toContain("repo_finding_history.last_outcome = 'open'");
    expect(sql).toContain("THEN repo_finding_history.open_count");
    expect(sql).toContain("repo_finding_history.open_count + 1");
    expect(values).toEqual([9, "acme", "app", 12, "wi-1", "abc123", ["fp-a"]]);
  });

  it("issues one unnest upsert for many fingerprints", async () => {
    const { query, pool } = mockPool();

    await upsertFindingHistoryOpen(pool, openScope, ["fp-a", "fp-b", "fp-c"]);

    const [sql, values] = upsertSqlAndValues(query);
    expect(sql).toContain("FROM unnest($7::text[])");
    expect(values).toEqual([9, "acme", "app", 12, "wi-1", "abc123", ["fp-a", "fp-b", "fp-c"]]);
  });

  it("deduplicates fingerprints before constructing the batch", async () => {
    const { query, pool } = mockPool();

    await upsertFindingHistoryOpen(pool, openScope, ["fp-a", "fp-b", "fp-a", "fp-b", "fp-c"]);

    const [, values] = upsertSqlAndValues(query);
    expect(values[6]).toEqual(["fp-a", "fp-b", "fp-c"]);
  });

  it("keeps same-work-item already-open from incrementing open_count", async () => {
    const { query, pool } = mockPool();

    await upsertFindingHistoryOpen(pool, openScope, ["fp-a"]);

    const [sql] = upsertSqlAndValues(query);
    expect(sql).toMatch(
      /WHEN repo_finding_history\.last_work_item_id IS NOT DISTINCT FROM EXCLUDED\.last_work_item_id\s+AND repo_finding_history\.last_outcome = 'open'\s+THEN repo_finding_history\.open_count/,
    );
  });

  it("increments open_count on cross-work-item reopen", async () => {
    const { query, pool } = mockPool();

    await upsertFindingHistoryOpen(pool, { ...openScope, workItemId: "wi-2" }, ["fp-a"]);

    const [sql, values] = upsertSqlAndValues(query);
    expect(sql).toContain("ELSE repo_finding_history.open_count + 1");
    expect(values[4]).toBe("wi-2");
  });

  it("reuses the same parameterized statement on repeated invocation", async () => {
    const { query, pool } = mockPool();

    await upsertFindingHistoryOpen(pool, openScope, ["fp-a", "fp-b"]);
    await upsertFindingHistoryOpen(pool, openScope, ["fp-a", "fp-b"]);

    expect(query).toHaveBeenCalledTimes(2);
    const first = query.mock.calls[0] as unknown as [string, unknown[]];
    const second = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toEqual(first[1]);
  });
});

describe("safeUpsertFindingHistoryOpen", () => {
  it("does not query when finding history is disabled", () => {
    const { query, pool } = mockPool();

    safeUpsertFindingHistoryOpen(pool, { findingHistoryEnabled: false }, openScope, ["fp-a"]);

    expect(query).not.toHaveBeenCalled();
  });

  it("swallows batch upsert failures", async () => {
    const query = vi.fn(async () => {
      throw new Error("db down");
    });
    const pool = { query } as unknown as Pool;

    expect(() =>
      safeUpsertFindingHistoryOpen(pool, { findingHistoryEnabled: true }, openScope, ["fp-a"]),
    ).not.toThrow();
    await expect(query.mock.results[0]?.value).rejects.toThrow("db down");
  });
});

describe("recordFindingHistoryOutcome", () => {
  it("increments dismiss_count for dismissed outcomes", async () => {
    const query = vi.fn(async () => ({ rowCount: 1 }));
    const pool = { query } as unknown as Pool;

    await recordFindingHistoryOutcome(
      pool,
      {
        installationId: 9,
        owner: "acme",
        repo: "app",
        prNumber: 4,
        workItemId: "wi-2",
        headSha: "deadbeef",
      },
      "fp-dismiss",
      "dismissed",
    );

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("last_work_item_id IS NOT DISTINCT FROM EXCLUDED.last_work_item_id");
    expect(sql).toContain("repo_finding_history.dismiss_count + EXCLUDED.dismiss_count");
    expect(values[4]).toBe("dismissed");
    expect(values[5]).toBe(1);
    expect(values[6]).toBe(0);
  });
});

describe("loadCrossPrSuppressionFingerprints", () => {
  it("queries dismissed rows meeting dismiss threshold within lookback", async () => {
    const query = vi.fn(async () => ({
      rows: [{ fingerprint: "fp-hot" }],
    }));
    const pool = { query } as unknown as Pool;

    const fingerprints = await loadCrossPrSuppressionFingerprints(pool, cfg, {
      installationId: 1,
      owner: "o",
      repo: "r",
    });

    expect(fingerprints).toEqual(["fp-hot"]);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("dismiss_count >=");
    expect(sql).toContain("last_outcome = 'dismissed'");
    expect(values).toEqual([1, "o", "r", 3, "180"]);
  });
});

describe("safeLoadCrossPrSuppressionFingerprints", () => {
  it("returns empty when disabled", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    const result = await safeLoadCrossPrSuppressionFingerprints(
      pool,
      { ...cfg, findingHistoryEnabled: false },
      { installationId: 1, owner: "o", repo: "r" },
    );
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("swallows query failures", async () => {
    const query = vi.fn(async () => {
      throw new Error("db down");
    });
    const pool = { query } as unknown as Pool;
    const result = await safeLoadCrossPrSuppressionFingerprints(pool, cfg, {
      installationId: 1,
      owner: "o",
      repo: "r",
    });
    expect(result).toEqual([]);
  });
});

describe("lookupThreadFingerprint", () => {
  it("matches thread paths after normalizing ./ prefixes", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          detail: {
            batches: [
              {
                workItemId: "wi-1",
                reviewId: 11,
                fingerprints: ["fp-norm"],
                specialist: "correctness",
                placements: [
                  {
                    finding: {
                      severity: "P2",
                      confidence: 4,
                      title: "Bug",
                      detail: "Details about the bug",
                      file: "./src/foo.ts",
                      startLine: 10,
                      endLine: 12,
                      fixPrompt: "Fix the bug in foo",
                    },
                    resolvedLine: 10,
                    canonicalFingerprint: "fp-norm",
                  },
                ],
              },
            ],
          },
        },
      ],
    }));
    const pool = { query } as unknown as Pool;

    const fingerprint = await lookupThreadFingerprint(pool, {
      resourceKey: "owner/repo#1",
      thread: { path: "src/foo.ts", line: 10 },
    });

    expect(fingerprint).toBe("fp-norm");
  });
});

describe("formatFindingHistoryTrustedBlock", () => {
  it("renders machine summaries for fingerprints at threshold", () => {
    const block = formatFindingHistoryTrustedBlock(
      [
        {
          fingerprint: "abc123",
          lastOutcome: "dismissed",
          dismissCount: 3,
          fixCount: 0,
          openCount: 1,
          lastPrNumber: 9,
          lastWorkItemId: "wi-1",
          lastHeadSha: "sha",
          lastSeenAt: new Date(),
          firstSeenAt: new Date(),
        },
      ],
      3,
    );
    expect(block).toContain("fingerprint `abc123` dismissed 3×");
    expect(block).not.toContain("false positive");
  });

  it("omits rows below threshold", () => {
    expect(
      formatFindingHistoryTrustedBlock(
        [
          {
            fingerprint: "low",
            lastOutcome: "dismissed",
            dismissCount: 1,
            fixCount: 0,
            openCount: 0,
            lastPrNumber: null,
            lastWorkItemId: null,
            lastHeadSha: null,
            lastSeenAt: new Date(),
            firstSeenAt: new Date(),
          },
        ],
        3,
      ),
    ).toBeUndefined();
  });
});
