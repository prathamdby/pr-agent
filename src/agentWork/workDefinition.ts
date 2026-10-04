import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { type Config } from "../settings/index.js";
import type { createFeaturePiSession } from "../agent/runtime/createFeatureSession.js";
import type { PrSurface } from "../github/prSurface.js";
import { logWarn } from "../evlog.js";
import { WORK_QUEUES, type WorkType, type ReviewWorkItem } from "./types.js";
import { leaseBinding } from "./writeFence.js";
import {
  runDurableWorkItem,
  createDurableRuntime,
  resolveWorkItemHead,
  type DurableJobSpec,
  type DurableRuntime,
} from "./durableJob.js";
import { productionInstallationSurface, type InstallationSurface } from "./installationSurface.js";
import { createAskWorkExecution } from "./executors/askExecutor.js";
import { createDescriptionWorkExecution } from "./executors/descriptionExecutor.js";
import { createReviewWorkExecution } from "./executors/reviewExecutor.js";
import { createTriageWorkExecution } from "./executors/triageExecutor.js";
import { createVerificationWorkExecution } from "./executors/verificationExecutor.js";
import { errorMessage } from "../errors/errorMessage.js";

export type WorkExecution<T extends WorkType> = Pick<
  DurableJobSpec<T>,
  "execute" | "onTerminalFailure" | "onCancelled"
>;

export type WorkExecutionDependencies = {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly installationSurface?: InstallationSurface;
  /** Pi session factory for features that run agent sessions in-process; review injects it. */
  readonly createSession?: typeof createFeaturePiSession;
};

export type DurableWorkDefinition<T extends WorkType> = WorkExecution<T> &
  Pick<DurableJobSpec<T>, "type" | "acceptItem" | "resolveHeadSha" | "prActorLease"> & {
    readonly queue: string;
    readonly concurrency: number;
    readonly contextPolicy: NonNullable<DurableJobSpec<T>["contextPolicy"]>;
    readonly dispatch: (
      job: JobWithMetadata<{ workItemId: string; kind?: WorkType }>,
    ) => Promise<void>;
  };

async function resolveReviewHead(prSurface: PrSurface, item: ReviewWorkItem) {
  const resolved = await resolveWorkItemHead(prSurface, item);
  if (resolved.pullRequest != null) return resolved;
  try {
    const current = await prSurface.getHead();
    return { headSha: resolved.headSha, pullRequest: current.pullRequest };
  } catch (error) {
    logWarn("review_pr_identity_fetch_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      message: errorMessage(error),
    });
    return resolved;
  }
}

/** Closed registration table. Auxiliary lanes never acquire a durable work kind. */
export function createWorkDefinitions(
  dependencies: WorkExecutionDependencies & { readonly runtime?: DurableRuntime },
) {
  const installationSurface =
    dependencies.installationSurface ??
    dependencies.runtime?.installationSurface ??
    productionInstallationSurface;
  const executionDependencies = { ...dependencies, installationSurface };
  function define<T extends WorkType>(
    policy: Omit<
      DurableWorkDefinition<T>,
      keyof WorkExecution<T> | "dispatch" | "queue" | "prActorLease"
    >,
    execution: WorkExecution<T>,
  ): DurableWorkDefinition<T> {
    const queue = WORK_QUEUES[policy.type];
    const definition = {
      ...policy,
      ...execution,
      queue,
      ...leaseBinding(policy.type, queue),
    };
    return {
      ...definition,
      dispatch: (job) =>
        runDurableWorkItem({
          ...definition,
          cfg: dependencies.cfg,
          pool: dependencies.pool,
          boss: dependencies.boss,
          job,
          runtime: createDurableRuntime({ ...dependencies.runtime, installationSurface }),
        }),
    };
  }
  return {
    review: define(
      {
        type: "review",
        concurrency: dependencies.cfg.concurrency.review,
        contextPolicy: { commenterId: (item) => item.payload.commenterId },
        acceptItem: (item) => item.reviewLens != null,
        resolveHeadSha: resolveReviewHead,
      },
      createReviewWorkExecution(executionDependencies),
    ),
    ask: define(
      {
        type: "ask",
        concurrency: dependencies.cfg.concurrency.ask,
        contextPolicy: { commenterId: (item) => item.payload.commenterId },
        resolveHeadSha: resolveWorkItemHead,
      },
      createAskWorkExecution(executionDependencies),
    ),
    description: define(
      {
        type: "description",
        concurrency: dependencies.cfg.concurrency.description,
        contextPolicy: { commenterId: (item) => item.payload.commenterId },
        resolveHeadSha: resolveWorkItemHead,
      },
      createDescriptionWorkExecution(executionDependencies),
    ),
    triage: define(
      {
        type: "triage",
        concurrency: dependencies.cfg.concurrency.triage,
        contextPolicy: { commenterId: (item) => item.payload.commenterId },
        resolveHeadSha: resolveWorkItemHead,
      },
      createTriageWorkExecution(executionDependencies),
    ),
    verification: define(
      {
        type: "verification",
        concurrency: dependencies.cfg.concurrency.verification,
        contextPolicy: { commenterId: () => undefined },
        resolveHeadSha: resolveWorkItemHead,
      },
      createVerificationWorkExecution(executionDependencies),
    ),
  } satisfies { [T in WorkType]: DurableWorkDefinition<T> };
}
