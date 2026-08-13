import type { IntakeClient, IntakePool } from "../../db/postgres.js";
import type { Config } from "../../config.js";
import { inTransaction, pgBossDb } from "../../db/postgres.js";
import {
  DESCRIPTION_QUEUE,
  REVIEW_CANCELLED_PR_MERGED,
  REVIEW_QUEUE,
  VERIFICATION_QUEUE,
} from "../../settings/index.js";
import { replaceAutoWorkItem, type AutoWorkSupersedeTarget } from "../autoWorkEnqueue.js";
import { releaseReviewQueueSlotInTx } from "../reviewQueueSlot.js";
import { releaseSingletonSlot, type SingletonSlotDb } from "../singletonQueue.js";
import type { RequestLogger } from "../../evlog.js";
import { recordEvent } from "../../evlog.js";
import {
  type AckJobData,
  type AckTarget,
  type JobCorrelation,
  type PrRef,
  type WebhookHeaders,
  prResourceKey,
  reviewSingletonKey,
  descriptionSingletonKey,
  verificationSingletonKey,
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
  type JobQueue,
} from "./queueing.js";
import type { CiRefreshJobData } from "../types.js";
import { applySlashCommandIntake, type SlashCommandInput } from "./slashIntake.js";
import { insertWebhookEvent } from "./webhookEvents.js";
import {
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
  readonly queueName: string;
  readonly singletonKey: string;
  readonly eventType: "review" | "description" | "verification";
  readonly enqueueAck?: (workItemId: string) => Promise<void>;
};

async function dispatchAutomatedKind(
  boss: JobQueue,
  client: IntakeClient,
  slotDb: SingletonSlotDb,
  resourceKey: string,
  correlation: JobCorrelation,
  descriptor: AutomatedKindDispatchDescriptor,
): Promise<DeferredIntakeEvent[]> {
  const { workItemId, supersededIds } = await replaceAutoWorkItem({
    client,
    target: descriptor.target,
    createWorkItem: descriptor.createWorkItem,
  });
  if (descriptor.eventType === "review") {
    await releaseReviewQueueSlotInTx(boss, client, resourceKey, {
      cancelWorkItemIds: supersededIds,
    });
  } else {
    await releaseSingletonSlot(boss, {
      queue: descriptor.queueName,
      singletonKey: descriptor.singletonKey,
      db: slotDb,
      cancelNonTerminal: supersededIds.length > 0,
      cancelWorkItemIds: supersededIds,
    });
  }
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
  client: IntakeClient,
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
  boss: JobQueue,
  client: IntakeClient,
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
  const slotDb = pgBossDb(client);

  if (plan.kinds.includes("review")) {
    const ackTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    events.push(
      ...(await dispatchAutomatedKind(boss, client, slotDb, resourceKey, correlation, {
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
        queueName: REVIEW_QUEUE,
        singletonKey: reviewSingletonKey(resourceKey),
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

  if (plan.kinds.includes("description")) {
    const descriptionAckTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    events.push(
      ...(await dispatchAutomatedKind(boss, client, slotDb, resourceKey, correlation, {
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
        queueName: DESCRIPTION_QUEUE,
        singletonKey: descriptionSingletonKey(resourceKey),
        eventType: "description",
      })),
    );
  }

  if (plan.kinds.includes("verification")) {
    const verificationAckTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    events.push(
      ...(await dispatchAutomatedKind(boss, client, slotDb, resourceKey, correlation, {
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
        queueName: VERIFICATION_QUEUE,
        singletonKey: verificationSingletonKey(resourceKey),
        eventType: "verification",
      })),
    );
  }

  return events;
}

async function applyReviewMergeCancelIntake(
  boss: JobQueue,
  client: IntakeClient,
  headers: WebhookHeaders,
  ref: PrRef,
): Promise<DeferredIntakeEvent[]> {
  const events: DeferredIntakeEvent[] = [];
  const event = await insertWebhookEvent(client, headers, REVIEW_CANCELLED_PR_MERGED);
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
  const attribution = { kind: "merged" as const };
  const cancelled = await cancelActiveReviews(client, resourceKey, attribution);
  const cancelledWorkItemIds = cancelled.map((row) => row.id);
  await releaseReviewQueueSlotInTx(boss, client, resourceKey, {
    cancelWorkItemIds: cancelledWorkItemIds,
  });
  const primary = cancelled[0];
  if (primary != null) {
    const correlation = jobCorrelation(event.id, headers);
    const ackData: AckJobData = {
      kind: "ack",
      installationId: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      targets: [],
      cancelProgress: {
        workItemId: primary.id,
        cancelledWorkItemIds,
        attribution,
      },
      ...correlation,
    };
    await enqueueAck(boss, client, ackData);
  }
  events.push({
    name: REVIEW_CANCELLED_PR_MERGED,
    fields: {
      resourceKey,
      cancelledCount: cancelledWorkItemIds.length,
      cancelledIds: cancelledWorkItemIds,
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
  boss: JobQueue,
  pool: IntakePool,
  headers: WebhookHeaders,
  ref: PrRef,
  action: string,
  intakeLog: RequestLogger,
  cfg: Pick<Config, "features">,
  opts?: AutomatedPullRequestIntakeOpts,
): Promise<void> {
  if (action === "closed" && opts?.merged === true) {
    const events = await inTransaction(pool, (client) =>
      applyReviewMergeCancelIntake(boss, client, headers, ref),
    );
    flushDeferredEvents(intakeLog, events);
    return;
  }

  const plan = planAutomatedPullRequestIntake(action, cfg.features);
  if (plan.kinds.length === 0) {
    // Ignored actions have no transactional intake work; dedupe insert uses the pool directly.
    // closed-without-merge falls through here as ignored_pull_request_closed.
    await recordIgnoredWebhook(pool, headers, `ignored_pull_request_${action}`, intakeLog);
    return;
  }

  const events = await inTransaction(pool, (client) =>
    applyPlannedAutomatedPullRequestIntake(boss, client, headers, ref, plan, opts?.pushBeforeSha),
  );
  flushDeferredEvents(intakeLog, events);
}

/**
 * Enqueues CI-refresh jobs for a completed workflow_run / check_suite on matching PR heads.
 * No agent_work_item row — fire-and-forget like ack (ADR 0026).
 */
export async function applyCiRefreshIntake(
  boss: JobQueue,
  pool: IntakePool,
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
    await recordIgnoredWebhook(pool, headers, "ignored_workflow_run_no_pr", intakeLog);
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
