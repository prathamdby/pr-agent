import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.js";
import { ASK_QUESTION_TOO_LONG_HINT, parseAskQuestion } from "../../commands/parseAskQuestion.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import { ASK_THROTTLED_BODY, ASK_USAGE_HINT, DEFERRED_HEAD_SHA } from "../../settings/index.js";
import type { AckJobData, AckTarget, JobCorrelation, PrRef } from "../types.js";
import { prResourceKey } from "../types.js";
import {
  admitAsk,
  releaseAskQuotaReservation,
  type AskQuotaConfig,
  type AskQuotaRejectionReason,
} from "../askQuota.js";
import { enqueueAsk, enqueueAskAckIdempotent } from "./queueing.js";
import { createAskWorkItem } from "./workItemRepository.js";

export type AskIntakeInput = {
  readonly webhookEventId: string;
  readonly correlation: JobCorrelation;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly repositorySizeKb?: number;
  readonly prNumber: number;
  readonly body: string;
  readonly replyTarget: ReplyTarget;
  readonly commentId: number;
  readonly commenterId: number;
  readonly codeAnchor?: CodeAnchor;
  readonly ackTargets: readonly AckTarget[];
  readonly askQuota: AskQuotaConfig;
  /** App bot login for `@mention` ask parsing (optional; slash `/ask` does not need it). */
  readonly botLogin?: string;
};

/**
 * Policy when an existing ask matches this intake:
 * - `skip` — slash/mention webhook path: work was already ensured; do not re-enqueue
 * - `recover` — retry path for the same webhook event: re-enqueue ack/ask
 *   idempotently for the existing id. A retained ask for the same mention but a
 *   different event is always a quiet join, never a re-enqueue.
 */
export type ExistingAskWorkItemPolicy = "skip" | "recover";

export type AskIntakeOutcome =
  | { readonly kind: "hint_acked"; readonly reason: "usage" | "too_long" }
  | { readonly kind: "throttled"; readonly reason: AskQuotaRejectionReason }
  | { readonly kind: "promoted"; readonly workItemId: string; readonly created: boolean }
  | { readonly kind: "already_exists_skipped"; readonly workItemId: string };

function askRef(input: AskIntakeInput): PrRef {
  return {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    installationId: input.installationId,
    headSha: DEFERRED_HEAD_SHA,
    repositorySizeKb: input.repositorySizeKb,
  };
}

type RetainedAskMention = {
  readonly id: string;
  readonly webhookEventId: string | null;
};

function askMentionLockKey(input: AskIntakeInput): string {
  return JSON.stringify([
    "ask_mention_intake",
    input.installationId,
    prResourceKey(input.owner, input.repo, input.prNumber),
    input.replyTarget.kind,
    input.commentId,
  ]);
}

/**
 * All production ask creation resolves the triggering mention under the
 * caller's transaction: the advisory lock is held until the outer commit or
 * rollback, and the lookup runs as a separate statement so READ COMMITTED sees
 * a same-mention winner that has just committed. Retained rows of every status
 * join, so one mention gets one answer until retention removes the evidence.
 */
async function findRetainedAskForMention(
  client: PoolClient,
  input: AskIntakeInput,
): Promise<RetainedAskMention | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    askMentionLockKey(input),
  ]);
  const { rows } = await client.query<{ id: string; webhook_event_id: string | null }>(
    `SELECT id, webhook_event_id
       FROM agent_work_items
      WHERE type = 'ask'
        AND installation_id = $1
        AND resource_key = $2
        AND payload->'replyTarget'->>'kind' = $3
        AND payload->>'commentId' = $4
      ORDER BY CASE WHEN webhook_event_id = $5::uuid THEN 0 ELSE 1 END, created_at, id
      LIMIT 1`,
    [
      input.installationId,
      prResourceKey(input.owner, input.repo, input.prNumber),
      input.replyTarget.kind,
      String(input.commentId),
      input.webhookEventId,
    ],
  );
  const row = rows[0];
  return row ? { id: row.id, webhookEventId: row.webhook_event_id } : null;
}

function baseAck(input: AskIntakeInput): AckJobData {
  return {
    kind: "ack",
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    targets: input.ackTargets,
    commenterId: input.commenterId,
    ...input.correlation,
  };
}

/**
 * Canonical ask intake shared by `/ask` slash commands and `@bot` mentions.
 * Owns question parsing, usage/too-long acknowledgement, idempotent ask
 * work-item ensure, ack enqueue, and ask enqueue.
 */
export async function promoteAskFromWebhookEvent(
  boss: PgBoss,
  client: PoolClient,
  input: AskIntakeInput,
  existingWorkItemPolicy: ExistingAskWorkItemPolicy,
): Promise<AskIntakeOutcome> {
  const askParse = parseAskQuestion(input.body, input.botLogin);
  const ack = baseAck(input);

  switch (askParse.kind) {
    case "too_long": {
      await enqueueAskAckIdempotent(
        boss,
        client,
        {
          ...ack,
          reply: { target: input.replyTarget, body: ASK_QUESTION_TOO_LONG_HINT },
        },
        input.webhookEventId,
      );
      return { kind: "hint_acked", reason: "too_long" };
    }
    case "missing":
    case "not_ask": {
      await enqueueAskAckIdempotent(
        boss,
        client,
        {
          ...ack,
          reply: { target: input.replyTarget, body: ASK_USAGE_HINT },
        },
        input.webhookEventId,
      );
      return { kind: "hint_acked", reason: "usage" };
    }
    case "ok":
      break;
    default: {
      const exhaustive: never = askParse;
      return exhaustive;
    }
  }

  const ref = askRef(input);
  const retained = await findRetainedAskForMention(client, input);
  if (retained) {
    if (retained.webhookEventId !== input.webhookEventId) {
      return { kind: "already_exists_skipped", workItemId: retained.id };
    }
    switch (existingWorkItemPolicy) {
      case "skip":
        return { kind: "already_exists_skipped", workItemId: retained.id };
      case "recover": {
        const workItemId = retained.id;
        await enqueueAskAckIdempotent(boss, client, { ...ack, workItemId }, input.webhookEventId);
        await enqueueAsk(boss, client, ref, workItemId, input.correlation);
        return { kind: "promoted", workItemId, created: false };
      }
      default: {
        const exhaustive: never = existingWorkItemPolicy;
        return exhaustive;
      }
    }
  }

  const reservedWorkItemId = crypto.randomUUID();
  const admission = await admitAsk(
    client,
    {
      workItemId: reservedWorkItemId,
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      commenterId: input.commenterId,
    },
    input.askQuota,
  );
  if (admission.kind === "throttled") {
    await enqueueAskAckIdempotent(
      boss,
      client,
      {
        ...ack,
        reply: { target: input.replyTarget, body: ASK_THROTTLED_BODY },
      },
      input.webhookEventId,
    );
    return { kind: "throttled", reason: admission.reason };
  }

  const askInsert = await createAskWorkItem(client, {
    workItemId: reservedWorkItemId,
    webhookEventId: input.webhookEventId,
    ref,
    question: redactOutboundSecrets(askParse.question),
    replyTarget: input.replyTarget,
    commentId: input.commentId,
    commenterId: input.commenterId,
    codeAnchor: input.codeAnchor,
    ackTargets: input.ackTargets,
  });

  if (!askInsert.created) {
    await releaseAskQuotaReservation(client, reservedWorkItemId);
    switch (existingWorkItemPolicy) {
      case "skip":
        return { kind: "already_exists_skipped", workItemId: askInsert.id };
      case "recover":
        break;
      default: {
        const exhaustive: never = existingWorkItemPolicy;
        return exhaustive;
      }
    }
  }

  const workItemId = askInsert.id;
  await enqueueAskAckIdempotent(boss, client, { ...ack, workItemId }, input.webhookEventId);
  await enqueueAsk(boss, client, ref, workItemId, input.correlation);
  return { kind: "promoted", workItemId, created: askInsert.created };
}
