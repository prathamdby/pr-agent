import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Suites use `describe.skipIf(!hasDatabase)` only for `nub run test:integration:inventory`.
 * Plain `nub run test:integration` fail-fasts in `globalSetup` before suites load when
 * Postgres is missing or unreachable.
 */
export const hasDatabase = typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

export function integrationPool(): Pool {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
  return new Pool({ connectionString: DATABASE_URL, max: 4 });
}
