import type { Features } from "./featureModes.ts";
import { readAskSlice, type AskSlice } from "./slices/ask.ts";
import { readFeatures } from "./slices/features.ts";
import {
  readAssociationsSlice,
  readGithubSlice,
  readWebhookSlice,
  type AssociationsSlice,
  type GithubSlice,
  type WebhookSlice,
} from "./slices/github.ts";
import {
  readModelsSlice,
  readProviderSlice,
  type ModelsSlice,
  type ProviderSlice,
} from "./slices/models.ts";
import {
  readConcurrencySlice,
  readQueueSlice,
  readRetentionSlice,
  type ConcurrencySlice,
  type QueueSlice,
  type RetentionSlice,
} from "./slices/queue.ts";
import {
  readAgentEventsSlice,
  readCodeModeSlice,
  readLoggingSlice,
  readPosthogSlice,
  readReviewSlice,
  readRuntimeSlice,
  type AgentEventsSlice,
  type CodeModeSlice,
  type LoggingSlice,
  type PosthogSlice,
  type ReviewSlice,
  type RuntimeSlice,
} from "./slices/service.ts";

export type Config = {
  readonly runtime: RuntimeSlice;
  readonly github: GithubSlice;
  readonly webhook: WebhookSlice;
  readonly associations: AssociationsSlice;
  readonly features: Features;
  readonly models: ModelsSlice;
  readonly provider: ProviderSlice;
  readonly agentEvents: AgentEventsSlice;
  readonly codeMode: CodeModeSlice;
  readonly review: ReviewSlice;
  readonly concurrency: ConcurrencySlice;
  readonly ask: AskSlice;
  readonly queue: QueueSlice;
  readonly retention: RetentionSlice;
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
    codeMode: readCodeModeSlice(),
    review: readReviewSlice(),
    concurrency: readConcurrencySlice(),
    ask: readAskSlice(),
    queue: readQueueSlice(),
    retention,
    posthog: readPosthogSlice(),
    logging: readLoggingSlice(),
  };
}
