import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  formatFindingHistoryTrustedBlock,
  loadCrossPrSuppressionFingerprints,
  recordFindingHistoryOutcome,
  safeLoadCrossPrSuppressionFingerprints,
  upsertFindingHistoryOpen,
} from "../src/agentWork/findingHistoryRepository.js";

const cfg = {
  findingHistoryEnabled: true,
  findingHistoryDismissSuppressAfter: 3,
  findingHistoryLookbackDays: 180,
};

describe("upsertFindingHistoryOpen", () => {
  it("upserts open outcomes with increment on conflict", async () => {
    const query = vi.fn(async () => ({ rowCount: 1 }));
    const pool = { query } as unknown as Pool;

    await upsertFindingHistoryOpen(
      pool,
      {
        installationId: 9,
        owner: "acme",
        repo: "app",
        prNumber: 12,
        workItemId: "wi-1",
        headSha: "abc123",
      },
      ["fp-a", "fp-b"],
    );

    expect(query).toHaveBeenCalledTimes(2);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO repo_finding_history");
    expect(sql).toContain("open_count = repo_finding_history.open_count + 1");
    expect(values).toEqual([9, "acme", "app", "fp-a", 12, "wi-1", "abc123"]);
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

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "dismiss_count = repo_finding_history.dismiss_count + EXCLUDED.dismiss_count",
    );
    expect(values[4]).toBe("dismissed");
    expect(values[5]).toBe(1);
    expect(values[6]).toBe(0);
  });
});

describe("loadCrossPrSuppressionFingerprints", () => {
  it("queries rows meeting dismiss threshold within lookback", async () => {
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
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("dismiss_count >=");
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
