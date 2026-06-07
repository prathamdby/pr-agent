import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("auto-fix migrations", () => {
  it("does not tie auto-fix lookup rows to agent work item deletion", () => {
    const sql = readFileSync("migrations/006_auto_fix.sql", "utf8");

    expect(sql).not.toMatch(/auto_fix_bundles[\s\S]*REFERENCES agent_work_items/i);
    expect(sql).not.toMatch(/auto_fix_targets[\s\S]*REFERENCES agent_work_items/i);
  });

  it("drops legacy work item foreign keys for already migrated databases", () => {
    const path = "migrations/007_decouple_auto_fix_work_items.sql";

    expect(existsSync(path)).toBe(true);
    const sql = readFileSync(path, "utf8");
    expect(sql).toContain("auto_fix_bundles_work_item_id_fkey");
    expect(sql).toContain("auto_fix_targets_work_item_id_fkey");
  });
});
