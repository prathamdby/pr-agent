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
  type JobCorrelation,
  type PrRef,
  type WebhookHeaders,
  prResourceKey,
} from "../types.js";
import { flushDeferredEvents, type DeferredIntakeEvent } from "./deferredEvents.js";
import { planAutomatedPullRequestIntake, type AutomatedPrIntakePlan } from "./planner.js";
import {
  enqueueAck,
  enqueueCiRefreshIdempotent,
  enqueueDescription,
  enqueueReview,
  enqueueVerification,
  jobCorrelation,
} from "./queueing.js";
import type { CiRefreshJobData } from "../types.js";
import { applySlashCommandIntake, type SlashCommandInput } from "./slashIntake.js";
import { insertWebhookEvent } from "./webhookEvents.js";
import {
  cancelActiveTriage,
  cancelActiveReviews,
  createDescriptionWorkItem,
  createReviewWorkItem,
  createVerificationWorkItem,
} from "./workItemRepository.js";

export type { SlashCommandInput };
export { applySlashCommandIntake };

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

async function applyPlannedAutomatedPullRequestIntake(
  boss: PgBoss,
  client: PoolClient,
  headers: WebhookHeaders,
  ref: PrRef,
  plan: AutomatedPrIntakePlan,
  pushBeforeSha?: string,
): Promise<DeferredIntakeEvent[]> {
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
    return events;
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

  return events;
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
    await inTransaction(pool, (client) =>
      recordIgnoredWebhook(client, headers, `ignored_pull_request_${action}`, intakeLog),
    );
    return;
  }

  const events = await inTransaction(pool, (client) =>
    applyPlannedAutomatedPullRequestIntake(boss, client, headers, ref, plan, opts?.pushBeforeSha),
  );
  flushDeferredEvents(intakeLog, events);
}

/**
 * Enqueues CI-refresh jobs for a completed workflow_run / check_suite on matching PR heads.
 * No agent_work_item row — fire-and-forget like ack (ADR 0018).
 */
export async function applyCiRefreshIntake(
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
  if (data.prNumbers.length === 0) {
    await inTransaction(pool, (client) =>
      recordIgnoredWebhook(client, headers, "ignored_workflow_run_no_pr", intakeLog),
    );
    return;
  }
  const events = await inTransaction(pool, async (client) => {
    const deferred: DeferredIntakeEvent[] = [];
    const event = await insertWebhookEvent(client, headers, "ci_refresh_enqueued");
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
    const correlation = jobCorrelation(event.id, headers);
    for (const prNumber of data.prNumbers) {
      const job: CiRefreshJobData = {
        kind: "ci_refresh",
        installationId: data.installationId,
        owner: data.owner,
        repo: data.repo,
        prNumber,
        headSha: data.headSha,
        attempt: 0,
        ...correlation,
      };
      const result = await enqueueCiRefreshIdempotent(boss, client, job, event.id);
      deferred.push({
        name: "ci_refresh_enqueued",
        fields: {
          owner: data.owner,
          repo: data.repo,
          pr: prNumber,
          headSha: data.headSha,
          result,
        },
      });
    }
    return deferred;
  });
  flushDeferredEvents(intakeLog, events);
}
