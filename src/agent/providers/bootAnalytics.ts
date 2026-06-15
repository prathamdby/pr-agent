import type { Config } from "../../config.js";
import { posthog } from "../../posthog.js";

const WORKER_DISTINCT_ID = "worker";

export function captureAgentProviderBootFailure(
  provider: Config["agentProvider"],
  error: unknown,
): void {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  posthog.capture({
    distinctId: WORKER_DISTINCT_ID,
    event: "agent provider boot failed",
    properties: {
      provider,
      error_message: errorObj.message,
    },
  });
  posthog.captureException(errorObj, WORKER_DISTINCT_ID, {
    type: "agent_provider_boot",
    provider,
  });
}
