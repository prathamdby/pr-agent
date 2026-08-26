import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Suites use `describe.skipIf(!hasDatabase)` only for `nub run test:integration:inventory`.
 * Plain `nub run test:integration` fail-fasts in `globalSetup` before suites load when
 * Postgres is missing or unreachable.
 */
export const hasDatabase = typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

export function requireDatabaseUrl(): string {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
  return DATABASE_URL;
}

export function integrationPool(): Pool {
  return new Pool({ connectionString: requireDatabaseUrl(), max: 4 });
}
