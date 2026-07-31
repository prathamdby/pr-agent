import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { logInfo } from "../evlog.js";

import { MIGRATIONS_DIR_NAME, MIGRATION_ADVISORY_LOCK_KEY } from "../settings/index.js";

const MIGRATIONS_DIR = path.join(process.cwd(), MIGRATIONS_DIR_NAME);

export async function runMigrations(pool: Pool): Promise<void> {
  // Serialize across processes (web + worker boot together) on a session-level
  // advisory lock; per-file transactions below cannot span one xact-level lock.
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    await applyMigrations(pool);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    lockClient.release();
  }
}

async function applyMigrations(pool: Pool): Promise<void> {
  await pool.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).toSorted();
  const appliedRows = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(appliedRows.rows.map((row) => row.version));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.add(file);
      logInfo("schema_migration_applied", { version: file });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
