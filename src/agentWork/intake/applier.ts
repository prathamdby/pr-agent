import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { inTransaction } from "../../db/postgres.js";
import type { ReviewAuthorTrust } from "../../commands/slashAssociation.js";
import {
  approveAwaiting,
  findAwaitingForHead,
  insertAwaitingApproval,
  moveAwaitingHead,
  withdrawAwaiting,
} from "./reviewApprovals.js";
import {
  DEFERRED_HEAD_SHA,
  IGNORED_REVIEW_APPROVAL_NOT_AWAITING,
  REVIEW_APPROVED,
  REVIEW_CANCELLED_PR_CLOSED,
  reviewCancelAttributionForClosedPr,
} from "../../settings/index.js";
import {
  acquireAutoWorkIntakeLock,
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
import {
  automatedIntakeDecision,
  planAutomatedPullRequestIntake,
  type AutomatedPrIntakePlan,
} from "./planner.js";
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
  loadReviewLifecycle,
  recordReviewLifecycleObservation,
  type ReviewLifecycleObservation,
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
  readonly reviewRefused?: "closed" | "merged";
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
  const event = await insertWebhookEvent(client, headers, automatedIntakeDecision(plan));
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
  let reviewRefused: "closed" | "merged" | undefined;
  if (
    plan.kinds.some(
      (kind) =>
        kind === "review" ||
        kind === "reviewAwaitApproval" ||
        kind === "reviewTrackAwaitingHead" ||
        kind === "reviewSupersede",
    )
  ) {
    await acquireAutoWorkIntakeLock(client, { kind: "review", resourceKey });
    const lifecycle = await loadReviewLifecycle(client, resourceKey);
    if (lifecycle != null && lifecycle.state !== "open") {
      reviewRefused = lifecycle.state;
      plan = {
        ...plan,
        kinds: plan.kinds.filter(
          (kind) =>
            kind !== "review" &&
            kind !== "reviewAwaitApproval" &&
            kind !== "reviewTrackAwaitingHead" &&
            kind !== "reviewSupersede",
        ),
      };
      const decision =
        plan.kinds.length === 0
          ? `ignored_review_pr_${reviewRefused}`
          : automatedIntakeDecision(plan);
      await client.query("UPDATE webhook_events SET processing_decision = $2 WHERE id = $1", [
        event.id,
        decision,
      ]);
      events.push({
        name: "review_intake_refused",
        fields: { resourceKey, reason: reviewRefused, source: "auto", ...correlation },
      });
    }
  }

  if (
    plan.kinds.includes("reviewAwaitApproval") &&
    (await insertAwaitingApproval(client, ref, event.id))
  ) {
    await enqueueAck(boss, client, {
      kind: "ack",
      installationId: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      targets: [],
      awaitingApproval: true,
      ...correlation,
    });
    events.push({ name: "review_awaiting_approval", fields: { resourceKey, ...correlation } });
  }
  if (plan.kinds.includes("reviewTrackAwaitingHead")) {
    await moveAwaitingHead(client, resourceKey, ref.headSha);
  }

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
    const ackTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    const { workItemId, supersededIds } = await replaceActiveAutoWorkItem({
      client,
      target: { kind: "review", resourceKey },
      createWorkItem: () =>
        createReviewWorkItem(client, {
          webhookEventId: event.id,
          ref: { ...ref, headSha: DEFERRED_HEAD_SHA },
          source: "auto",
          ackTargets,
        }),
    });
    if (workItemId != null) {
      await enqueueAck(boss, client, {
        kind: "ack",
        workItemId,
        installationId: ref.installationId,
        owner: ref.owner,
        repo: ref.repo,
        prNumber: ref.prNumber,
        targets: ackTargets,
        progress: { lens: "review", headSha: DEFERRED_HEAD_SHA, source: "auto" },
        ...correlation,
      });
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
          fields: { type: "review", source: "auto", workItemId, resourceKey, ...correlation },
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

  return { duplicate: false, reviewRefused, correlation, events };
}

async function applyReviewCloseCancelIntake(
  boss: PgBoss,
  client: PoolClient,
  headers: WebhookHeaders,
  ref: PrRef,
  observation: ReviewLifecycleObservation,
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
  await acquireAutoWorkIntakeLock(client, { kind: "review", resourceKey });
  const applied = await recordReviewLifecycleObservation(
    client,
    resourceKey,
    observation,
    event.id,
  );
  const correlation = jobCorrelation(event.id, headers);
  if (!applied) {
    await client.query("UPDATE webhook_events SET processing_decision = $2 WHERE id = $1", [
      event.id,
      "ignored_stale_pr_lifecycle",
    ]);
    return [
      {
        name: "ignored_stale_pr_lifecycle",
        fields: { resourceKey, state: observation.state, ...correlation },
      },
    ];
  }
  const attribution = reviewCancelAttributionForClosedPr(observation.state === "merged");
  if (await withdrawAwaiting(client, resourceKey)) {
    await enqueueAck(boss, client, {
      kind: "ack",
      installationId: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      targets: [],
      closedApproval: attribution,
      ...correlation,
    });
  }
  const cancelledReviews = await cancelActiveReviews(client, resourceKey, attribution);
  const cancelledTriage = await cancelActiveTriage(client, resourceKey, attribution, ref.prNumber);
  const cancelledReviewWorkItemIds = cancelledReviews.map((row) => row.id);
  const cancelledTriageWorkItemIds = cancelledTriage.map((row) => row.id);
  const cancelledWorkItemIds = [...cancelledReviewWorkItemIds, ...cancelledTriageWorkItemIds];
  const primaryReview = cancelledReviews[0];
  const primaryTriage = cancelledTriage[0];
  if (primaryReview != null || primaryTriage != null) {
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
  readonly authorTrust?: ReviewAuthorTrust;
  readonly pushBeforeSha?: string;
  readonly merged?: boolean;
  readonly lifecycle?: ReviewLifecycleObservation;
};

export type AutomatedPullRequestIntakeArgs<Action extends string> = Action extends
  | "closed"
  | "reopened"
  ? [opts: AutomatedPullRequestIntakeOpts & { readonly lifecycle: ReviewLifecycleObservation }]
  : [opts?: AutomatedPullRequestIntakeOpts];

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
  observation?: ReviewLifecycleObservation,
): Promise<DeferredIntakeEvent[]> {
  const seedCandidate = isHeadCiSeedPullRequest(action, ref.headSha);
  if (!seedCandidate && action !== "reopened") {
    await recordIgnoredWebhook(client, headers, `ignored_pull_request_${action}`, intakeLog);
    return [];
  }
  const row = seedCandidate
    ? await loadPrHeadCiState(client, ref.owner, ref.repo, ref.headSha)
    : null;
  const seed = seedCandidate && headCiNeedsSeed(row);
  const event = await insertWebhookEvent(
    client,
    headers,
    seed ? "ci_projection_enqueued" : `ignored_pull_request_${action}`,
  );
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
  const correlation = jobCorrelation(event.id, headers);
  const events: DeferredIntakeEvent[] = [];
  if (action === "reopened" && observation != null) {
    const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    await acquireAutoWorkIntakeLock(client, { kind: "review", resourceKey });
    const applied = await recordReviewLifecycleObservation(
      client,
      resourceKey,
      observation,
      event.id,
    );
    const lifecycleDecision = applied
      ? "pr_review_lifecycle_applied"
      : "ignored_stale_pr_lifecycle";
    if (!seed) {
      await client.query("UPDATE webhook_events SET processing_decision = $2 WHERE id = $1", [
        event.id,
        lifecycleDecision,
      ]);
    }
    events.push({
      name: lifecycleDecision,
      fields: { resourceKey, state: observation.state, ...correlation },
    });
  }
  if (seed) events.push(await enqueueHeadCiProjection(boss, client, ref, correlation));
  return events;
}

export async function applyAutomatedPullRequestIntake<Action extends string>(
  boss: PgBoss,
  pool: Pool,
  headers: WebhookHeaders,
  ref: PrRef,
  action: Action,
  intakeLog: RequestLogger,
  cfg: Pick<Config, "features">,
  ...options: AutomatedPullRequestIntakeArgs<Action>
): Promise<void> {
  const opts = options[0];
  if (action === "closed" || action === "reopened") {
    const observation = opts?.lifecycle;
    if (observation == null) {
      throw new Error("Close and reopen require a validated lifecycle observation");
    }
    if (action === "closed") {
      const events = await inTransaction(pool, (client) =>
        applyReviewCloseCancelIntake(boss, client, headers, ref, observation),
      );
      flushDeferredEvents(intakeLog, events);
      return;
    }
  }

  const plan = planAutomatedPullRequestIntake(action, cfg.features, opts?.authorTrust);

  if (plan.kinds.length === 0) {
    const events = await inTransaction(pool, (client) =>
      applyPullRequestCiSeedIntake(boss, client, headers, ref, intakeLog, action, opts?.lifecycle),
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

export type ReviewApprovalSignal =
  | { readonly kind: "pull_request_review"; readonly ref: PrRef }
  | {
      readonly kind: "workflow_run";
      readonly installationId: number;
      readonly owner: string;
      readonly repo: string;
      readonly headSha: string;
      readonly prNumbers: readonly number[];
    };

export async function applyReviewApprovedIntake(
  boss: PgBoss,
  pool: Pool,
  headers: WebhookHeaders,
  signal: ReviewApprovalSignal,
  intakeLog: RequestLogger,
): Promise<void> {
  const events = await inTransaction(pool, async (client) => {
    const event = await insertWebhookEvent(client, headers, IGNORED_REVIEW_APPROVAL_NOT_AWAITING);
    if (event.duplicate)
      return [
        { name: "deduped_delivery", fields: { dedupeKey: event.dedupeKey, event: headers.event } },
      ];
    const correlation = jobCorrelation(event.id, headers);
    const targets =
      signal.kind === "pull_request_review"
        ? [signal.ref]
        : [
            ...(await findAwaitingForHead(client, signal.owner, signal.repo, signal.headSha)).map(
              (row) => ({
                owner: row.owner,
                repo: row.repo,
                prNumber: row.pr_number,
                headSha: row.head_sha,
                installationId: signal.installationId,
              }),
            ),
            ...signal.prNumbers.map((prNumber) => ({ ...signal, prNumber })),
          ];
    const refs = new Map(
      targets.map((ref) => [prResourceKey(ref.owner, ref.repo, ref.prNumber), ref]),
    );
    const deferred: DeferredIntakeEvent[] = [];
    for (const resourceKey of [...refs.keys()].toSorted()) {
      const ref = refs.get(resourceKey)!;
      await acquireAutoWorkIntakeLock(client, { kind: "review", resourceKey });
      const lifecycle = await loadReviewLifecycle(client, resourceKey);
      if (lifecycle != null && lifecycle.state !== "open") continue;
      const approved = await approveAwaiting(
        client,
        resourceKey,
        signal.kind,
        signal.kind === "workflow_run" ? signal.headSha : undefined,
      );
      if (approved == null) continue;
      const deferredRef = { ...ref, headSha: DEFERRED_HEAD_SHA };
      const ackTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
      deferred.push(
        ...(await dispatchAutomatedKind(client, resourceKey, correlation, {
          target: { kind: "review", resourceKey },
          createWorkItem: () =>
            createReviewWorkItem(client, {
              webhookEventId: event.id,
              ref: deferredRef,
              source: "auto",
              ackTargets,
            }),
          enqueue: (workItemId) =>
            enqueueReview(boss, client, deferredRef, workItemId, correlation),
          eventType: "review",
          enqueueAck: (workItemId) =>
            enqueueAck(boss, client, {
              kind: "ack",
              workItemId,
              installationId: ref.installationId,
              owner: ref.owner,
              repo: ref.repo,
              prNumber: ref.prNumber,
              targets: ackTargets,
              progress: { lens: "review", headSha: DEFERRED_HEAD_SHA, source: "auto" },
              ...correlation,
            }),
        })),
      );
    }
    const decision = deferred.length > 0 ? REVIEW_APPROVED : IGNORED_REVIEW_APPROVAL_NOT_AWAITING;
    await client.query("UPDATE webhook_events SET processing_decision = $2 WHERE id = $1", [
      event.id,
      decision,
    ]);
    deferred.push({ name: decision, fields: { signal: signal.kind, ...correlation } });
    return deferred;
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
