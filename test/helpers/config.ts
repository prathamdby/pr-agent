import type { Config } from "../../src/settings/index.ts";
import { TEST_PRIVATE_KEY_PEM } from "./testKey.ts";

export const CONFIG_BASE_ENV = {
  GITHUB_APP_ID: "1",
  WEBHOOK_SECRET: "secret",
};

export async function loadConfigWithBaseEnv(extra: Record<string, string> = {}) {
  process.env = {
    ...CONFIG_BASE_ENV,
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    ...extra,
  };
  const { loadConfig } = await import("../../src/settings/index.ts");
  return loadConfig();
}

type ModelsOverrides = Partial<Omit<Config["models"], "providerKeys">> & {
  readonly providerKeys?: Partial<Config["models"]["providerKeys"]>;
};

export type TestConfigOverrides = {
  readonly [K in keyof Config]?: K extends "models" ? ModelsOverrides : Partial<Config[K]>;
};

const baseTestConfig: Config = {
  runtime: {
    port: 0,
    sqliteDir: "./data/test",
    sqliteDbPath: null,
    shutdownGraceMs: 25_000,
    piDurableResetMaxBytes: 2_147_483_648,
    piDurableResetMaxAgeSeconds: 2_592_000,
  },
  github: { appId: "1", privateKey: "test-private-key" },
  webhook: { secret: "secret", timeoutMs: 10_000, maxBodyBytes: 25_000_000 },
  associations: {
    slashAllowed: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
    maintainerDecision: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
  },
  features: {
    review: "auto",
    reviewCadence: "once",
    describe: "auto",
    verification: "auto",
    ask: "manual",
    triage: "manual",
    reviewLabels: "size",
    commitStatus: false,
    titleRewrite: true,
  },
  models: {
    provider: "openai",
    model: "gpt-4o-mini",
    orchestratorProvider: "",
    orchestratorModel: "",
    fallbackProvider: "",
    fallbackModel: "",
    thinkingCeiling: "high",
    api: "openai-responses",
    jsonPath: null,
    providerKeys: { openai: "", anthropic: "", google: "" },
  },
  provider: { promptTimeoutMs: 300_000, retryMax: 2, maxRetryDelayMs: 60_000 },
  agentEvents: { enabled: true, retentionSeconds: 0 },
  codeMode: { executorKind: "in_process" },
  review: {
    specialistTimeoutMs: 900_000,
    testsEvidence: false,
    checkFailSeverity: "P2",
    maxInlineComments: 50,
    maxThreadPublishCalls: 8,
  },
  concurrency: {
    review: 2,
    ask: 1,
    ack: 2,
    description: 1,
    triage: 1,
    verification: 1,
  },
  ask: {
    actorMaxOutstanding: 2,
    repositoryMaxOutstanding: 8,
    installationMaxOutstanding: 32,
    actorBurst: 3,
    repositoryBurst: 12,
    installationBurst: 48,
    actorRefillSeconds: 60,
    repositoryRefillSeconds: 10,
    installationRefillSeconds: 1,
    providerBudgetTokens: 0,
    providerBudgetWindowSeconds: 86_400,
    providerReservationTokens: 16_384,
  },
  queue: {
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryDelayMaxSeconds: 300,
  },
  retention: {
    webhookEventsSeconds: 2_592_000,
    agentWorkSeconds: 2_592_000,
    enabled: true,
  },
  posthog: { projectToken: "", host: "" },
  logging: { level: "error", pretty: false, redact: true },
};

export function makeTestConfig(overrides: TestConfigOverrides = {}) {
  const base = baseTestConfig;
  return ((pinnedReturn: Config) => pinnedReturn)({
    runtime: { ...base.runtime, ...overrides.runtime },
    github: { ...base.github, ...overrides.github },
    webhook: { ...base.webhook, ...overrides.webhook },
    associations: { ...base.associations, ...overrides.associations },
    features: { ...base.features, ...overrides.features },
    models: {
      ...base.models,
      ...overrides.models,
      providerKeys: { ...base.models.providerKeys, ...overrides.models?.providerKeys },
    },
    provider: { ...base.provider, ...overrides.provider },
    agentEvents: { ...base.agentEvents, ...overrides.agentEvents },
    codeMode: { ...base.codeMode, ...overrides.codeMode },
    review: { ...base.review, ...overrides.review },
    concurrency: { ...base.concurrency, ...overrides.concurrency },
    ask: { ...base.ask, ...overrides.ask },
    queue: { ...base.queue, ...overrides.queue },
    retention: { ...base.retention, ...overrides.retention },
    posthog: { ...base.posthog, ...overrides.posthog },
    logging: { ...base.logging, ...overrides.logging },
  });
}
