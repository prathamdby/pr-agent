import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { recordAutoFixBundle } from "../src/autoFix/repository.js";

describe("auto-fix repository", () => {
  it("does not persist an empty auto-fix bundle", async () => {
    const connect = vi.fn();
    const pool = { connect } as Pool;

    await expect(
      recordAutoFixBundle(pool, {
        workItemId: "00000000-0000-0000-0000-000000000001",
        resourceKey: "acme/app#1",
        reviewLens: "review",
        headSha: "a".repeat(40),
        targets: [],
      }),
    ).resolves.toBeNull();

    expect(connect).not.toHaveBeenCalled();
  });
});
