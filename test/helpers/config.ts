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
  agentProvider: "pi",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  modelProviderKeys: {
    openai: "",
    anthropic: "",
    google: "",
  },
  maxToolRounds: 24,
  providerPromptTimeoutMs: 300_000,
  maxReviewPublishAttempts: 3,
  maxReviewPublishCalls: 2,
  reviewMinConfidence: 1,
  reviewConcurrency: 2,
  askConcurrency: 1,
  ackConcurrency: 2,
  descriptionConcurrency: 1,
  maxToolRoundsDescribe: 16,
  descriptionGenerateTitle: false,
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
  maxAskToolRounds: 12,
  maxAskFinalizeRounds: 2,
  webhookMaxBodyBytes: 25_000_000,
  webhookTimeoutMs: 10_000,
  context7ApiKey: "",
  cursorApiKey: "",
  enableReviewLabelsEffort: true,
  enableReviewLabelsSecurity: false,
  maxPrFilesListed: 300,
  maxPrFilesPatchBytes: 500_000,
  logLevel: "error",
  logMaxWideEvents: 128,
  logPretty: false,
  logRedact: true,
  reviewInjectAnchorMenu: true,
  reviewRequireDiffCacheBeforeSubmit: true,
  reviewAnchorMenuMaxFiles: 40,
  reviewAnchorMenuMaxRangesPerFile: 20,
  localWorkspaceCloneTimeoutMs: 30_000,
  localWorkspaceFetchTimeoutMs: 30_000,
  localWorkspaceSearchMaxFiles: 20,
  localWorkspaceMaxFileBytes: 100_000,
  localWorkspaceSearchMaxTotalBytes: 1_000_000,
  localWorkspaceMaxDiffBytes: 1_000_000,
  localWorkspaceMinFreeSpaceBytes: 1,
  localWorkspaceFullCloneMaxRepoKb: 1_000,
  localWorkspaceStaleCleanupAgeSeconds: 1,
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
