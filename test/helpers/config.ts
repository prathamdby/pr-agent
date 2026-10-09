import type { Config } from "../../src/settings/index.js";

type ModelsOverrides = Partial<Omit<Config["models"], "providerKeys">> & {
  readonly providerKeys?: Partial<Config["models"]["providerKeys"]>;
};

/** Per-slice partial overrides; unnamed fields keep the test defaults. */
export type TestConfigOverrides = {
  readonly [K in keyof Config]?: K extends "models" ? ModelsOverrides : Partial<Config[K]>;
};

const baseTestConfig: Config = {
  runtime: { port: 0, databaseUrl: "postgres://test", role: "web" },
  github: { appId: "1", privateKey: "test-private-key" },
  webhook: { secret: "secret", timeoutMs: 10_000, maxBodyBytes: 25_000_000 },
  associations: {
    slashAllowed: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
    maintainerDecision: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
  },
  features: {
    review: "auto",
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
  traces: { mode: "metadata", retentionSeconds: 1_209_600, bufferMaxSpans: 400 },
  findingHistory: { enabled: true, dismissSuppressAfter: 3, lookbackDays: 180 },
  removedEnv: [],
  codeMode: { executorKind: "in_process" },
  review: {
    specialistTimeoutMs: 900_000,
    recoveryEnabled: false,
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
    installationGroup: 2,
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
    expireInSeconds: 3600,
    prActorLeaseTtlSeconds: 900,
    prActorLeaseRenewalIntervalSeconds: 120,
    heartbeatSeconds: 60,
    pollingIntervalSeconds: 0.5,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    shutdownDrainTimeoutSeconds: 25,
  },
  retention: {
    webhookEventsSeconds: 2_592_000,
    agentWorkSeconds: 2_592_000,
    cron: "17 3 * * *",
    enabled: true,
  },
  context7: { apiKey: "" },
  posthog: { projectToken: "", host: "" },
  logging: { level: "error", pretty: false, redact: true },
};

export function makeTestConfig(overrides: TestConfigOverrides = {}): Config {
  const base = baseTestConfig;
  return {
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
    traces: { ...base.traces, ...overrides.traces },
    findingHistory: { ...base.findingHistory, ...overrides.findingHistory },
    removedEnv: base.removedEnv,
    codeMode: { ...base.codeMode, ...overrides.codeMode },
    review: { ...base.review, ...overrides.review },
    concurrency: { ...base.concurrency, ...overrides.concurrency },
    ask: { ...base.ask, ...overrides.ask },
    queue: { ...base.queue, ...overrides.queue },
    retention: { ...base.retention, ...overrides.retention },
    context7: { ...base.context7, ...overrides.context7 },
    posthog: { ...base.posthog, ...overrides.posthog },
    logging: { ...base.logging, ...overrides.logging },
  };
}
