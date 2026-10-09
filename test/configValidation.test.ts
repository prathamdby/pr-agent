import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import { ENV, type Config } from "../src/settings/index.js";
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
  const { loadConfig } = await import("../src/settings/index.js");
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
    expect(cfg.runtime.port).toBe(3000);
    expect(cfg.provider.promptTimeoutMs).toBe(300_000);
    expect(cfg.review.specialistTimeoutMs).toBe(900_000);
    expect(cfg.review.recoveryEnabled).toBe(false);
    expect(cfg.provider.retryMax).toBe(2);
    expect(cfg.provider.maxRetryDelayMs).toBe(60_000);
    expect(cfg.queue.retryLimit).toBe(3);
    expect(cfg.queue.heartbeatSeconds).toBe(60);
    expect(cfg.queue.shutdownDrainTimeoutSeconds).toBe(25);
    expect(cfg.retention.enabled).toBe(true);
    expect(cfg.logging.redact).toBe(true);
    expect(cfg.runtime.role).toBe("web");
    expect(cfg.logging.level).toBe("info");
    expect([...cfg.associations.slashAllowed]).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
    expect([...cfg.associations.maintainerDecision]).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
    expect(cfg.ask.actorMaxOutstanding).toBe(2);
    expect(cfg.ask.repositoryMaxOutstanding).toBe(8);
    expect(cfg.ask.installationMaxOutstanding).toBe(32);
    expect(cfg.ask.providerBudgetTokens).toBe(0);
    expect(cfg.ask.providerReservationTokens).toBe(16_384);
    expect(cfg.codeMode.executorKind).toBe("in_process");
  });

  it("loads when retired trace and code index variables are set", async () => {
    const withValues = await load({
      TRACES_MODE: "metadata",
      TRACES_RETENTION_SECONDS: "86400",
      TRACES_BUFFER_MAX_SPANS: "32",
      CODE_INDEX_MODE: "fts",
      CODE_INDEX_WAIT_MS: "1000",
      CODE_INDEX_RETENTION_SECONDS: "3600",
    });
    expect(withValues.runtime.role).toBe("web");
    const withEmpty = await load({ TRACES_MODE: "" });
    expect(withEmpty.runtime.role).toBe("web");
  });

  it("rejects a non-numeric positive knob", async () => {
    await expect(load({ PROVIDER_PROMPT_TIMEOUT_MS: "abc" })).rejects.toThrow(
      /PROVIDER_PROMPT_TIMEOUT_MS must be a positive number/,
    );
  });

  it("rejects a non-integer provider retry count", async () => {
    await expect(load({ PI_PROVIDER_RETRY_MAX: "1.5" })).rejects.toThrow(
      /PI_PROVIDER_RETRY_MAX must be zero or a non-negative integer/,
    );
  });

  it("allows zero to disable provider transport retry", async () => {
    const cfg = await load({ PI_PROVIDER_RETRY_MAX: "0" });
    expect(cfg.provider.retryMax).toBe(0);
  });

  it("rejects a provider retry delay cap at or above the inactivity cap", async () => {
    await expect(
      load({
        PI_PROVIDER_MAX_RETRY_DELAY_MS: "300000",
        PROVIDER_PROMPT_TIMEOUT_MS: "300000",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("config.invalid_number");
      expect((error as AppError).message).toContain(
        "PI_PROVIDER_MAX_RETRY_DELAY_MS must be less than PROVIDER_PROMPT_TIMEOUT_MS",
      );
      return true;
    });
    await expect(
      load({
        PI_PROVIDER_MAX_RETRY_DELAY_MS: "310000",
        PROVIDER_PROMPT_TIMEOUT_MS: "300000",
      }),
    ).rejects.toThrow(
      /PI_PROVIDER_MAX_RETRY_DELAY_MS must be less than PROVIDER_PROMPT_TIMEOUT_MS/,
    );
  });

  it("allows zero for zero-or-positive knobs", async () => {
    const cfg = await load({ QUEUE_RETRY_LIMIT: "0" });
    expect(cfg.queue.retryLimit).toBe(0);
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
    ["LOG_REDACT", (c: Config) => c.logging.redact] as const,
    ["AGENT_EVENTS_ENABLED", (c: Config) => c.agentEvents.enabled] as const,
    ["FINDING_HISTORY_ENABLED", (c: Config) => c.findingHistory.enabled] as const,
    ["RETENTION_ENABLED", (c: Config) => c.retention.enabled] as const,
    ["REVIEW_RECOVERY_ENABLED", (c: Config) => c.review.recoveryEnabled] as const,
  ])("parses boolean knob %s as strict true/false", async (name, field) => {
    expect(field(await load({ [name]: "false" }))).toBe(false);
    expect(field(await load({ [name]: "true" }))).toBe(true);
    await expect(load({ [name]: "1" })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("config.invalid_enum");
      expect((error as AppError).context).toMatchObject({ name });
      return true;
    });
  });

  it("treats empty strict boolean env as the default", async () => {
    const cfg = await load({ LOG_REDACT: "", AGENT_EVENTS_ENABLED: "   " });
    expect(cfg.logging.redact).toBe(true);
    expect(cfg.agentEvents.enabled).toBe(true);
  });

  it.each(["", "   ", "false", "true"])("reads the review recovery flag %j", async (value) => {
    expect((await load({ REVIEW_RECOVERY_ENABLED: value })).review.recoveryEnabled).toBe(
      value === "true",
    );
  });

  it.each(["1", "0", "yes", "TRUE", "False", " true ", " false "])(
    "rejects the review recovery flag typo %j",
    async (value) => {
      await expect(load({ REVIEW_RECOVERY_ENABLED: value })).rejects.toMatchObject({
        code: "config.invalid_enum",
        context: { name: "REVIEW_RECOVERY_ENABLED" },
      });
    },
  );

  it("parses LOG_PRETTY with the same strict boolean rules", async () => {
    expect((await load({ LOG_PRETTY: "false" })).logging.pretty).toBe(false);
    expect((await load({ LOG_PRETTY: "true" })).logging.pretty).toBe(true);
    await expect(load({ LOG_PRETTY: "yes" })).rejects.toThrow(
      /LOG_PRETTY must be one of true, false/,
    );
  });

  it("rejects an invalid enum", async () => {
    await expect(load({ ROLE: "bad" })).rejects.toThrow(/ROLE must be one of web, worker/);
  });

  it("normalizes slash command author associations", async () => {
    const cfg = await load({ SLASH_ALLOWED_ASSOCIATIONS: " owner, collaborator " });

    expect([...cfg.associations.slashAllowed]).toEqual(["OWNER", "COLLABORATOR"]);
  });

  it("allows slash command association opt-out with star", async () => {
    const cfg = await load({ SLASH_ALLOWED_ASSOCIATIONS: "*" });

    expect([...cfg.associations.slashAllowed]).toEqual(["*"]);
  });

  it("rejects unknown slash command author associations", async () => {
    await expect(load({ SLASH_ALLOWED_ASSOCIATIONS: "OWNER,STRANGER" })).rejects.toThrow(
      /SLASH_ALLOWED_ASSOCIATIONS must be/,
    );
  });

  it("normalizes and validates maintainer decision associations without wildcard access", async () => {
    const cfg = await load({ MAINTAINER_DECISION_ASSOCIATIONS: "owner, collaborator" });
    expect([...cfg.associations.maintainerDecision]).toEqual(["OWNER", "COLLABORATOR"]);
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
    expect(cfg.concurrency.verification).toBe(1);
  });

  it("throws config.missing_env with the variable name in context", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    };
    delete process.env[ENV.DATABASE_URL];
    const { loadConfig } = await import("../src/settings/index.js");
    await expect(loadConfig()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("config.missing_env");
      expect((error as AppError).context).toEqual({ name: ENV.DATABASE_URL });
      return true;
    });
  });
});
