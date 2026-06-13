import { AUTOMATED_PR_ACTIONS } from "../../settings/index.js";

/** Durable work kinds scheduled from automated pull_request webhooks. */
type AutomatedPrIntakeKind = "review" | "description";

export type AutomatedPrIntakePlan = {
  readonly action: string;
  readonly kinds: readonly AutomatedPrIntakeKind[];
};

export type AutomatedPrIntakeOptions = {
  readonly descriptionAutoActions: ReadonlySet<string>;
};

/** Pure planner: maps webhook action → agent work kinds (no I/O). */
export function planAutomatedPullRequestIntake(
  action: string,
  opts: AutomatedPrIntakeOptions,
): AutomatedPrIntakePlan {
  const kinds: AutomatedPrIntakeKind[] = [];
  if (AUTOMATED_PR_ACTIONS.has(action)) kinds.push("review");
  if (opts.descriptionAutoActions.has(action)) kinds.push("description");
  return { action, kinds };
}
