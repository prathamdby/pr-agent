import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.js";
import { ASK_QUESTION_TOO_LONG_HINT, parseAskQuestion } from "../../commands/parseAskQuestion.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import { ASK_THROTTLED_BODY, ASK_USAGE_HINT, DEFERRED_HEAD_SHA } from "../../settings/index.js";
import type { AckJobData, AckTarget, JobCorrelation, PrRef } from "../types.js";
import { admitAsk, releaseAskQuotaReservation, type AskQuotaConfig } from "../askQuota.js";
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
 * Policy when `createAskWorkItem` finds an existing ask for this webhook event:
 * - `skip` — slash/mention webhook path: work was already ensured; do not re-enqueue
 * - `recover` — retry path: re-enqueue ack/ask idempotently for the existing id
 */
export type ExistingAskWorkItemPolicy = "skip" | "recover";

export type AskIntakeOutcome =
  | { readonly kind: "hint_acked"; readonly reason: "usage" | "too_long" }
  | { readonly kind: "throttled"; readonly reason: string }
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
