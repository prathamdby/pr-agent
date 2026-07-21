import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Pool } from "pg";
import type { Config } from "../../config.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import type { WorkSource, ReviewMode } from "../reviewSchema.js";

/** Optional progress-tick wiring for the orchestrated review stub (decision 10 / 26). */
export type ReviewProgressTickContext = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
};

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
  readonly hasDescriptionAgentBlock?: boolean;
  readonly initialPublishState?: {
    readonly published?: boolean;
    readonly inlineReviewIds?: readonly number[];
    readonly postedInlineCount?: number;
    /** Prior incremental thread publish calls this work item (resume vs MAX_THREAD_PUBLISH_CALLS). */
    readonly batchCount?: number;
  };
  readonly recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { readonly githubId?: string | number; readonly meta?: Record<string, unknown> },
  ) => Promise<void>;
  /**
   * Full pre-publish gate: DB skip + refreshed GitHub head-SHA stale check.
   * Call only at explicit gates before/after turns and before writes — never on the
   * in-flight 250ms poll (that would hammer GitHub during long LLM turns).
   */
  readonly shouldAbortPublish?: () => Promise<boolean>;
  /**
   * Cheap run-cancellation probe (DB skip / work superseded only — no GitHub).
   * Used for in-flight orchestrator-send polling and the pending-specialists monitor.
   */
  readonly shouldCancelRun?: () => Promise<boolean>;
  readonly storedInlineFingerprints?: readonly string[];
  readonly refreshInstallationToken?: () => Promise<{
    readonly token: string;
    readonly expiresAtTs: number;
  }>;
  readonly reviewSource?: WorkSource;
  readonly staleHeadRescheduled?: boolean;
  readonly publishAbortState?: { readonly staleHead?: boolean };
  readonly severityFloor?: number;
  /** PR title for recon / deterministic brief fallback. */
  readonly prTitle?: string;
  /** PR body for recon / deterministic brief fallback. */
  readonly prBody?: string;
  /** When set, specialist ticks upsert the review progress comment. */
  readonly progressTick?: ReviewProgressTickContext;
  /** Injectable clock for deadline tests. */
  readonly now?: () => number;
  /** Injectable sleep for specialist stagger tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Override hard run deadline (ms epoch); default `now + queueExpireInSeconds * 0.8`. */
  readonly deadlineAtMs?: number;
  /** Override specialist dispatch stagger (ms); default `SPECIALIST_DISPATCH_STAGGER_MS`. */
  readonly specialistDispatchStaggerMs?: number;
};

export type ReviewRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly published: boolean;
  readonly publishAttempts: number;
  readonly publishSuperseded: boolean;
};
