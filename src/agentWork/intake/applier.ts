import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { AUTOMATED_REVIEW_LENS, DESCRIPTION_QUEUE, REVIEW_QUEUE } from "../../settings/index.js";
import {
  replaceAutoWorkItem,
  releaseSingletonIfSuperseded,
  type AutoWorkSupersedeTarget,
} from "../autoWorkEnqueue.js";
import { releaseSingletonSlot, reviewSingletonSlotDb } from "../singletonQueue.js";
import type { RequestLogger } from "../../evlog.js";
import { recordEvent } from "../../evlog.js";
import {
  type AckJobData,
  type AckTarget,
  type PrRef,
  type WebhookHeaders,
  prResourceKey,
  reviewSingletonKey,
  descriptionSingletonKey,
} from "../types.js";
import { planAutomatedPullRequestIntake } from "./planner.js";
import { enqueueAck, enqueueDescription, enqueueReview, jobCorrelation } from "./queueing.js";
import { applySlashCommandIntake, type SlashCommandInput } from "./slashIntake.js";
import { dedupeKey, insertWebhookEvent } from "./webhookEvents.js";
import { createDescriptionWorkItem, createReviewWorkItem } from "./workItemRepository.js";

export type { SlashCommandInput };
export { applySlashCommandIntake };

export async function recordIgnoredWebhook(
  client: Pool | PoolClient,
  headers: WebhookHeaders,
  decision: string,
  intakeLog: RequestLogger,
): Promise<void> {
  const event = await insertWebhookEvent(client, headers, decision);
  if (event.duplicate) {
    recordEvent(intakeLog, "deduped_delivery", {
      dedupeKey: dedupeKey(headers),
      event: headers.event,
    });
  }
}

export async function applyAutomatedPullRequestIntake(
  boss: PgBoss,
  client: PoolClient,
  headers: WebhookHeaders,
  ref: PrRef,
  action: string,
  intakeLog: RequestLogger,
): Promise<void> {
  const plan = planAutomatedPullRequestIntake(action);
  if (plan.kinds.length === 0) {
    await insertWebhookEvent(client, headers, `ignored_pull_request_${action}`);
    return;
  }

  const event = await insertWebhookEvent(client, headers, "automated_review_enqueued");
  if (event.duplicate) {
    recordEvent(intakeLog, "deduped_delivery", {
      dedupeKey: dedupeKey(headers),
      event: headers.event,
    });
    return;
  }
  const correlation = jobCorrelation(event.id, headers);
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  const slotDb = reviewSingletonSlotDb(client);

  if (plan.kinds.includes("review")) {
    const reviewTarget: AutoWorkSupersedeTarget = {
      kind: "review",
      resourceKey,
      lens: AUTOMATED_REVIEW_LENS,
    };
    const { workItemId, supersededIds: reviewSuperseded } = await replaceAutoWorkItem({
      client,
      target: reviewTarget,
      createWorkItem: () =>
        createReviewWorkItem(client, {
          webhookEventId: event.id,
          ref,
          source: "auto",
          lens: AUTOMATED_REVIEW_LENS,
        }),
    });
    await releaseSingletonIfSuperseded({
      boss,
      db: slotDb,
      supersededIds: reviewSuperseded,
      release: () =>
        releaseSingletonSlot(boss, {
          queue: REVIEW_QUEUE,
          singletonKey: reviewSingletonKey(resourceKey, AUTOMATED_REVIEW_LENS),
          db: slotDb,
        }),
    });
    const ackTargets: AckTarget[] = [{ kind: "pr", prNumber: ref.prNumber }];
    const ackData: AckJobData = {
      kind: "ack",
      workItemId,
      installationId: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      targets: ackTargets,
      progress: {
        lens: AUTOMATED_REVIEW_LENS,
        headSha: ref.headSha,
        source: "auto",
      },
      ...correlation,
    };
    await enqueueAck(boss, client, ackData);
    await enqueueReview(boss, client, ref, workItemId, AUTOMATED_REVIEW_LENS, correlation);
    recordEvent(intakeLog, "agent_work_enqueued", {
      type: "review",
      source: "auto",
      workItemId,
      resourceKey,
      ...correlation,
    });
  }

  if (plan.kinds.includes("description")) {
    const descriptionTarget: AutoWorkSupersedeTarget = {
      kind: "description",
      resourceKey,
    };
    const { workItemId: descriptionWorkItemId, supersededIds: descriptionSuperseded } =
      await replaceAutoWorkItem({
        client,
        target: descriptionTarget,
        createWorkItem: () =>
          createDescriptionWorkItem(client, {
            webhookEventId: event.id,
            ref,
            source: "auto",
          }),
      });
    await releaseSingletonIfSuperseded({
      boss,
      db: slotDb,
      supersededIds: descriptionSuperseded,
      release: () =>
        releaseSingletonSlot(boss, {
          queue: DESCRIPTION_QUEUE,
          singletonKey: descriptionSingletonKey(resourceKey),
          db: slotDb,
        }),
    });
    await enqueueDescription(boss, client, ref, descriptionWorkItemId, correlation);
    recordEvent(intakeLog, "agent_work_enqueued", {
      type: "description",
      source: "auto",
      workItemId: descriptionWorkItemId,
      resourceKey,
      ...correlation,
    });
  }
}
