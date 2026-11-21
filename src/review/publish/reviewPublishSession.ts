import type { AgentEventsContext } from "../../agent/runtime/agentEventSink.ts";
import type { PublishDb, PublishGate } from "../../state/publish.ts";
import type { Config, AnyReviewLens } from "../../settings/index.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { CachedPrDiffIndex } from "../../prWorkspace/reviewDiffIndex.ts";
import type { RenderableHeadCi } from "../ci/ciFacts.ts";
import type { ReviewPublishContext } from "../reviewSchema.ts";
import type { RecordPublishStepWithCoordination } from "./reviewSummaryComment.ts";
import type { FindingInventory } from "../findingIdentity/findingInventory.ts";
import {
  createReviewDuplicateCleanup,
  type ReviewDuplicateCleanup,
} from "./reviewDuplicateCleanup.ts";

export type PublishStopReason = "superseded" | "stale_head";

export type ReviewPublishConfig = Pick<Config, "models" | "features" | "agentEvents" | "review">;

export type ReviewPublishTarget = {
  readonly db: PublishDb;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly laneEpoch?: number | null;
  readonly shutdownRequested?: () => boolean;
  readonly gate?: PublishGate;
  readonly signal?: AbortSignal;
};

export type ReviewHeadCiPort = {
  readonly load: (headSha: string) => Promise<RenderableHeadCi>;
  readonly requestProjection: (headSha: string, renderedVersion: number) => void;
};

export type ReviewPublishSession = {
  readonly cfg: ReviewPublishConfig;
  readonly ctx: ReviewPublishContext;
  readonly mode: AnyReviewLens;
  readonly prSurface: PrSurface;
  readonly findingInventory: FindingInventory;
  readonly duplicateCleanup: ReviewDuplicateCleanup;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly shouldLinkToSummary?: boolean;
  readonly progressCommentIdHint?: number | null;
  readonly recordPublishStep?: RecordPublishStepWithCoordination;
  readonly agentEvents?: AgentEventsContext;
  readonly workItemId?: string;
  readonly publish?: ReviewPublishTarget;
  readonly headCi?: ReviewHeadCiPort;
  readonly commitStatusEnabled?: boolean;
  readonly resolveProgressCommentUrl: () => Promise<string | undefined>;
  readonly stopReason: () => Promise<PublishStopReason | undefined>;
  readonly policyAlert?: string;
};

export type ReviewPublishSessionInput = {
  readonly cfg: ReviewPublishConfig;
  readonly ctx: ReviewPublishContext;
  readonly prSurface: PrSurface;
  readonly findingInventory: FindingInventory;
  readonly mode?: AnyReviewLens;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly shouldLinkToSummary?: boolean;
  readonly progressCommentIdHint?: number | null;
  readonly recordPublishStep?: RecordPublishStepWithCoordination;
  readonly agentEvents?: AgentEventsContext;
  readonly workItemId?: string;
  readonly publish?: ReviewPublishTarget;
  readonly headCi?: ReviewHeadCiPort;
  readonly commitStatusEnabled?: boolean;
  readonly resolveProgressCommentUrl?: () => Promise<string | undefined>;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly publishAbortState?: { readonly staleHead?: boolean };
  readonly policyAlert?: string;
};

export function createReviewPublishSession(input: ReviewPublishSessionInput) {
  const coordination = input.recordPublishStep?.summaryCommentCoordination;
  return ((pinnedReturn: ReviewPublishSession) => pinnedReturn)({
    cfg: input.cfg,
    ctx: input.ctx,
    mode: input.mode ?? "review",
    prSurface: input.prSurface,
    findingInventory: input.findingInventory,
    duplicateCleanup: createReviewDuplicateCleanup(input.findingInventory),
    cachedDiffIndex: input.cachedDiffIndex,
    shouldLinkToSummary: input.shouldLinkToSummary,
    progressCommentIdHint: input.progressCommentIdHint,
    recordPublishStep: input.recordPublishStep,
    agentEvents: input.agentEvents,
    workItemId: input.workItemId ?? input.publish?.workItemId ?? coordination?.workItemId,
    publish: input.publish ?? coordination,
    headCi: input.headCi,
    commitStatusEnabled: input.commitStatusEnabled,
    resolveProgressCommentUrl: input.resolveProgressCommentUrl ?? (async () => undefined),
    policyAlert: input.policyAlert,
    stopReason: async () => {
      if (!((await input.shouldAbortPublish?.()) ?? false)) return undefined;
      return input.publishAbortState?.staleHead === true ? "stale_head" : "superseded";
    },
  });
}
