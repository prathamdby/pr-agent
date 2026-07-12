import type { OnAgentToolCallMetric } from "../../agent/providers/sessionMetrics.js";
import { recordReviewMetric } from "./reviewRunMetrics.js";
import type { ReviewSessionRole } from "./reviewSessionRole.js";

export function createReviewToolCallRecorder(
  sessionRole: ReviewSessionRole,
): OnAgentToolCallMetric {
  return (event) => {
    recordReviewMetric({ ...event, sessionRole });
  };
}
