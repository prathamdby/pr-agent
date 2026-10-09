import type { Features } from "./featureModes.js";
import { readTracesSlice, type TracesSlice } from "./slices/traces.js";
import { readAskSlice, type AskSlice } from "./slices/ask.js";
import { readFeatures } from "./slices/features.js";
import { REMOVED_ENV_KEYS } from "./envKeys.js";
import { setEnvNames } from "./envReaders.js";
import {
  readAssociationsSlice,
  readGithubSlice,
  readWebhookSlice,
  type AssociationsSlice,
  type GithubSlice,
  type WebhookSlice,
} from "./slices/github.js";
import {
  readModelsSlice,
  readProviderSlice,
  type ModelsSlice,
  type ProviderSlice,
} from "./slices/models.js";
import {
  readConcurrencySlice,
  readQueueSlice,
  readRetentionSlice,
  type ConcurrencySlice,
  type QueueSlice,
  type RetentionSlice,
} from "./slices/queue.js";
import {
  readAgentEventsSlice,
  readCodeModeSlice,
  readContext7Slice,
  readFindingHistorySlice,
  readLoggingSlice,
  readPosthogSlice,
  readReviewSlice,
  readRuntimeSlice,
  type AgentEventsSlice,
  type CodeModeSlice,
  type Context7Slice,
  type FindingHistorySlice,
  type LoggingSlice,
  type PosthogSlice,
  type ReviewSlice,
  type RuntimeSlice,
} from "./slices/service.js";

/** Nested by owner. A consumer takes `Pick<Config, "queue">`, never the whole object. */
export type Config = {
  readonly runtime: RuntimeSlice;
  readonly github: GithubSlice;
  readonly webhook: WebhookSlice;
  readonly associations: AssociationsSlice;
  readonly features: Features;
  readonly models: ModelsSlice;
  readonly provider: ProviderSlice;
  readonly agentEvents: AgentEventsSlice;
  readonly traces: TracesSlice;
  readonly findingHistory: FindingHistorySlice;
  /** Removed settings that are still set in the environment; boot logs them. */
  readonly removedEnv: readonly string[];
  readonly codeMode: CodeModeSlice;
  readonly review: ReviewSlice;
  readonly concurrency: ConcurrencySlice;
  readonly ask: AskSlice;
  readonly queue: QueueSlice;
  readonly retention: RetentionSlice;
  readonly context7: Context7Slice;
  readonly posthog: PosthogSlice;
  readonly logging: LoggingSlice;
};

export async function loadConfig(): Promise<Config> {
  const runtime = readRuntimeSlice();
  const github = readGithubSlice();
  const webhook = readWebhookSlice();
  const models = await readModelsSlice(runtime.role);
  const provider = readProviderSlice();
  const retention = readRetentionSlice();
  return {
    runtime,
    github,
    webhook,
    associations: readAssociationsSlice(),
    features: readFeatures(),
    models,
    provider,
    agentEvents: readAgentEventsSlice(),
    traces: readTracesSlice(retention.agentWorkSeconds),
    findingHistory: readFindingHistorySlice(),
    removedEnv: setEnvNames(REMOVED_ENV_KEYS),
    codeMode: readCodeModeSlice(),
    review: readReviewSlice(),
    concurrency: readConcurrencySlice(),
    ask: readAskSlice(),
    queue: readQueueSlice(),
    retention,
    context7: readContext7Slice(),
    posthog: readPosthogSlice(),
    logging: readLoggingSlice(),
  };
}
