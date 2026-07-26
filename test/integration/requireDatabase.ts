import { Pool } from "pg";

export const INTEGRATION_ALLOW_SKIP_ENV = "INTEGRATION_ALLOW_SKIP_WITHOUT_DB";

export const INTEGRATION_DATABASE_HINT = [
  "Integration tests require a reachable Postgres database.",
  "",
  "Start one, then re-run:",
  "  docker compose up -d postgres",
  "  export DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent",
  "  nub run test:integration",
  "",
  "Or with a one-off container:",
  "  docker run -d --name pr-agent-postgres \\",
  "    -e POSTGRES_DB=pr_agent -e POSTGRES_USER=pr_agent -e POSTGRES_PASSWORD=pr_agent \\",
  "    -p 5432:5432 postgres:16-alpine",
  "",
  "Inventory-only (skips DB suites when unavailable):",
  "  nub run test:integration:inventory",
].join("\n");

export function allowIntegrationSkipWithoutDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INTEGRATION_ALLOW_SKIP_ENV] === "1";
}

export function formatMissingDatabaseUrlError(): Error {
  return new Error(`DATABASE_URL is unset.\n\n${INTEGRATION_DATABASE_HINT}`);
}

export function formatUnreachableDatabaseError(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Postgres at DATABASE_URL is unreachable (${detail}).\n\n${INTEGRATION_DATABASE_HINT}`,
  );
}

/**
 * Fail fast when `nub run test:integration` is invoked without a reachable DB.
 * Opt out with INTEGRATION_ALLOW_SKIP_WITHOUT_DB=1 (inventory command).
 */
export async function assertIntegrationDatabaseReady(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (allowIntegrationSkipWithoutDatabase(env)) return;

  const databaseUrl = env.DATABASE_URL;
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    throw formatMissingDatabaseUrlError();
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query("SELECT 1");
  } catch (cause) {
    throw formatUnreachableDatabaseError(cause);
  } finally {
    await pool.end();
  }
}
