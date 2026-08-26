import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import { ENV } from "../src/settings/index.js";
import { TEST_PRIVATE_KEY_PEM } from "./helpers/testKey.js";

const BASE_ENV = {
  GITHUB_APP_ID: "1",
  WEBHOOK_SECRET: "secret",
  DATABASE_URL: "postgres://u:p@localhost/db",
};

async function load(extra: Record<string, string>) {
  process.env = {
    ...BASE_ENV,
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    ...extra,
  };
  const { loadConfig } = await import("../src/config.js");
  return loadConfig();
}

describe("loadConfig validation", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("applies documented defaults", async () => {
    const cfg = await load({});
    expect(cfg.port).toBe(3000);
    expect(cfg.providerPromptTimeoutMs).toBe(300_000);
    expect(cfg.reviewSpecialistTimeoutMs).toBe(900_000);
    expect(cfg.queueRetryLimit).toBe(3);
    expect(cfg.queueHeartbeatSeconds).toBe(60);
    expect(cfg.shutdownDrainTimeoutSeconds).toBe(25);
    expect(cfg.retentionEnabled).toBe(true);
    expect(cfg.logRedact).toBe(true);
    expect(cfg.role).toBe("web");
    expect(cfg.logLevel).toBe("info");
    expect([...cfg.slashAllowedAssociations]).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
    expect([...cfg.maintainerDecisionAssociations]).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
    expect(cfg.askActorMaxOutstanding).toBe(2);
    expect(cfg.askRepositoryMaxOutstanding).toBe(8);
    expect(cfg.askInstallationMaxOutstanding).toBe(32);
    expect(cfg.askProviderBudgetTokens).toBe(0);
    expect(cfg.askProviderReservationTokens).toBe(16_384);
  });

  it("rejects a non-numeric positive knob", async () => {
    await expect(load({ PROVIDER_PROMPT_TIMEOUT_MS: "abc" })).rejects.toThrow(
      /PROVIDER_PROMPT_TIMEOUT_MS must be a positive number/,
    );
  });

  it("allows zero for zero-or-positive knobs", async () => {
    const cfg = await load({ QUEUE_RETRY_LIMIT: "0" });
    expect(cfg.queueRetryLimit).toBe(0);
  });

  it("rejects zero for positive-only knobs", async () => {
    await expect(load({ REVIEW_CONCURRENCY: "0" })).rejects.toThrow(
      /REVIEW_CONCURRENCY must be a positive number/,
    );
  });

  it("rejects invalid ask quota integers", async () => {
    await expect(load({ ASK_ACTOR_MAX_OUTSTANDING: "1.5" })).rejects.toThrow(
      /ASK_ACTOR_MAX_OUTSTANDING must be a positive integer/,
    );
    await expect(load({ ASK_PROVIDER_BUDGET_TOKENS: "-1" })).rejects.toThrow(
      /ASK_PROVIDER_BUDGET_TOKENS must be zero or a non-negative integer/,
    );
  });

  it("keeps provider reservations within an enabled budget", async () => {
    await expect(
      load({ ASK_PROVIDER_BUDGET_TOKENS: "100", ASK_PROVIDER_RESERVATION_TOKENS: "101" }),
    ).rejects.toThrow(/ASK_PROVIDER_RESERVATION_TOKENS must not exceed ASK_PROVIDER_BUDGET_TOKENS/);
  });

  it("enforces the heartbeat floor", async () => {
    await expect(load({ QUEUE_HEARTBEAT_SECONDS: "5" })).rejects.toThrow(
      /QUEUE_HEARTBEAT_SECONDS must be at least 10/,
    );
  });

  it.each([
    ["LOG_REDACT", "logRedact"] as const,
    ["AGENT_EVENTS_ENABLED", "agentEventsEnabled"] as const,
    ["FINDING_HISTORY_ENABLED", "findingHistoryEnabled"] as const,
    ["RETENTION_ENABLED", "retentionEnabled"] as const,
  ])("parses boolean knob %s as strict true/false", async (name, field) => {
    expect((await load({ [name]: "false" }))[field]).toBe(false);
    expect((await load({ [name]: "true" }))[field]).toBe(true);
    await expect(load({ [name]: "1" })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("config.invalid_enum");
      expect((error as AppError).context).toMatchObject({ name });
      return true;
    });
  });

  it("treats empty strict boolean env as the default", async () => {
    const cfg = await load({ LOG_REDACT: "", AGENT_EVENTS_ENABLED: "   " });
    expect(cfg.logRedact).toBe(true);
    expect(cfg.agentEventsEnabled).toBe(true);
  });

  it("parses LOG_PRETTY with the same strict boolean rules", async () => {
    expect((await load({ LOG_PRETTY: "false" })).logPretty).toBe(false);
    expect((await load({ LOG_PRETTY: "true" })).logPretty).toBe(true);
    await expect(load({ LOG_PRETTY: "yes" })).rejects.toThrow(
      /LOG_PRETTY must be one of true, false/,
    );
  });

  it("rejects an invalid enum", async () => {
    await expect(load({ ROLE: "bad" })).rejects.toThrow(/ROLE must be one of web, worker/);
  });

  it("normalizes slash command author associations", async () => {
    const cfg = await load({ SLASH_ALLOWED_ASSOCIATIONS: " owner, collaborator " });

    expect([...cfg.slashAllowedAssociations]).toEqual(["OWNER", "COLLABORATOR"]);
  });

  it("allows slash command association opt-out with star", async () => {
    const cfg = await load({ SLASH_ALLOWED_ASSOCIATIONS: "*" });

    expect([...cfg.slashAllowedAssociations]).toEqual(["*"]);
  });

  it("rejects unknown slash command author associations", async () => {
    await expect(load({ SLASH_ALLOWED_ASSOCIATIONS: "OWNER,STRANGER" })).rejects.toThrow(
      /SLASH_ALLOWED_ASSOCIATIONS must be/,
    );
  });

  it("normalizes and validates maintainer decision associations without wildcard access", async () => {
    const cfg = await load({ MAINTAINER_DECISION_ASSOCIATIONS: "owner, collaborator" });
    expect([...cfg.maintainerDecisionAssociations]).toEqual(["OWNER", "COLLABORATOR"]);
  });

  it.each(["", "   ", "*", "*,OWNER", "OWNER,*", "OWNER,,MEMBER"])(
    "rejects invalid maintainer decision association value %j",
    async (value) => {
      await expect(load({ MAINTAINER_DECISION_ASSOCIATIONS: value })).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).code).toBe("config.invalid_enum");
          expect((error as AppError).context).toMatchObject({
            name: "MAINTAINER_DECISION_ASSOCIATIONS",
          });
          return true;
        },
      );
    },
  );

  it("defaults verification concurrency to 1", async () => {
    const cfg = await load({});
    expect(cfg.verificationConcurrency).toBe(1);
  });

  it("throws config.missing_env with the variable name in context", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    };
    delete process.env[ENV.DATABASE_URL];
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("config.missing_env");
      expect((error as AppError).context).toEqual({ name: ENV.DATABASE_URL });
      return true;
    });
  });
});
