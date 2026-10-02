import crypto from "node:crypto";
import type { Features } from "../../settings/index.js";
import { applySlashCommandIntake, type SlashCommandInput } from "./slashIntake.js";
import { resolveAskQuotaConfig, type AskQuotaConfig } from "../askQuota.js";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { inTransaction } from "../../db/postgres.js";
import type { ReviewAuthorTrust } from "../../commands/slashAssociation.js";
import {
  approveAwaiting,
  findAwaitingForHead,
  loadAwaitingApproval,
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
import type { RequestLogger, WideEventLevel } from "../../evlog.js";
import { recordEvent } from "../../evlog.js";
import {
  type AckJobData,
  type AckTarget,
  type JobCorrelation,
  type PrRef,
  type WebhookHeaders,
  prResourceKey,
} from "../types.js";
import {
  enqueueAck,
  enqueueDescription,
  enqueueReview,
  enqueueVerification,
  jobCorrelation,
} from "./queueing.js";
import { captureCiStateChanged } from "../../analytics/workCompleted.js";
import {
  isHeadCiSeedPullRequest,
  requestHeadCiProjection,
  shouldSeedHeadCiFromPullRequest,
} from "../ciProjection.js";
import { applyPrHeadCiFact, headCiNeedsSeed, loadPrHeadCiState } from "../prHeadCiState.js";
import type { CiCheckFact } from "../../review/ci/ciFacts.js";
import {
  cancelActiveTriage,
  cancelActiveReviews,
  createDescriptionWorkItem,
  createReviewWorkItem,
  createVerificationWorkItem,
  loadReviewLifecycle,
  reviewLifecycleObservationAccepted,
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

type PlannedAutomatedIntakeResult = {
  readonly duplicate: boolean;
  readonly reviewRefused?: "closed" | "merged";
  readonly correlation: JobCorrelation;
  readonly events: DeferredIntakeEvent[];
};

async function applyPlannedAutomatedPullRequestIntake(
  boss: PgBoss,
  tx: DeliveryTx,
  headers: WebhookHeaders,
  ref: PrRef,
  plan: AutomatedPrIntakePlan,
  pushBeforeSha?: string,
): Promise<PlannedAutomatedIntakeResult> {
  const client = tx.client;
  const events: DeferredIntakeEvent[] = [];
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  let reviewRefused: "closed" | "merged" | undefined;
  if (plan.kinds.some((kind) => kind.startsWith("review"))) {
    await tx.withReviewIntake(resourceKey, async (lifecycle) => {
      if (lifecycle != null && lifecycle.state !== "open") {
        reviewRefused = lifecycle.state;
        plan = { ...plan, kinds: plan.kinds.filter((kind) => !kind.startsWith("review")) };
      }
    });
  }
  const decision =
    reviewRefused != null && plan.kinds.length === 0
      ? `ignored_review_pr_${reviewRefused}`
      : automatedIntakeDecision(plan);
  const event = await tx.insert(decision);
  if (event.duplicate) return { duplicate: true, correlation: {}, events };
  const correlation = jobCorrelation(event.id, headers);
  if (reviewRefused != null)
    events.push({
      name: "review_intake_refused",
      fields: { resourceKey, reason: reviewRefused, source: "auto", ...correlation },
    });

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
  tx: DeliveryTx,
  headers: WebhookHeaders,
  ref: PrRef,
  observation: ReviewLifecycleObservation,
): Promise<DeferredIntakeEvent[]> {
  const client = tx.client;
  const events: DeferredIntakeEvent[] = [];
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  const accepts = await tx.withReviewIntake(resourceKey, async () =>
    reviewLifecycleObservationAccepted(client, resourceKey, observation),
  );
  const event = await tx.insert(
    accepts ? REVIEW_CANCELLED_PR_CLOSED : "ignored_stale_pr_lifecycle",
  );
  if (event.duplicate) return events;
  const correlation = jobCorrelation(event.id, headers);
  if (!accepts)
    return [
      {
        name: "ignored_stale_pr_lifecycle",
        fields: { resourceKey, state: observation.state, ...correlation },
      },
    ];
  const applied = await recordReviewLifecycleObservation(
    client,
    resourceKey,
    observation,
    event.id,
  );
  if (!applied) throw new Error("Locked lifecycle observation changed during delivery");
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

async function enqueueHeadCiProjection(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  correlation: JobCorrelation,
): Promise<DeferredIntakeEvent> {
  const result = await requestHeadCiProjection(
    boss,
    {
      installationId: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      headSha: ref.headSha,
      ...correlation,
    },
    { kind: "intake", client },
  );
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

async function applyAutomatedPullRequestIntake(
  boss: PgBoss,
  tx: DeliveryTx,
  command: Extract<IntakeCommand, { kind: "pull_request" }>,
  cfg: Pick<Config, "features">,
): Promise<DeferredIntakeEvent[]> {
  const { headers, ref, action, opts } = command;
  const client = tx.client;
  if (action === "closed") {
    if (!opts?.lifecycle)
      throw new Error("Close and reopen require a validated lifecycle observation");
    return applyReviewCloseCancelIntake(boss, tx, headers, ref, opts.lifecycle);
  }
  let reopenAccepted: boolean | undefined;
  if (action === "reopened") {
    if (!opts?.lifecycle)
      throw new Error("Close and reopen require a validated lifecycle observation");
    const observation = opts.lifecycle;
    reopenAccepted = await tx.withReviewIntake(
      prResourceKey(ref.owner, ref.repo, ref.prNumber),
      async () =>
        reviewLifecycleObservationAccepted(
          client,
          prResourceKey(ref.owner, ref.repo, ref.prNumber),
          observation,
        ),
    );
  }
  const plan = planAutomatedPullRequestIntake(action, cfg.features, opts?.authorTrust);
  if (plan.kinds.length > 0) {
    const planned = await applyPlannedAutomatedPullRequestIntake(
      boss,
      tx,
      headers,
      ref,
      plan,
      opts?.pushBeforeSha,
    );
    if (planned.duplicate) return planned.events;
    const row = await loadPrHeadCiState(client, ref.owner, ref.repo, ref.headSha);
    if (shouldSeedHeadCiFromPullRequest(action, ref.headSha, row))
      planned.events.push(await enqueueHeadCiProjection(boss, client, ref, planned.correlation));
    return planned.events;
  }
  const seedCandidate = isHeadCiSeedPullRequest(action, ref.headSha);
  const row = seedCandidate
    ? await loadPrHeadCiState(client, ref.owner, ref.repo, ref.headSha)
    : null;
  const seed = seedCandidate && headCiNeedsSeed(row);
  const lifecycleDecision = reopenAccepted
    ? "pr_review_lifecycle_applied"
    : "ignored_stale_pr_lifecycle";
  const event = await tx.insert(
    seed
      ? "ci_projection_enqueued"
      : reopenAccepted != null
        ? lifecycleDecision
        : `ignored_pull_request_${action}`,
  );
  if (event.duplicate) return [];
  const correlation = jobCorrelation(event.id, headers);
  const events: DeferredIntakeEvent[] = [];
  if (reopenAccepted != null && opts?.lifecycle != null) {
    const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    if (
      reopenAccepted &&
      !(await recordReviewLifecycleObservation(client, resourceKey, opts.lifecycle, event.id))
    )
      throw new Error("Locked lifecycle observation changed during delivery");
    events.push({
      name: lifecycleDecision,
      fields: { resourceKey, state: opts.lifecycle.state, ...correlation },
    });
  }
  if (seed) events.push(await enqueueHeadCiProjection(boss, client, ref, correlation));
  return events;
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

async function applyReviewApprovedIntake(
  boss: PgBoss,
  tx: DeliveryTx,
  signal: ReviewApprovalSignal,
): Promise<DeferredIntakeEvent[]> {
  const client = tx.client;
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
  const admitted: PrRef[] = [];
  for (const resourceKey of [...refs.keys()].toSorted()) {
    await tx.withReviewIntake(resourceKey, async (lifecycle) => {
      if (lifecycle != null && lifecycle.state !== "open") return;
      if (
        await loadAwaitingApproval(
          client,
          resourceKey,
          signal.kind === "workflow_run" ? signal.headSha : undefined,
        )
      )
        admitted.push(refs.get(resourceKey)!);
    });
  }
  const decision = admitted.length > 0 ? REVIEW_APPROVED : IGNORED_REVIEW_APPROVAL_NOT_AWAITING;
  const event = await tx.insert(decision);
  if (event.duplicate) return [];
  const correlation = jobCorrelation(event.id, tx.headers);
  const events: DeferredIntakeEvent[] = [];
  for (const ref of admitted) {
    const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    const approved = await approveAwaiting(
      client,
      resourceKey,
      signal.kind,
      signal.kind === "workflow_run" ? signal.headSha : undefined,
    );
    if (approved == null) throw new Error("Locked awaiting approval changed during delivery");
    const deferredRef = { ...ref, headSha: DEFERRED_HEAD_SHA };
    const ackTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    events.push(
      ...(await dispatchAutomatedKind(client, resourceKey, correlation, {
        target: { kind: "review", resourceKey },
        createWorkItem: () =>
          createReviewWorkItem(client, {
            webhookEventId: event.id,
            ref: deferredRef,
            source: "auto",
            ackTargets,
          }),
        enqueue: (workItemId) => enqueueReview(boss, client, deferredRef, workItemId, correlation),
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
  events.push({ name: decision, fields: { signal: signal.kind, ...correlation } });
  return events;
}

/**
 * Enqueues one head-scoped projection for a completed workflow_run / check_suite.
 * Does not write facts. Empty pull_requests still enqueue (ADR 0035).
 */
async function applyCompletedRunCiIntake(
  boss: PgBoss,
  tx: DeliveryTx,
  headers: WebhookHeaders,
  data: {
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly headSha: string;
    readonly prNumbers: readonly number[];
  },
): Promise<DeferredIntakeEvent[]> {
  const client = tx.client;
  const deferred: DeferredIntakeEvent[] = [];
  const event = await tx.insert("ci_projection_enqueued");
  if (event.duplicate) {
    return deferred;
  }
  const result = await requestHeadCiProjection(
    boss,
    {
      installationId: data.installationId,
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      ...jobCorrelation(event.id, headers),
    },
    { kind: "intake", client },
  );
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
async function applyCiStateIntake(
  boss: PgBoss,
  tx: DeliveryTx,
  headers: WebhookHeaders,
  data: CiStateFactInput,
): Promise<DeferredIntakeEvent[]> {
  const client = tx.client;
  const deferred: DeferredIntakeEvent[] = [];
  const event = await tx.insert("ci_state_applied");
  if (event.duplicate) return deferred;
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
  if (applied.previousRollup !== applied.rollup)
    tx.afterCommit.push(() =>
      captureCiStateChanged({
        installationId: data.installationId,
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        fromRollup: applied.previousRollup,
        toRollup: applied.rollup,
        version: applied.version,
      }),
    );
  const result = await requestHeadCiProjection(
    boss,
    {
      installationId: data.installationId,
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      ...jobCorrelation(event.id, headers),
    },
    { kind: "intake", client },
  );
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
}

type EventRecord =
  | {
      readonly id: string;
      readonly duplicate: false;
      readonly dedupeKey: string;
    }
  | {
      readonly id?: undefined;
      readonly duplicate: true;
      readonly dedupeKey: string;
    };

function webhookEventKeys(headers: WebhookHeaders): {
  readonly dedupeKey: string;
  readonly bodyDedupeKey: string;
  readonly bodySha256: string;
} {
  const bodySha256 = crypto.createHash("sha256").update(headers.rawBody).digest("hex");
  return {
    dedupeKey: headers.delivery ? `delivery:${headers.delivery}` : `body:${bodySha256}`,
    bodyDedupeKey: `body:${bodySha256}`,
    bodySha256,
  };
}

async function recordDuplicateWebhookEvent(
  client: PoolClient,
  id: string,
  headers: WebhookHeaders,
  bodySha256: string,
  dedupeKey: string,
  reason: "delivery_key" | "body_key" | "body_replay",
): Promise<void> {
  await client.query(
    `INSERT INTO webhook_delivery_duplicates
       (id, delivery_id, event_name, body_sha256, dedupe_key, dedupe_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, headers.delivery ?? null, headers.event ?? "", bodySha256, dedupeKey, reason],
  );
}

async function insertWebhookEvent(
  client: PoolClient,
  headers: WebhookHeaders,
  decision: string,
): Promise<EventRecord> {
  const id = crypto.randomUUID();
  const keys = webhookEventKeys(headers);
  const result = await client.query<{ id: string }>(
    `INSERT INTO webhook_events (id, dedupe_key, delivery_id, event_name, body_sha256, processing_decision, processed_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now())
		 ON CONFLICT (dedupe_key) DO NOTHING
		 RETURNING id`,
    [id, keys.dedupeKey, headers.delivery ?? null, headers.event ?? "", keys.bodySha256, decision],
  );
  const inserted = result.rows[0]?.id;
  if (inserted == null) {
    await recordDuplicateWebhookEvent(
      client,
      id,
      headers,
      keys.bodySha256,
      keys.dedupeKey,
      headers.delivery ? "delivery_key" : "body_key",
    );
    return {
      duplicate: true,
      dedupeKey: keys.dedupeKey,
    };
  }

  const replay = await client.query<{ body_sha256: string }>(
    `INSERT INTO webhook_event_replays (body_sha256, webhook_event_id)
		 VALUES ($1, $2)
		 ON CONFLICT (body_sha256) DO NOTHING
		 RETURNING body_sha256`,
    [keys.bodySha256, inserted],
  );
  if (replay.rows[0]?.body_sha256 == null) {
    await client.query("DELETE FROM webhook_events WHERE id = $1", [inserted]);
    await recordDuplicateWebhookEvent(
      client,
      id,
      headers,
      keys.bodySha256,
      keys.bodyDedupeKey,
      "body_replay",
    );
    return {
      duplicate: true,
      dedupeKey: keys.bodyDedupeKey,
    };
  }

  return {
    id: inserted,
    duplicate: false,
    dedupeKey: keys.dedupeKey,
  };
}

/** Durable work kinds scheduled from automated pull_request webhooks. */
type AutomatedPrIntakeKind =
  | "review"
  | "reviewSupersede"
  | "reviewAwaitApproval"
  | "reviewTrackAwaitingHead"
  | "description"
  | "verification";

type AutomatedPrIntakePlan = {
  readonly kinds: readonly AutomatedPrIntakeKind[];
};

function automatedIntakeDecision(plan: AutomatedPrIntakePlan) {
  if (plan.kinds.includes("review")) {
    return "automated_review_enqueued";
  }
  if (plan.kinds.includes("reviewAwaitApproval")) return "review_awaiting_approval";
  if (plan.kinds.includes("reviewSupersede")) {
    return "automated_review_supersede_requested";
  }
  return "automated_work_enqueued";
}

/** Pure planner: maps webhook action + feature modes → agent work kinds (no I/O). */
function planAutomatedPullRequestIntake(
  action: string,
  features: Pick<Features, "review" | "describe" | "verification">,
  authorTrust: ReviewAuthorTrust = "awaiting_approval",
): AutomatedPrIntakePlan {
  const kinds: AutomatedPrIntakeKind[] = [];
  switch (action) {
    case "opened":
      if (
        features.review === "auto" ||
        (features.review === "approval" && authorTrust === "trusted")
      ) {
        kinds.push("review");
      } else if (features.review === "approval") {
        kinds.push("reviewAwaitApproval");
      }
      if (features.describe === "auto") kinds.push("description");
      break;
    case "synchronize":
      if (features.review !== "manual") kinds.push("reviewSupersede");
      if (features.review === "approval") kinds.push("reviewTrackAwaitingHead");
      if (features.verification === "auto") kinds.push("verification");
      break;
  }
  return { kinds };
}

export type DeferredIntakeEvent = {
  readonly name: string;
  readonly fields?: Record<string, unknown>;
  readonly level?: WideEventLevel;
};

export type IntakeCommand =
  | { readonly kind: "ignored"; readonly headers: WebhookHeaders; readonly decision: string }
  | {
      readonly kind: "pull_request";
      readonly headers: WebhookHeaders;
      readonly ref: PrRef;
      readonly action: string;
      readonly opts?: AutomatedPullRequestIntakeOpts;
    }
  | {
      readonly kind: "review_approved";
      readonly headers: WebhookHeaders;
      readonly signal: ReviewApprovalSignal;
    }
  | {
      readonly kind: "ci_refresh";
      readonly headers: WebhookHeaders;
      readonly data: {
        readonly installationId: number;
        readonly owner: string;
        readonly repo: string;
        readonly headSha: string;
        readonly prNumbers: readonly number[];
      };
    }
  | { readonly kind: "ci_state"; readonly headers: WebhookHeaders; readonly data: CiStateFactInput }
  | { readonly kind: "slash"; readonly input: SlashCommandInput };

export class DeliveryTx {
  readonly events: DeferredIntakeEvent[] = [];
  readonly afterCommit: Array<() => void> = [];
  constructor(
    readonly client: PoolClient,
    readonly headers: WebhookHeaders,
  ) {}
  async insert(decision: string): Promise<EventRecord> {
    const event = await insertWebhookEvent(this.client, this.headers, decision);
    if (event.duplicate)
      this.events.push({
        name: "deduped_delivery",
        fields: { dedupeKey: event.dedupeKey, event: this.headers.event },
      });
    return event;
  }
  async withReviewIntake<T>(
    resourceKey: string,
    apply: (lifecycle: Awaited<ReturnType<typeof loadReviewLifecycle>>) => Promise<T>,
  ): Promise<T> {
    await acquireAutoWorkIntakeLock(this.client, { kind: "review", resourceKey });
    const lifecycle = await loadReviewLifecycle(this.client, resourceKey);
    return apply(lifecycle);
  }
}

export async function runDelivery(
  pool: Pool,
  boss: PgBoss,
  cfg: Pick<Config, "features"> & Partial<AskQuotaConfig>,
  command: IntakeCommand,
  log: RequestLogger,
): Promise<void> {
  const completed = await inTransaction(pool, async (client) => {
    const tx = new DeliveryTx(
      client,
      command.kind === "slash" ? command.input.headers : command.headers,
    );
    let events: DeferredIntakeEvent[];
    switch (command.kind) {
      case "ignored":
        await tx.insert(command.decision);
        events = [];
        break;
      case "pull_request":
        events = await applyAutomatedPullRequestIntake(boss, tx, command, cfg);
        break;
      case "review_approved":
        events = await applyReviewApprovedIntake(boss, tx, command.signal);
        break;
      case "ci_refresh":
        events = await applyCompletedRunCiIntake(boss, tx, command.headers, command.data);
        break;
      case "ci_state":
        events = await applyCiStateIntake(boss, tx, command.headers, command.data);
        break;
      case "slash":
        events = await applySlashCommandIntake(
          boss,
          tx,
          command.input,
          cfg.features,
          resolveAskQuotaConfig(cfg),
        );
        break;
      default:
        command satisfies never;
        throw new Error("Unknown intake command");
    }
    tx.events.push(...events);
    return tx;
  });
  for (const action of completed.afterCommit) action();
  for (const event of completed.events)
    recordEvent(log, event.name, event.fields, event.level ?? "info");
}
