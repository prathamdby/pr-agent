import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTEGRATION_ALLOW_SKIP_ENV,
  INTEGRATION_DATABASE_HINT,
  allowIntegrationSkipWithoutDatabase,
  assertIntegrationDatabaseReady,
  formatMissingDatabaseUrlError,
  formatUnreachableDatabaseError,
} from "./integration/requireDatabase.js";

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
    await expect(assertIntegrationDatabaseReady({})).rejects.toThrow(
      /DATABASE_URL is unset/,
    );
    await expect(assertIntegrationDatabaseReady({})).rejects.toThrow(
      /docker compose up -d postgres/,
    );
    await expect(assertIntegrationDatabaseReady({})).rejects.toThrow(
      /nub run test:integration:inventory/,
    );
  });

  it("exposes helper predicates and error formatters", () => {
    expect(allowIntegrationSkipWithoutDatabase({ [INTEGRATION_ALLOW_SKIP_ENV]: "1" })).toBe(
      true,
    );
    expect(allowIntegrationSkipWithoutDatabase({})).toBe(false);
    expect(formatMissingDatabaseUrlError().message).toContain(INTEGRATION_DATABASE_HINT);
    expect(formatUnreachableDatabaseError(new Error("ECONNREFUSED")).message).toMatch(
      /ECONNREFUSED/,
    );
  });
});
