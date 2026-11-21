import type { DatabaseSync } from "node:sqlite";
import type { WorkCompletion } from "../../analytics/workCompleted.ts";
import type { createFeaturePiSession } from "../../agent/runtime/createFeatureSession.ts";
import type { PullRequestForFileList } from "../../github/listPullRequestFiles.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type {
  PreparePrRepositoryViewParams,
  PrRepositoryView,
} from "../../prWorkspace/prRepositoryView.ts";
import type { Config } from "../../settings/index.ts";
import type { ReviewMode } from "../../review/reviewSchema.ts";
import type { FeaturePublication } from "../../state/featurePublication.ts";
import type { EscalationPlan } from "../retryPolicy.ts";
import type { AgentWorkItem, WorkType } from "../types.ts";

export type FeatureSessionFactory = typeof createFeaturePiSession;

export type FeatureExecutionResult = {
  readonly kind: "completed";
  readonly degradation?: readonly string[];
  readonly completion?: WorkCompletion;
};

export type FeatureExecutionEnv = {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly publication: FeaturePublication;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly pullRequest?: PullRequestForFileList;
  readonly signal: AbortSignal;
  readonly attemptNo: number;
  readonly escalation?: EscalationPlan;
  readonly createSession: FeatureSessionFactory;
  readonly withRepositoryView: <T>(
    options: Pick<PreparePrRepositoryViewParams, "repositorySizeKb" | "prFiles" | "baseSha">,
    run: (view: PrRepositoryView) => Promise<T>,
  ) => Promise<T>;
  readonly shouldAbortPublish: () => Promise<boolean>;
};

export type FeatureTerminalEnv = {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly publication: FeaturePublication;
};

export type FeatureWorkExecution<T extends WorkType> = {
  readonly execute: (
    item: Extract<AgentWorkItem, { type: T }>,
    env: FeatureExecutionEnv,
  ) => Promise<FeatureExecutionResult>;
  readonly onTerminalFailure?: (
    item: Extract<AgentWorkItem, { type: T }>,
    prSurface: PrSurface | undefined,
    env: FeatureTerminalEnv,
  ) => Promise<void>;
};

export type FeatureWorkDependencies = {
  readonly cfg: Config;
  readonly botIdentity: () => Promise<{ readonly userId: number; readonly login: string }>;
};

export type ReviewVerdictTarget = {
  readonly publication: FeaturePublication;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly commitStatusEnabled: boolean;
};

export type ReviewSurfacePublisher = {
  readonly tickProgressSummary: (params: {
    readonly publication: FeaturePublication;
    readonly prSurface: PrSurface;
    readonly resourceKey: string;
    readonly reviewLens: ReviewMode;
    readonly workItemId?: string;
    readonly body: string;
    readonly progressRevision: number;
    readonly ciHeadSha?: string;
    readonly ciVersion?: number;
    readonly shouldPublish?: () => boolean;
  }) => Promise<void>;
  readonly pendingVerdict: (
    params: ReviewVerdictTarget & {
      readonly headSha: string;
      readonly workItemId: string;
      readonly resourceKey: string;
      readonly reviewLens: ReviewMode;
    },
  ) => Promise<void>;
  readonly closeCancelledVerdicts: (
    params: ReviewVerdictTarget & { readonly workItemIds: readonly string[] },
  ) => Promise<void>;
  readonly repairOwnVerdictIfOpen: (
    params: ReviewVerdictTarget & {
      readonly headSha: string;
      readonly workItemId: string;
      readonly resourceKey: string;
      readonly reviewLens: string;
    },
  ) => Promise<void>;
};
