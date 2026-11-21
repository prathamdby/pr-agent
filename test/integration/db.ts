import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppState } from "../../src/state/db.ts";
import { applyAppStateSchema } from "../../src/state/schema.ts";

export function openSqliteAppState() {
  const sqliteDir = mkdtempSync(join(tmpdir(), "pr-agent-sqlite-it-"));
  const handle = openAppState({ sqliteDir, applySchema: applyAppStateSchema });
  return ((pinnedReturn: {
    readonly sqliteDir: string;
    readonly db: typeof handle.db;
    readonly close: () => void;
  }) => pinnedReturn)({
    sqliteDir,
    db: handle.db,
    close: () => {
      handle.close();
      rmSync(sqliteDir, { recursive: true, force: true });
    },
  });
}
