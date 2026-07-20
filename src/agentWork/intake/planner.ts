import { AUTO_TRIGGER_ACTIONS, type Features } from "../../settings/index.js";

/** Durable work kinds scheduled from automated pull_request webhooks. */
type AutomatedPrIntakeKind = "review" | "description" | "verification";

export type AutomatedPrIntakePlan = {
  readonly kinds: readonly AutomatedPrIntakeKind[];
};

/** Pure planner: maps webhook action + feature modes → agent work kinds (no I/O). */
export function planAutomatedPullRequestIntake(
  action: string,
  features: Pick<Features, "review" | "describe" | "verification">,
): AutomatedPrIntakePlan {
  const kinds: AutomatedPrIntakeKind[] = [];
  if (features.review === "auto" && AUTO_TRIGGER_ACTIONS.review.has(action)) kinds.push("review");
  if (features.describe === "auto" && AUTO_TRIGGER_ACTIONS.describe.has(action)) {
    kinds.push("description");
  }
  if (features.verification === "auto" && AUTO_TRIGGER_ACTIONS.verification.has(action)) {
    kinds.push("verification");
  }
  return { kinds };
}
