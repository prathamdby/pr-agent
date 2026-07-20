/** Feature tier: the only user-facing settings. Catalog: docs/features.md. */

export const REVIEW_FEATURE_MODES = ["manual", "auto"] as const;
export const DESCRIBE_FEATURE_MODES = ["off", "manual", "auto"] as const;
export const VERIFICATION_FEATURE_MODES = ["off", "auto"] as const;
export const COMMAND_FEATURE_MODES = ["off", "manual"] as const;
export const REVIEW_LABELS_MODES = ["off", "effort", "effort+security"] as const;

export type ReviewFeatureMode = (typeof REVIEW_FEATURE_MODES)[number];
export type DescribeFeatureMode = (typeof DESCRIBE_FEATURE_MODES)[number];
export type VerificationFeatureMode = (typeof VERIFICATION_FEATURE_MODES)[number];
export type CommandFeatureMode = (typeof COMMAND_FEATURE_MODES)[number];
export type ReviewLabelsMode = (typeof REVIEW_LABELS_MODES)[number];

export type Features = {
  readonly review: ReviewFeatureMode;
  readonly describe: DescribeFeatureMode;
  readonly verification: VerificationFeatureMode;
  readonly ask: CommandFeatureMode;
  readonly triage: CommandFeatureMode;
  readonly reviewLabels: ReviewLabelsMode;
  readonly commitStatus: boolean;
  readonly titleRewrite: boolean;
};

export const DEFAULT_FEATURE_REVIEW: ReviewFeatureMode = "auto";
export const DEFAULT_FEATURE_DESCRIBE: DescribeFeatureMode = "auto";
export const DEFAULT_FEATURE_VERIFICATION: VerificationFeatureMode = "auto";
export const DEFAULT_FEATURE_ASK: CommandFeatureMode = "manual";
export const DEFAULT_FEATURE_TRIAGE: CommandFeatureMode = "manual";
export const DEFAULT_FEATURE_REVIEW_LABELS: ReviewLabelsMode = "effort";
export const DEFAULT_FEATURE_COMMIT_STATUS = false;
export const DEFAULT_FEATURE_TITLE_REWRITE = false;

/** `pull_request` actions that fire each capability in `auto` mode. Not configurable on purpose. */
export const AUTO_TRIGGER_ACTIONS = {
  review: new Set(["opened"]),
  describe: new Set(["opened"]),
  verification: new Set(["synchronize"]),
} as const;
