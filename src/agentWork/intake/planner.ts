/** Durable work kinds scheduled from automated pull_request webhooks. */
type AutomatedPrIntakeKind = "review" | "description" | "verification";

export type AutomatedPrIntakePlan = {
  readonly action: string;
  readonly kinds: readonly AutomatedPrIntakeKind[];
};

export type AutomatedPrIntakeOptions = {
  /** `pull_request` actions that auto-run `/review`. Defaults to `opened` only so a PR is reviewed once at the start; follow-up pushes need a manual `/review`. */
  readonly reviewAutoActions: ReadonlySet<string>;
  readonly descriptionAutoActions: ReadonlySet<string>;
  /** `pull_request` actions that auto-trigger verification runs. Defaults to `synchronize`; empty set disables. */
  readonly verificationAutoActions: ReadonlySet<string>;
};

/** Pure planner: maps webhook action → agent work kinds (no I/O). */
export function planAutomatedPullRequestIntake(
  action: string,
  opts: AutomatedPrIntakeOptions,
): AutomatedPrIntakePlan {
  const kinds: AutomatedPrIntakeKind[] = [];
  if (opts.reviewAutoActions.has(action)) kinds.push("review");
  if (opts.descriptionAutoActions.has(action)) kinds.push("description");
  if (opts.verificationAutoActions.has(action)) kinds.push("verification");
  return { action, kinds };
}
