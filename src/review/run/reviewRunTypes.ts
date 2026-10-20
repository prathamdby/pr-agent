import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PgBoss } from "pg-boss";
import type { Config, AnyReviewLens } from "../../settings/index.ts";
import type { ClassifiedFailure } from "../../errors/classifiedFailure.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.ts";
import type { WorkSource } from "../reviewSchema.ts";
import type { FindingCheck } from "../findingIdentity/findingLifecycle.ts";
import type { AcceptedPlacement, ReviewCoverage } from "../orchestrator/orchestratorTypes.ts";
import type { RecordPublishStepWithCoordination } from "../publish/reviewSummaryComment.ts";
import type { FeatureSessionContext } from "../../agent/runtime/createFeatureSession.ts";
import type { RepoPolicyResult } from "../repoPolicy.ts";
import type { ReviewRecovery } from "../recovery/reviewRecovery.ts";

export type ReviewRunParams = {
  readonly recovery?: ReviewRecovery;
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
  readonly workItemId?: string;
  readonly resumedPlacements?: readonly AcceptedPlacement[];
  readonly sessionContext?: FeatureSessionContext;
  readonly boss?: PgBoss;
  readonly reviewSource?: WorkSource;
  readonly staleHeadRescheduled?: boolean;
  readonly publishAbortState?: { readonly staleHead?: boolean };
  readonly severityFloor?: number;
  readonly repoPolicy?: RepoPolicyResult;
  readonly signal?: AbortSignal;
};

export type ReviewRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly published: boolean;
  readonly publishAttempts: number;
  readonly publishStepCount: number;
  readonly publishSuperseded: boolean;
  readonly lastFailure?: ClassifiedFailure;
  readonly findingCheck?: FindingCheck;
  readonly coverage?: ReviewCoverage;
};
