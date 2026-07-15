import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import type { RequestLogger } from "../../evlog.js";
import { recordEvent } from "../../evlog.js";
import { THREAD_REPLY_CLASSIFICATION_QUEUED } from "../../settings/index.js";
import type { WebhookHeaders } from "../types.js";
import { enqueueThreadReplyClassify, jobCorrelation } from "./queueing.js";
import { insertWebhookEvent } from "./webhookEvents.js";

export type ThreadReplyClassifyInput = {
  readonly headers: WebhookHeaders;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly repositorySizeKb?: number;
  readonly prNumber: number;
  readonly commentId: number;
  readonly commenterId: number;
  readonly authorAssociation: string | null;
  readonly body: string;
  readonly replyTarget: ReplyTarget;
  readonly codeAnchor?: CodeAnchor;
  readonly inReplyToCommentId: number;
  readonly pullRequestReviewId: number | null;
  readonly storedReviewMatchHint?: boolean;
};

export async function applyThreadReplyClassifyIntake(
  boss: PgBoss,
  client: PoolClient,
  input: ThreadReplyClassifyInput,
  intakeLog: RequestLogger,
): Promise<void> {
  const event = await insertWebhookEvent(client, input.headers, THREAD_REPLY_CLASSIFICATION_QUEUED);
  if (event.duplicate) {
    recordEvent(intakeLog, "deduped_delivery", {
      dedupeKey: event.dedupeKey,
      event: input.headers.event,
    });
    return;
  }

  const correlation = jobCorrelation(event.id, input.headers);
  await enqueueThreadReplyClassify(boss, client, {
    kind: "thread_reply_classify",
    ...correlation,
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    repositorySizeKb: input.repositorySizeKb,
    prNumber: input.prNumber,
    commentId: input.commentId,
    commenterId: input.commenterId,
    authorAssociation: input.authorAssociation,
    body: input.body,
    replyTarget: input.replyTarget,
    codeAnchor: input.codeAnchor,
    inReplyToCommentId: input.inReplyToCommentId,
    pullRequestReviewId: input.pullRequestReviewId,
    storedReviewMatchHint: input.storedReviewMatchHint,
  });
  recordEvent(intakeLog, "thread_reply_classification_enqueued", {
    ...correlation,
    storedReviewMatchHint: input.storedReviewMatchHint === true,
  });
}
