import type { Features } from "./featureModes.js";
import { readAskSlice, type AskSlice } from "./slices/ask.js";
import { readFeatures } from "./slices/features.js";
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
  readCodeIndexSlice,
  readCodeModeSlice,
  readContext7Slice,
  readFindingHistorySlice,
  readLoggingSlice,
  readPosthogSlice,
  readReviewSlice,
  readRuntimeSlice,
  type AgentEventsSlice,
  type CodeIndexSlice,
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
  readonly findingHistory: FindingHistorySlice;
  readonly codeIndex: CodeIndexSlice;
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
  return {
    runtime,
    github,
    webhook,
    associations: readAssociationsSlice(),
    features: readFeatures(),
    models,
    provider,
    agentEvents: readAgentEventsSlice(),
    findingHistory: readFindingHistorySlice(),
    codeIndex: readCodeIndexSlice(),
    codeMode: readCodeModeSlice(),
    review: readReviewSlice(),
    concurrency: readConcurrencySlice(),
    ask: readAskSlice(),
    queue: readQueueSlice(),
    retention: readRetentionSlice(),
    context7: readContext7Slice(),
    posthog: readPosthogSlice(),
    logging: readLoggingSlice(),
  };
}
