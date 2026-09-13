import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { inTransaction } from "../../db/postgres.js";
import {
  DEFERRED_HEAD_SHA,
  REVIEW_CANCELLED_PR_CLOSED,
  reviewCancelAttributionForClosedPr,
} from "../../settings/index.js";
import {
  replaceActiveAutoWorkItem,
  replaceAutoWorkItem,
  type AutoWorkSupersedeTarget,
} from "../autoWorkEnqueue.js";
import type { RequestLogger } from "../../evlog.js";
import { recordEvent } from "../../evlog.js";
import {
  type AckJobData,
  type AckTarget,
  type CiProjectionJobData,
  type JobCorrelation,
  type PrRef,
  type WebhookHeaders,
  prResourceKey,
} from "../types.js";
import { flushDeferredEvents, type DeferredIntakeEvent } from "./deferredEvents.js";
import { planAutomatedPullRequestIntake, type AutomatedPrIntakePlan } from "./planner.js";
import {
  enqueueAck,
  enqueueCiProjectionDebounced,
  enqueueDescription,
  enqueueReview,
  enqueueVerification,
  jobCorrelation,
} from "./queueing.js";
import { captureCiStateChanged } from "../../analytics/workCompleted.js";
import { isHeadCiSeedPullRequest, shouldSeedHeadCiFromPullRequest } from "../ciProjection.js";
import { applyPrHeadCiFact, headCiNeedsSeed, loadPrHeadCiState } from "../prHeadCiState.js";
import type { CiCheckFact } from "../../review/ci/classifySnapshot.js";
import { insertWebhookEvent } from "./webhookEvents.js";
import {
  cancelActiveTriage,
  cancelActiveReviews,
  createDescriptionWorkItem,
  createReviewWorkItem,
  createVerificationWorkItem,
} from "./workItemRepository.js";

type AutomatedKindDispatchDescriptor = {
  readonly target: AutoWorkSupersedeTarget;
  readonly createWorkItem: () => Promise<string>;
  readonly enqueue: (workItemId: string) => Promise<void>;
  readonly eventType: "review" | "description" | "verification";
  readonly enqueueAck?: (workItemId: string) => Promise<void>;
};

async function dispatchAutomatedKind(
  client: PoolClient,
  resourceKey: string,
  correlation: JobCorrelation,
  descriptor: AutomatedKindDispatchDescriptor,
): Promise<DeferredIntakeEvent[]> {
  const { workItemId } = await replaceAutoWorkItem({
    client,
    target: descriptor.target,
    createWorkItem: descriptor.createWorkItem,
  });
  if (descriptor.enqueueAck) {
    await descriptor.enqueueAck(workItemId);
  }
  await descriptor.enqueue(workItemId);
  return [
    {
      name: "agent_work_enqueued",
      fields: {
        type: descriptor.eventType,
        source: "auto",
        workItemId,
        resourceKey,
        ...correlation,
      },
    },
  ];
}

export async function recordIgnoredWebhook(
  client: PoolClient,
  headers: WebhookHeaders,
  decision: string,
  intakeLog: RequestLogger,
): Promise<void> {
  const event = await insertWebhookEvent(client, headers, decision);
  if (event.duplicate) {
    recordEvent(intakeLog, "deduped_delivery", {
      dedupeKey: event.dedupeKey,
      event: headers.event,
    });
  }
}

type PlannedAutomatedIntakeResult = {
  readonly duplicate: boolean;
  readonly correlation: JobCorrelation;
  readonly events: DeferredIntakeEvent[];
};

async function applyPlannedAutomatedPullRequestIntake(
  boss: PgBoss,
  client: PoolClient,
  headers: WebhookHeaders,
  ref: PrRef,
  plan: AutomatedPrIntakePlan,
  pushBeforeSha?: string,
): Promise<PlannedAutomatedIntakeResult> {
  const events: DeferredIntakeEvent[] = [];
  const event = await insertWebhookEvent(client, headers, "automated_review_enqueued");
  if (event.duplicate) {
    events.push({
      name: "deduped_delivery",
      fields: {
        dedupeKey: event.dedupeKey,
        event: headers.event,
      },
    });
    return { duplicate: true, correlation: {}, events };
  }
  const correlation = jobCorrelation(event.id, headers);
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);

  if (plan.kinds.includes("review")) {
    const ackTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    events.push(
      ...(await dispatchAutomatedKind(client, resourceKey, correlation, {
        target: {
          kind: "review",
          resourceKey,
        },
        createWorkItem: () =>
          createReviewWorkItem(client, {
            webhookEventId: event.id,
            ref,
            source: "auto",
            ackTargets,
          }),
        enqueue: (workItemId) => enqueueReview(boss, client, ref, workItemId, correlation),
        eventType: "review",
        enqueueAck: async (workItemId) => {
          const ackData: AckJobData = {
            kind: "ack",
            workItemId,
            installationId: ref.installationId,
            owner: ref.owner,
            repo: ref.repo,
            prNumber: ref.prNumber,
            targets: ackTargets,
            progress: {
              lens: "review",
              headSha: ref.headSha,
              source: "auto",
            },
            ...correlation,
          };
          await enqueueAck(boss, client, ackData);
        },
      })),
    );
  }

  if (plan.kinds.includes("reviewSupersede")) {
    const supersedeAckTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    const { workItemId, supersededIds } = await replaceActiveAutoWorkItem({
      client,
      target: {
        kind: "review",
        resourceKey,
      },
      createWorkItem: () =>
        createReviewWorkItem(client, {
          webhookEventId: event.id,
          // Deferred head: the replacement resolves the newest head at claim
          // time, after the cancelled run releases the PR actor lease.
          ref: { ...ref, headSha: DEFERRED_HEAD_SHA },
          source: "auto",
          ackTargets: supersedeAckTargets,
        }),
    });
    if (workItemId != null) {
      const ackData: AckJobData = {
        kind: "ack",
        workItemId,
        installationId: ref.installationId,
        owner: ref.owner,
        repo: ref.repo,
        prNumber: ref.prNumber,
        targets: supersedeAckTargets,
        progress: {
          lens: "review",
          headSha: DEFERRED_HEAD_SHA,
          source: "auto",
        },
        ...correlation,
      };
      await enqueueAck(boss, client, ackData);
      await enqueueReview(boss, client, ref, workItemId, correlation);
      events.push(
        {
          name: "agent_work_cancel_requested",
          fields: {
            type: "review",
            source: "auto",
            workItemId: supersededIds[0],
            resourceKey,
            cancelledCount: supersededIds.length,
            cancelledIds: supersededIds,
            ...correlation,
          },
        },
        {
          name: "agent_work_enqueued",
          fields: {
            type: "review",
            source: "auto",
            workItemId,
            resourceKey,
            ...correlation,
          },
        },
      );
    }
  }

  if (plan.kinds.includes("description")) {
    const descriptionAckTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    events.push(
      ...(await dispatchAutomatedKind(client, resourceKey, correlation, {
        target: {
          kind: "description",
          resourceKey,
        },
        createWorkItem: () =>
          createDescriptionWorkItem(client, {
            webhookEventId: event.id,
            ref,
            source: "auto",
            ackTargets: descriptionAckTargets,
          }),
        enqueue: (workItemId) => enqueueDescription(boss, client, ref, workItemId, correlation),
        eventType: "description",
      })),
    );
  }

  if (plan.kinds.includes("verification")) {
    const verificationAckTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    events.push(
      ...(await dispatchAutomatedKind(client, resourceKey, correlation, {
        target: {
          kind: "verification",
          resourceKey,
        },
        createWorkItem: () =>
          createVerificationWorkItem(client, {
            webhookEventId: event.id,
            ref,
            pushBeforeSha,
            ackTargets: verificationAckTargets,
          }),
        enqueue: (workItemId) => enqueueVerification(boss, client, ref, workItemId, correlation),
        eventType: "verification",
      })),
    );
  }

  return { duplicate: false, correlation, events };
}

async function applyReviewCloseCancelIntake(
  boss: PgBoss,
  client: PoolClient,
  headers: WebhookHeaders,
  ref: PrRef,
  merged: boolean,
): Promise<DeferredIntakeEvent[]> {
  const events: DeferredIntakeEvent[] = [];
  const event = await insertWebhookEvent(client, headers, REVIEW_CANCELLED_PR_CLOSED);
  if (event.duplicate) {
    events.push({
      name: "deduped_delivery",
      fields: {
        dedupeKey: event.dedupeKey,
        event: headers.event,
      },
    });
    return events;
  }
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  const attribution = reviewCancelAttributionForClosedPr(merged);
  const cancelledReviews = await cancelActiveReviews(client, resourceKey, attribution);
  const cancelledTriage = await cancelActiveTriage(client, resourceKey, attribution, ref.prNumber);
  const cancelledReviewWorkItemIds = cancelledReviews.map((row) => row.id);
  const cancelledTriageWorkItemIds = cancelledTriage.map((row) => row.id);
  const cancelledWorkItemIds = [...cancelledReviewWorkItemIds, ...cancelledTriageWorkItemIds];
  const primaryReview = cancelledReviews[0];
  const primaryTriage = cancelledTriage[0];
  if (primaryReview != null || primaryTriage != null) {
    const correlation = jobCorrelation(event.id, headers);
    const ackData: AckJobData = {
      kind: "ack",
      installationId: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      targets: [],
      ...(primaryReview != null
        ? {
            cancelProgress: {
              workItemId: primaryReview.id,
              cancelledWorkItemIds: cancelledReviewWorkItemIds,
              attribution,
            },
          }
        : {}),
      ...(primaryTriage != null
        ? {
            cancelTriage: {
              workItemId: primaryTriage.id,
              cancelledWorkItemIds: cancelledTriageWorkItemIds,
              attribution,
              targets: primaryTriage.ackTargets,
              replyTarget: primaryTriage.replyTarget,
            },
          }
        : {}),
      ...correlation,
    };
    await enqueueAck(boss, client, ackData);
  }
  events.push({
    name: REVIEW_CANCELLED_PR_CLOSED,
    fields: {
      resourceKey,
      cancelledCount: cancelledWorkItemIds.length,
      cancelledIds: cancelledWorkItemIds,
      cancelledReviewCount: cancelledReviewWorkItemIds.length,
      cancelledTriageCount: cancelledTriageWorkItemIds.length,
      cancelledTriageIds: cancelledTriageWorkItemIds,
      prMerged: attribution.kind === "merged",
      ...jobCorrelation(event.id, headers),
    },
  });
  return events;
}

export type AutomatedPullRequestIntakeOpts = {
  readonly pushBeforeSha?: string;
  readonly merged?: boolean;
};

async function enqueueHeadCiProjection(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  correlation: JobCorrelation,
): Promise<DeferredIntakeEvent> {
  const job: CiProjectionJobData = {
    kind: "ci_projection",
    installationId: ref.installationId,
    owner: ref.owner,
    repo: ref.repo,
    headSha: ref.headSha,
    ...correlation,
  };
  const result = await enqueueCiProjectionDebounced(boss, client, job);
  return {
    name: "ci_projection_enqueued",
    fields: {
      owner: ref.owner,
      repo: ref.repo,
      headSha: ref.headSha,
      result,
    },
  };
}

async function applyPullRequestCiSeedIntake(
  boss: PgBoss,
  client: PoolClient,
  headers: WebhookHeaders,
  ref: PrRef,
  intakeLog: RequestLogger,
  action: string,
): Promise<DeferredIntakeEvent[]> {
  if (!isHeadCiSeedPullRequest(action, ref.headSha)) {
    await recordIgnoredWebhook(client, headers, `ignored_pull_request_${action}`, intakeLog);
    return [];
  }
  const row = await loadPrHeadCiState(client, ref.owner, ref.repo, ref.headSha);
  if (!headCiNeedsSeed(row)) {
    await recordIgnoredWebhook(client, headers, `ignored_pull_request_${action}`, intakeLog);
    return [];
  }
  const event = await insertWebhookEvent(client, headers, "ci_projection_enqueued");
  if (event.duplicate) {
    return [
      {
        name: "deduped_delivery",
        fields: {
          dedupeKey: event.dedupeKey,
          event: headers.event,
        },
      },
    ];
  }
  return [await enqueueHeadCiProjection(boss, client, ref, jobCorrelation(event.id, headers))];
}

export async function applyAutomatedPullRequestIntake(
  boss: PgBoss,
  pool: Pool,
  headers: WebhookHeaders,
  ref: PrRef,
  action: string,
  intakeLog: RequestLogger,
  cfg: Pick<Config, "features">,
  opts?: AutomatedPullRequestIntakeOpts,
): Promise<void> {
  if (action === "closed") {
    const events = await inTransaction(pool, (client) =>
      applyReviewCloseCancelIntake(boss, client, headers, ref, opts?.merged === true),
    );
    flushDeferredEvents(intakeLog, events);
    return;
  }

  const plan = planAutomatedPullRequestIntake(action, cfg.features);

  if (plan.kinds.length === 0) {
    const events = await inTransaction(pool, (client) =>
      applyPullRequestCiSeedIntake(boss, client, headers, ref, intakeLog, action),
    );
    flushDeferredEvents(intakeLog, events);
    return;
  }

  const events = await inTransaction(pool, async (client) => {
    const planned = await applyPlannedAutomatedPullRequestIntake(
      boss,
      client,
      headers,
      ref,
      plan,
      opts?.pushBeforeSha,
    );
    if (planned.duplicate) return planned.events;
    const row = await loadPrHeadCiState(client, ref.owner, ref.repo, ref.headSha);
    if (!shouldSeedHeadCiFromPullRequest(action, ref.headSha, row)) return planned.events;
    planned.events.push(await enqueueHeadCiProjection(boss, client, ref, planned.correlation));
    return planned.events;
  });
  flushDeferredEvents(intakeLog, events);
}

/**
 * Enqueues one head-scoped projection for a completed workflow_run / check_suite.
 * Does not write facts. Empty pull_requests still enqueue (ADR 0035).
 */
export async function applyCompletedRunCiIntake(
  boss: PgBoss,
  pool: Pool,
  headers: WebhookHeaders,
  data: {
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly headSha: string;
    readonly prNumbers: readonly number[];
  },
  intakeLog: RequestLogger,
): Promise<void> {
  const events = await inTransaction(pool, async (client) => {
    const deferred: DeferredIntakeEvent[] = [];
    const event = await insertWebhookEvent(client, headers, "ci_projection_enqueued");
    if (event.duplicate) {
      deferred.push({
        name: "deduped_delivery",
        fields: {
          dedupeKey: event.dedupeKey,
          event: headers.event,
        },
      });
      return deferred;
    }
    const job: CiProjectionJobData = {
      kind: "ci_projection",
      installationId: data.installationId,
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      ...jobCorrelation(event.id, headers),
    };
    const result = await enqueueCiProjectionDebounced(boss, client, job);
    deferred.push({
      name: "ci_projection_enqueued",
      fields: {
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        prCount: data.prNumbers.length,
        result,
      },
    });
    return deferred;
  });
  flushDeferredEvents(intakeLog, events);
}

export type CiStateFactInput = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly fact: CiCheckFact;
};

/**
 * Writes `pr_head_ci_state` for a check_run or status delivery and enqueues a
 * debounced projection. Does not resolve PRs and does not call GitHub.
 */
export async function applyCiStateIntake(
  boss: PgBoss,
  pool: Pool,
  headers: WebhookHeaders,
  data: CiStateFactInput,
  intakeLog: RequestLogger,
): Promise<void> {
  const rollupTransition: {
    current: {
      readonly previousRollup: string;
      readonly rollup: string;
      readonly version: number;
    } | null;
  } = { current: null };
  const events = await inTransaction(pool, async (client) => {
    const deferred: DeferredIntakeEvent[] = [];
    const event = await insertWebhookEvent(client, headers, "ci_state_applied");
    if (event.duplicate) {
      deferred.push({
        name: "deduped_delivery",
        fields: {
          dedupeKey: event.dedupeKey,
          event: headers.event,
        },
      });
      return deferred;
    }
    const applied = await applyPrHeadCiFact(client, {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      fact: data.fact,
    });
    deferred.push({
      name: "ci_state_applied",
      fields: {
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        name: data.fact.name,
        accepted: applied.accepted,
        version: applied.version,
      },
    });
    if (!applied.accepted) return deferred;
    if (applied.previousRollup !== applied.rollup) {
      rollupTransition.current = {
        previousRollup: applied.previousRollup,
        rollup: applied.rollup,
        version: applied.version,
      };
    }
    const job: CiProjectionJobData = {
      kind: "ci_projection",
      installationId: data.installationId,
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      ...jobCorrelation(event.id, headers),
    };
    const result = await enqueueCiProjectionDebounced(boss, client, job);
    deferred.push({
      name: "ci_projection_enqueued",
      fields: {
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        result,
      },
    });
    return deferred;
  });
  if (rollupTransition.current != null) {
    captureCiStateChanged({
      installationId: data.installationId,
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      fromRollup: rollupTransition.current.previousRollup,
      toRollup: rollupTransition.current.rollup,
      version: rollupTransition.current.version,
    });
  }
  flushDeferredEvents(intakeLog, events);
}
