import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/index.js";
import type { WorkSource } from "./reviewSchema.js";
import type { ReviewMode } from "./reviewSchema.js";
import { runReviewHarness } from "./reviewRunHarness.js";

export type ReviewRunResult = {
  lastAssistant: AssistantMessage;
  published: boolean;
  publishAttempts: number;
  publishSuperseded: boolean;
};

export async function runFullPrReview(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  mode?: ReviewMode;
  userSupplement?: string;
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
  initialPublishState?: {
    published?: boolean;
    inlinePublished?: boolean;
    inlineReviewId?: number | null;
  };
  recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { githubId?: string | number; meta?: Record<string, unknown> },
  ) => Promise<void>;
  shouldAbortPublish?: () => Promise<boolean>;
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  trustedContext?: string;
  storedInlineFingerprints?: readonly string[];
  cwd?: string;
  workspace?: LocalPrWorkspace;
  reviewSource?: WorkSource;
  staleHeadRescheduled?: boolean;
  publishAbortState?: { staleHead?: boolean };
}): Promise<ReviewRunResult> {
  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  if (!Number.isFinite(params.tokenTtlMs) || params.tokenTtlMs <= 0) {
    throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
  }

  return runReviewHarness({
    ...params,
    reviewMode: params.mode ?? "review",
  });
}
