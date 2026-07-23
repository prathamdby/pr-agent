import type { Config } from "../../src/config.js";

type TestConfigOverrides = Partial<Omit<Config, "modelProviderKeys">> & {
  readonly modelProviderKeys?: Partial<Config["modelProviderKeys"]>;
};

const baseTestConfig: Config = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "test-private-key",
  webhookSecret: "secret",
  databaseUrl: "postgres://test",
  role: "web",
  features: {
    review: "auto",
    describe: "auto",
    verification: "auto",
    ask: "manual",
    triage: "manual",
    reviewLabels: "effort",
    commitStatus: false,
    titleRewrite: false,
  },
  agentProvider: "pi",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  piOrchestratorProvider: "",
  piOrchestratorModel: "",
  piFallbackProvider: "",
  piFallbackModel: "",
  piThinkingCeiling: "high",
  agentResumeSnapshotKey: "",
  agentResumeSnapshotMarginSeconds: 600,
  piApi: "openai-responses",
  modelsJsonPath: null,
  modelProviderKeys: {
    openai: "",
    anthropic: "",
    google: "",
  },
  providerPromptTimeoutMs: 300_000,
  reviewSpecialistTimeoutMs: 900_000,
  reviewConcurrency: 2,
  askConcurrency: 1,
  ackConcurrency: 2,
  descriptionConcurrency: 1,
  triageConcurrency: 1,
  verificationConcurrency: 1,
  queueRetryLimit: 3,
  queueRetryDelaySeconds: 30,
  queueRetryDelayMaxSeconds: 300,
  queueExpireInSeconds: 3600,
  queueHeartbeatSeconds: 60,
  queuePollingIntervalSeconds: 0.5,
  queueRetentionSeconds: 1_209_600,
  queueDeleteAfterSeconds: 604_800,
  shutdownDrainTimeoutSeconds: 25,
  webhookEventsRetentionSeconds: 2_592_000,
  agentWorkRetentionSeconds: 2_592_000,
  retentionCron: "17 3 * * *",
  retentionEnabled: true,
  installationGroupConcurrency: 2,
  slashAllowedAssociations: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
  context7ApiKey: "",
  cursorApiKey: "",
  cursorRipgrepPath: "",
  posthogProjectToken: "",
  posthogHost: "",
  logLevel: "error",
  logPretty: false,
  logRedact: true,
};

export function makeTestConfig(overrides: TestConfigOverrides = {}): Config {
  const { modelProviderKeys, ...rest } = overrides;

  return {
    ...baseTestConfig,
    ...rest,
    modelProviderKeys: {
      ...baseTestConfig.modelProviderKeys,
      ...modelProviderKeys,
    },
  };
}
