import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { ListPullRequestFilesResult } from "../../github/listPullRequestFiles.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import type { ReviewerId } from "../prompts/reviewerPrompt.js";
import type { WorkSource, ReviewMode } from "../reviewSchema.js";
import type {
  ReviewCriticCheckpointStore,
  ReviewPayloadCheckpointStore,
} from "./reviewCriticCheckpoint.js";
import type { ReviewBudgetTier } from "./reviewSizeBudget.js";

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
  readonly budgetTier?: ReviewBudgetTier;
  readonly selectedReviewerIds?: readonly ReviewerId[];
  readonly omittedReviewerIds?: readonly ReviewerId[];
  readonly cwd?: string;
  readonly workspace: LocalPrWorkspace;
  /** Complete PR file listing; required to run the hybrid pipeline (KTD1). */
  readonly prFiles?: ListPullRequestFilesResult;
  /** Durable checkpoint stores for the hybrid pipeline (KTD5, KTD8). */
  readonly hybrid?: {
    readonly workItemId: string;
    readonly criticStore: ReviewCriticCheckpointStore;
    readonly payloadStore: ReviewPayloadCheckpointStore;
  };
  readonly shouldLinkToSummary?: boolean;
  readonly summaryCommentIdHint?: number | null;
  readonly hasDescriptionAgentBlock?: boolean;
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
