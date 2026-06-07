import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  findAutoFixTargetByInlineLocation,
  recordAutoFixBundle,
} from "../src/autoFix/repository.js";

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

  it("finds null-id inline targets by review comment location", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "target-1",
          bundle_id: "bundle-1",
          work_item_id: "work-1",
          resource_key: "acme/app#1",
          review_lens: "review",
          head_sha: "a".repeat(40),
          fingerprint: "fp",
          severity: "P1",
          file_path: "src/app.ts",
          start_line: 4,
          end_line: 6,
          title: "Bug",
          detail: "detail",
          fix_prompt: "fix",
          placement_kind: "inline",
          inline_review_comment_id: null,
        },
      ],
    }));
    const pool = { query } as unknown as Pool;

    const target = await findAutoFixTargetByInlineLocation(pool, {
      resourceKey: "acme/app#1",
      filePath: "src/app.ts",
      line: 5,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("t.placement_kind = 'inline'"), [
      "acme/app#1",
      "src/app.ts",
      5,
    ]);
    expect(target?.inlineReviewCommentId).toBeNull();
  });
});
