import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getReviewQueuePosition } from "../src/agentWork/workItemStateRepository.js";

describe("getReviewQueuePosition", () => {
  it("returns mid-queue rank from the durable FIFO query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ position: 2, total: 10 }] });
    const pool = { query } as unknown as Pool;

    await expect(getReviewQueuePosition(pool, "wi-2")).resolves.toEqual({
      position: 2,
      total: 10,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'queued'"), ["wi-2"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("type = 'review'"), ["wi-2"]);
  });

  it("returns #1 of 1 for a sole queued review", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ position: 1, total: 1 }] });
    const pool = { query } as unknown as Pool;

    await expect(getReviewQueuePosition(pool, "wi-only")).resolves.toEqual({
      position: 1,
      total: 1,
    });
  });

  it("returns null when the work item is not a queued review", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(getReviewQueuePosition(pool, "wi-running")).resolves.toBeNull();
  });

  it("returns null for impossible ranks", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ position: 0, total: 3 }] });
    const pool = { query } as unknown as Pool;

    await expect(getReviewQueuePosition(pool, "wi-bad")).resolves.toBeNull();
  });

  it("returns null when total is less than position", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ position: 5, total: 3 }] });
    const pool = { query } as unknown as Pool;

    await expect(getReviewQueuePosition(pool, "wi-bad")).resolves.toBeNull();
  });

  it("returns null for non-safe-integer position or total", async () => {
    const positionFrac = vi.fn().mockResolvedValue({ rows: [{ position: 2.5, total: 10 }] });
    await expect(
      getReviewQueuePosition({ query: positionFrac } as unknown as Pool, "wi-bad"),
    ).resolves.toBeNull();

    const totalFrac = vi.fn().mockResolvedValue({ rows: [{ position: 1, total: 1.5 }] });
    await expect(
      getReviewQueuePosition({ query: totalFrac } as unknown as Pool, "wi-bad"),
    ).resolves.toBeNull();
  });
});
