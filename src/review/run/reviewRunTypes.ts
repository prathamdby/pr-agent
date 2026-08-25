import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { ClassifiedFailure } from "../../errors/classifiedFailure.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import type { WorkSource } from "../reviewSchema.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type { AcceptedPlacement } from "../orchestrator/orchestratorTypes.js";
import type { RecordPublishStepWithCoordination } from "../publish/publishSummaryOnly.js";
import type { FeatureSessionDurability } from "../../agent/runtime/sessionDurability.js";

export type ReviewRunParams = {
  readonly cfg: Config;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mode?: AnyReviewLens;
  readonly userSupplement?: string;
  readonly trustedContext?: string;
  readonly cwd?: string;
  readonly workspace: LocalPrWorkspace;
  readonly shouldLinkToSummary?: boolean;
  readonly progressCommentIdHint?: number | null;
  readonly hasDescriptionReviewMap?: boolean;
  readonly initialPublishState?: {
    readonly published?: boolean;
    readonly inlineReviewIds?: readonly number[];
    readonly threadCallCount?: number;
  };
  readonly recordPublishStep?: RecordPublishStepWithCoordination;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly storedInlineFingerprints?: readonly string[];
  readonly crossPrSuppressionFingerprints?: readonly string[];
  readonly workItemId?: string;
  readonly resumedPlacements?: readonly AcceptedPlacement[];
  readonly durability?: FeatureSessionDurability;
  readonly reviewSource?: WorkSource;
  readonly staleHeadRescheduled?: boolean;
  readonly publishAbortState?: { readonly staleHead?: boolean };
  readonly severityFloor?: number;
  readonly codeIndexSnapshotId?: string;
  readonly sameRepo?: boolean;
};

export type ReviewRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly published: boolean;
  readonly publishAttempts: number;
  readonly publishSuperseded: boolean;
  /** Last classified external/internal failure from the run (soft-fail diagnostics). */
  readonly lastFailure?: ClassifiedFailure;
};
