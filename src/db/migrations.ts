import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { logInfo } from "../evlog.js";

import { MIGRATIONS_DIR_NAME } from "../settings/index.js";

const MIGRATIONS_DIR = path.join(process.cwd(), MIGRATIONS_DIR_NAME);

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).toSorted();

  for (const file of files) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
    if (applied.rowCount && applied.rowCount > 0) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      logInfo("schema_migration_applied", { version: file });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
