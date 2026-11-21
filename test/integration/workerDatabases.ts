import { availableParallelism } from "node:os";

const adminUrlEnv = "PR_AGENT_INTEGRATION_ADMIN_URL";

export const integrationWorkerCount = Math.min(availableParallelism(), 4);

function assertPlainIdent(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`refusing database name ${name}`);
  }
  return ((pinnedReturn: string) => pinnedReturn)(name);
}

export function quoteDatabaseIdent(name: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`"${assertPlainIdent(name)}"`);
}

export function databaseNameFromUrl(connectionString: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    assertPlainIdent(decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""))),
  );
}

export function workerDatabaseName(baseName: string, poolId: number) {
  return ((pinnedReturn: string) => pinnedReturn)(
    assertPlainIdent(`${assertPlainIdent(baseName)}_w${poolId}`),
  );
}

export function connectionStringForDatabase(connectionString: string, database: string) {
  const url = new URL(connectionString);
  url.pathname = `/${assertPlainIdent(database)}`;
  return ((pinnedReturn: string) => pinnedReturn)(url.toString());
}

export function workerDatabaseNames(connectionString: string) {
  const base = databaseNameFromUrl(connectionString);
  return ((pinnedReturn: string[]) => pinnedReturn)(
    Array.from({ length: integrationWorkerCount }, (_, index) =>
      workerDatabaseName(base, index + 1),
    ),
  );
}

export function assignWorkerDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const current = env.DATABASE_URL;
  if (typeof current !== "string" || current.length === 0) return;

  const stored = env[adminUrlEnv];
  const admin = typeof stored === "string" && stored.length > 0 ? stored : current;
  env[adminUrlEnv] = admin;

  const poolId = Number(env.VITEST_POOL_ID);
  if (!Number.isInteger(poolId) || poolId < 1 || poolId > integrationWorkerCount) {
    throw new Error(
      `VITEST_POOL_ID must be an integer from 1 to ${integrationWorkerCount}, got ${env.VITEST_POOL_ID ?? "unset"}`,
    );
  }

  env.DATABASE_URL = connectionStringForDatabase(
    admin,
    workerDatabaseName(databaseNameFromUrl(admin), poolId),
  );
}
