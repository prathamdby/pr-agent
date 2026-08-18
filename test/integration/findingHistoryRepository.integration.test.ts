import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import {
  recordFindingHistoryOutcome,
  upsertFindingHistoryOpen,
  type FindingHistoryWriteScope,
} from "../../src/agentWork/findingHistoryRepository.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "finding-history-it";

type HistoryRow = {
  fingerprint: string;
  last_outcome: string;
  open_count: number;
  last_work_item_id: string | null;
  last_pr_number: number | null;
  last_head_sha: string | null;
  last_seen_at: Date;
  first_seen_at: Date;
};

function writeScope(
  repo: string,
  overrides: Partial<FindingHistoryWriteScope> = {},
): FindingHistoryWriteScope {
  return {
    installationId: 463,
    owner: OWNER,
    repo,
    prNumber: 12,
    workItemId: randomUUID(),
    headSha: "abc123",
    ...overrides,
  };
}

describe.skipIf(!hasDatabase)("upsertFindingHistoryOpen (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM repo_finding_history WHERE owner = $1", [OWNER]);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM repo_finding_history WHERE owner = $1", [OWNER]);
  });

  async function rowsFor(repo: string): Promise<readonly HistoryRow[]> {
    const result = await pool.query<HistoryRow>(
      `SELECT fingerprint, last_outcome, open_count, last_work_item_id,
              last_pr_number, last_head_sha, last_seen_at, first_seen_at
         FROM repo_finding_history
        WHERE owner = $1 AND repo = $2
        ORDER BY fingerprint`,
      [OWNER, repo],
    );
    return result.rows;
  }

  it("writes nothing for an empty fingerprint list", async () => {
    const repo = `empty-${randomUUID().slice(0, 8)}`;
    await upsertFindingHistoryOpen(pool, writeScope(repo), []);
    expect(await rowsFor(repo)).toEqual([]);
  });

  it("inserts one open row for one fingerprint", async () => {
    const repo = `one-${randomUUID().slice(0, 8)}`;
    const scope = writeScope(repo);
    await upsertFindingHistoryOpen(pool, scope, ["fp-a"]);

    const rows = await rowsFor(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        fingerprint: "fp-a",
        last_outcome: "open",
        open_count: 1,
        last_work_item_id: scope.workItemId,
        last_pr_number: 12,
        last_head_sha: "abc123",
      }),
    );
  });

  it("inserts many fingerprints in one statement", async () => {
    const repo = `many-${randomUUID().slice(0, 8)}`;
    const scope = writeScope(repo);
    await upsertFindingHistoryOpen(pool, scope, ["fp-a", "fp-b", "fp-c"]);

    const rows = await rowsFor(repo);
    expect(rows.map((row) => row.fingerprint)).toEqual(["fp-a", "fp-b", "fp-c"]);
    expect(rows.every((row) => row.open_count === 1 && row.last_outcome === "open")).toBe(true);
  });

  it("deduplicates fingerprints so one batch cannot repeat a conflict key", async () => {
    const repo = `dups-${randomUUID().slice(0, 8)}`;
    await upsertFindingHistoryOpen(pool, writeScope(repo), ["fp-a", "fp-a", "fp-b", "fp-a"]);

    const rows = await rowsFor(repo);
    expect(rows.map((row) => [row.fingerprint, row.open_count])).toEqual([
      ["fp-a", 1],
      ["fp-b", 1],
    ]);
  });

  it("does not increment open_count for the same work item when already open", async () => {
    const repo = `same-wi-${randomUUID().slice(0, 8)}`;
    const scope = writeScope(repo);
    await upsertFindingHistoryOpen(pool, scope, ["fp-a"]);
    const first = (await rowsFor(repo))[0]!;

    await upsertFindingHistoryOpen(pool, scope, ["fp-a"]);
    const second = (await rowsFor(repo))[0]!;

    expect(second.open_count).toBe(1);
    expect(second.last_outcome).toBe("open");
    expect(second.last_work_item_id).toBe(scope.workItemId);
    expect(second.first_seen_at.getTime()).toBe(first.first_seen_at.getTime());
    expect(second.last_seen_at.getTime()).toBeGreaterThanOrEqual(first.last_seen_at.getTime());
  });

  it("increments open_count when a later work item reopens the finding", async () => {
    const repo = `cross-wi-${randomUUID().slice(0, 8)}`;
    const firstScope = writeScope(repo);
    const secondScope = writeScope(repo, {
      workItemId: randomUUID(),
      prNumber: 13,
      headSha: "def456",
    });

    await upsertFindingHistoryOpen(pool, firstScope, ["fp-a"]);
    await upsertFindingHistoryOpen(pool, secondScope, ["fp-a"]);

    const row = (await rowsFor(repo))[0]!;
    expect(row.open_count).toBe(2);
    expect(row.last_outcome).toBe("open");
    expect(row.last_work_item_id).toBe(secondScope.workItemId);
    expect(row.last_pr_number).toBe(13);
    expect(row.last_head_sha).toBe("def456");
  });

  it("increments when the same work item reopens a non-open outcome", async () => {
    const repo = `reopen-dismissed-${randomUUID().slice(0, 8)}`;
    const scope = writeScope(repo);
    await upsertFindingHistoryOpen(pool, scope, ["fp-a"]);
    await recordFindingHistoryOutcome(pool, scope, "fp-a", "dismissed");
    await upsertFindingHistoryOpen(pool, scope, ["fp-a"]);

    const row = (await rowsFor(repo))[0]!;
    expect(row.last_outcome).toBe("open");
    expect(row.open_count).toBe(2);
  });

  it("is idempotent when the same batch is invoked twice", async () => {
    const repo = `repeat-${randomUUID().slice(0, 8)}`;
    const scope = writeScope(repo);
    const fingerprints = ["fp-a", "fp-b", "fp-a"];

    await upsertFindingHistoryOpen(pool, scope, fingerprints);
    await upsertFindingHistoryOpen(pool, scope, fingerprints);

    const rows = await rowsFor(repo);
    expect(rows.map((row) => [row.fingerprint, row.open_count])).toEqual([
      ["fp-a", 1],
      ["fp-b", 1],
    ]);
  });
});
