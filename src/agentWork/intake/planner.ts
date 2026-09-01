import { AUTO_TRIGGER_ACTIONS, type Features } from "../../settings/index.js";

/** Durable work kinds scheduled from automated pull_request webhooks. */
type AutomatedPrIntakeKind = "review" | "reviewSupersede" | "description" | "verification";

export type AutomatedPrIntakePlan = {
  readonly kinds: readonly AutomatedPrIntakeKind[];
};

/** Pure planner: maps webhook action + feature modes → agent work kinds (no I/O). */
export function planAutomatedPullRequestIntake(
  action: string,
  features: Pick<Features, "review" | "describe" | "verification">,
): AutomatedPrIntakePlan {
  const kinds: AutomatedPrIntakeKind[] = [];
  if (features.review === "auto") {
    if (AUTO_TRIGGER_ACTIONS.review.has(action)) {
      kinds.push("review");
    } else if (action === "synchronize") {
      // A push starts no new review, but it must cancel and replace one that is
      // still in flight so the published review always matches the latest head.
      kinds.push("reviewSupersede");
    }
  }
  if (features.describe === "auto" && AUTO_TRIGGER_ACTIONS.describe.has(action)) {
    kinds.push("description");
  }
  if (features.verification === "auto" && AUTO_TRIGGER_ACTIONS.verification.has(action)) {
    kinds.push("verification");
  }
  return { kinds };
}
