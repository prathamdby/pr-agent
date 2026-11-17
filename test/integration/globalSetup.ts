import { Pool } from "pg";
import {
  allowIntegrationSkipWithoutDatabase,
  assertIntegrationDatabaseReady,
} from "./requireDatabase.ts";
import { quoteDatabaseIdent, workerDatabaseNames } from "./workerDatabases.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  await assertIntegrationDatabaseReady();
  const adminUrl = process.env.DATABASE_URL;
  if (typeof adminUrl !== "string" || adminUrl.length === 0) {
    return async () => {};
  }
  if (allowIntegrationSkipWithoutDatabase() && !(await databaseAcceptsConnections(adminUrl))) {
    return async () => {};
  }

  const names = workerDatabaseNames(adminUrl);
  await recreateWorkerDatabases(adminUrl, names);
  return async () => {
    await dropWorkerDatabases(adminUrl, names);
  };
}

async function databaseAcceptsConnections(connectionString: string): Promise<boolean> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

async function recreateWorkerDatabases(adminUrl: string, names: readonly string[]): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    for (const name of names) {
      const ident = quoteDatabaseIdent(name);
      await pool.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
      await pool.query(`CREATE DATABASE ${ident}`);
    }
  } finally {
    await pool.end();
  }
}

async function dropWorkerDatabases(adminUrl: string, names: readonly string[]): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    for (const name of names) {
      await pool.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdent(name)} WITH (FORCE)`);
    }
  } finally {
    await pool.end();
  }
}
