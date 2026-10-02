import type { Features } from "../../settings/index.js";
import type { ReviewAuthorTrust } from "../../commands/slashAssociation.js";

/** Durable work kinds scheduled from automated pull_request webhooks. */
type AutomatedPrIntakeKind =
  | "review"
  | "reviewSupersede"
  | "reviewAwaitApproval"
  | "reviewTrackAwaitingHead"
  | "description"
  | "verification";

export type AutomatedPrIntakePlan = {
  readonly kinds: readonly AutomatedPrIntakeKind[];
};

export function automatedIntakeDecision(plan: AutomatedPrIntakePlan) {
  if (plan.kinds.includes("review")) {
    return "automated_review_enqueued";
  }
  if (plan.kinds.includes("reviewAwaitApproval")) return "review_awaiting_approval";
  if (plan.kinds.includes("reviewSupersede")) {
    return "automated_review_supersede_requested";
  }
  return "automated_work_enqueued";
}

/** Pure planner: maps webhook action + feature modes → agent work kinds (no I/O). */
export function planAutomatedPullRequestIntake(
  action: string,
  features: Pick<Features, "review" | "describe" | "verification">,
  authorTrust: ReviewAuthorTrust = "awaiting_approval",
): AutomatedPrIntakePlan {
  const kinds: AutomatedPrIntakeKind[] = [];
  switch (action) {
    case "opened":
      if (
        features.review === "auto" ||
        (features.review === "approval" && authorTrust === "trusted")
      ) {
        kinds.push("review");
      } else if (features.review === "approval") {
        kinds.push("reviewAwaitApproval");
      }
      if (features.describe === "auto") kinds.push("description");
      break;
    case "synchronize":
      if (features.review !== "manual") kinds.push("reviewSupersede");
      if (features.review === "approval") kinds.push("reviewTrackAwaitingHead");
      if (features.verification === "auto") kinds.push("verification");
      break;
  }
  return { kinds };
}
