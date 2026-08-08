import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("../src/evlog.js", () => ({
  logWarn: mocks.logWarn,
}));

import { reapStrandedWorkItems } from "../src/agentWork/strandedWorkReaper.js";
import {
  STRANDED_WORK_REAPER_BATCH_SIZE,
  STRANDED_WORK_REAPER_GRACE_SECONDS,
} from "../src/settings/index.js";

describe("reapStrandedWorkItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("terminalises stranded rows and emits a warning per row", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "wi-1",
          type: "review",
          prior_status: "queued",
          resource_key: "o/r#1",
        },
      ],
    });
    const pool = { query } as unknown as Pool;

    await expect(reapStrandedWorkItems(pool)).resolves.toEqual({ reaped: 1 });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("pgboss.job");
    expect(sql).toContain("status IN ('queued', 'running')");
    expect(sql).toContain("j.state IN ('created', 'active', 'retry')");
    expect(sql).toContain("FOR UPDATE OF wi SKIP LOCKED");
    expect(sql).toContain("j.data->>'workItemId' = wi.id::text");
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      STRANDED_WORK_REAPER_GRACE_SECONDS,
      STRANDED_WORK_REAPER_BATCH_SIZE,
    ]);
    expect(mocks.logWarn).toHaveBeenCalledWith("stranded_work_item_reaped", {
      workItemId: "wi-1",
      type: "review",
      priorStatus: "queued",
      resourceKey: "o/r#1",
    });
  });

  it("returns zero when no stranded rows match the safety predicates", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(reapStrandedWorkItems(pool)).resolves.toEqual({ reaped: 0 });
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });
});
