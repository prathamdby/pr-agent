import { describe, expect, it, vi } from "vitest";
import {
  formatFindingHistoryTrustedBlock,
  loadCrossPrSuppressionFingerprints,
  lookupThreadFingerprint,
  recordFindingHistoryOutcome,
  safeLoadCrossPrSuppressionFingerprints,
  upsertFindingHistoryOpen,
} from "../src/agentWork/findingHistoryRepository.js";
import { createQueryClient } from "./helpers/fakePool.js";
import type { JsonValue } from "../src/util/jsonValue.js";

const cfg = {
  findingHistoryEnabled: true,
  findingHistoryDismissSuppressAfter: 3,
  findingHistoryLookbackDays: 180,
};

describe("upsertFindingHistoryOpen", () => {
  it("upserts open outcomes with idempotent increment on conflict", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly JsonValue[]) => ({
      rows: [],
      rowCount: 1,
    }));
    const pool = createQueryClient(query);

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
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO repo_finding_history");
    expect(query.mock.calls[0]?.[0]).toContain(
      "last_work_item_id IS NOT DISTINCT FROM EXCLUDED.last_work_item_id",
    );
    expect(query.mock.calls[0]?.[0]).toContain("repo_finding_history.open_count + 1");
    expect(query.mock.calls[0]?.[1]).toEqual([9, "acme", "app", "fp-a", 12, "wi-1", "abc123"]);
  });
});

describe("recordFindingHistoryOutcome", () => {
  it("increments dismiss_count for dismissed outcomes", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly JsonValue[]) => ({
      rows: [],
      rowCount: 1,
    }));
    const pool = createQueryClient(query);

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

    expect(query.mock.calls[0]?.[0]).toContain(
      "last_work_item_id IS NOT DISTINCT FROM EXCLUDED.last_work_item_id",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "repo_finding_history.dismiss_count + EXCLUDED.dismiss_count",
    );
    expect(query.mock.calls[0]?.[1]?.[4]).toBe("dismissed");
    expect(query.mock.calls[0]?.[1]?.[5]).toBe(1);
    expect(query.mock.calls[0]?.[1]?.[6]).toBe(0);
  });
});

describe("loadCrossPrSuppressionFingerprints", () => {
  it("queries dismissed rows meeting dismiss threshold within lookback", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly JsonValue[]) => ({
      rows: [{ fingerprint: "fp-hot" }],
    }));
    const pool = createQueryClient(query);

    const fingerprints = await loadCrossPrSuppressionFingerprints(pool, cfg, {
      installationId: 1,
      owner: "o",
      repo: "r",
    });

    expect(fingerprints).toEqual(["fp-hot"]);
    expect(query.mock.calls[0]?.[0]).toContain("dismiss_count >=");
    expect(query.mock.calls[0]?.[0]).toContain("last_outcome = 'dismissed'");
    expect(query.mock.calls[0]?.[1]).toEqual([1, "o", "r", 3, "180"]);
  });
});

describe("safeLoadCrossPrSuppressionFingerprints", () => {
  it("returns empty when disabled", async () => {
    const query = vi.fn();
    const pool = createQueryClient(query);
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
    const pool = createQueryClient(query);
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
    const pool = createQueryClient(query);

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
