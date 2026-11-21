import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTEGRATION_ALLOW_SKIP_ENV,
  INTEGRATION_DATABASE_HINT,
  allowIntegrationSkipWithoutDatabase,
  assertIntegrationDatabaseReady,
  formatMissingDatabaseUrlError,
  formatUnreachableDatabaseError,
} from "./integration/requireDatabase.ts";

describe("assertIntegrationDatabaseReady", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("no-ops when inventory skip flag is set", async () => {
    await expect(
      assertIntegrationDatabaseReady({
        [INTEGRATION_ALLOW_SKIP_ENV]: "1",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails fast with start instructions when DATABASE_URL is missing", async () => {
    await expect(assertIntegrationDatabaseReady({})).rejects.toThrow(/DATABASE_URL is unset/);
    await expect(assertIntegrationDatabaseReady({})).rejects.toThrow(
      /docker compose -f docker-compose.dev.yml up -d/,
    );
    await expect(assertIntegrationDatabaseReady({})).rejects.toThrow(
      /npm run test:integration:inventory/,
    );
  });

  it("exposes helper predicates and error formatters", () => {
    expect(allowIntegrationSkipWithoutDatabase({ [INTEGRATION_ALLOW_SKIP_ENV]: "1" })).toBe(true);
    expect(allowIntegrationSkipWithoutDatabase({})).toBe(false);
    expect(formatMissingDatabaseUrlError().message).toContain(INTEGRATION_DATABASE_HINT);
    expect(formatUnreachableDatabaseError(new Error("ECONNREFUSED")).message).toMatch(
      /ECONNREFUSED/,
    );
  });
});

describe("integration worker database setup", () => {
  afterEach(() => {
    vi.doUnmock("node:os");
    vi.resetModules();
  });

  it.each([
    { cores: 1, databases: ["fixture_w1"] },
    { cores: 8, databases: ["fixture_w1", "fixture_w2", "fixture_w3", "fixture_w4"] },
  ])(
    "provisions and selects matching databases with $cores cores",
    async ({ cores, databases }) => {
      vi.doMock("node:os", () => ({ availableParallelism: () => cores }));
      const { assignWorkerDatabaseUrl, integrationWorkerCount, workerDatabaseNames } =
        await import("./integration/workerDatabases.ts");
      const adminUrl = "postgres://localhost/fixture";
      expect(integrationWorkerCount).toBe(databases.length);
      expect(workerDatabaseNames(adminUrl)).toEqual(databases);

      for (const [index, database] of databases.entries()) {
        const env = { DATABASE_URL: adminUrl, VITEST_POOL_ID: String(index + 1) };
        assignWorkerDatabaseUrl(env);
        expect(env.DATABASE_URL).toBe(`postgres://localhost/${database}`);
        assignWorkerDatabaseUrl(env);
        expect(env.DATABASE_URL).toBe(`postgres://localhost/${database}`);
      }

      for (const poolId of [undefined, "0", "1.5", String(databases.length + 1)]) {
        const env = { DATABASE_URL: adminUrl, VITEST_POOL_ID: poolId };
        expect(() => assignWorkerDatabaseUrl(env)).toThrow(
          `VITEST_POOL_ID must be an integer from 1 to ${databases.length}, got ${poolId ?? "unset"}`,
        );
        expect(env.DATABASE_URL).toBe(adminUrl);
      }
    },
  );
});
