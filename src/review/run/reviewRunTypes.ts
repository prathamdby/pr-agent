import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import type { WorkSource, ReviewMode } from "../reviewSchema.js";

export type ReviewRunParams = {
  readonly cfg: Config;
  readonly token: string;
  readonly tokenExpiresAtTs: number;
  readonly tokenTtlMs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mode?: ReviewMode;
  readonly userSupplement?: string;
  readonly trustedContext?: string;
  readonly cwd?: string;
  readonly workspace: LocalPrWorkspace;
  readonly shouldLinkToSummary?: boolean;
  readonly summaryCommentIdHint?: number | null;
  readonly initialPublishState?: {
    readonly published?: boolean;
    readonly inlinePublished?: boolean;
    readonly inlineReviewId?: number | null;
  };
  readonly recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { readonly githubId?: string | number; readonly meta?: Record<string, unknown> },
  ) => Promise<void>;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly storedInlineFingerprints?: readonly string[];
  readonly refreshInstallationToken?: () => Promise<{
    readonly token: string;
    readonly expiresAtTs: number;
  }>;
  readonly reviewSource?: WorkSource;
  readonly staleHeadRescheduled?: boolean;
  readonly publishAbortState?: { readonly staleHead?: boolean };
  readonly severityFloor?: number;
};

export type ReviewRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly published: boolean;
  readonly publishAttempts: number;
  readonly publishSuperseded: boolean;
};
