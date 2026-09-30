import { AUTO_TRIGGER_ACTIONS, type Features } from "../../settings/index.js";

/** Durable work kinds scheduled from automated pull_request webhooks. */
type AutomatedPrIntakeKind =
  | "review"
  | "reviewSupersede"
  | "reviewApproval"
  | "description"
  | "verification";

export type AutomatedPrIntakePlan = {
  readonly kinds: readonly AutomatedPrIntakeKind[];
};

export function automatedIntakeDecision(plan: AutomatedPrIntakePlan) {
  if (plan.kinds.includes("review") || plan.kinds.includes("reviewApproval")) {
    return "automated_review_enqueued";
  }
  if (plan.kinds.includes("reviewSupersede")) {
    return "automated_review_supersede_requested";
  }
  return "automated_work_enqueued";
}

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
  } else if (features.review === "approval") {
    if (action === "approval") {
      // No review on `opened`: the first approving review enqueues it instead,
      // so unreviewed slop PRs start no review work. Describe and verification
      // keep their own triggers; set them to manual or off to stop all
      // open-time model spend. The supersede rule below keeps
      // approval-started reviews pinned to the latest head.
      kinds.push("reviewApproval");
    } else if (action === "synchronize") {
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
