import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import {
  parseAskQuestionResult,
  ASK_QUESTION_TOO_LONG_HINT,
} from "../../commands/parseAskQuestion.js";
import { parseSlashCommand } from "../../commands/parseSlashCommand.js";
import {
  ASK_USAGE_HINT,
  DEFERRED_HEAD_SHA,
  DESCRIPTION_ALREADY_IN_PROGRESS,
  MAX_STORED_COMMENT_TEXT_LEN,
  SLASH_HELP_BODY,
} from "../../settings/index.js";
import type { ReviewMode } from "../../review/reviewSchema.js";
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
import type { CodeAnchor } from "../../agent/askRunTypes.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import { dedupeKey, insertWebhookEvent } from "./webhookEvents.js";

export type SlashCommandInput = {
  readonly headers: WebhookHeaders;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly repositorySizeKb?: number;
  readonly prNumber: number;
  readonly commentId: number;
  readonly commenterId: number;
  readonly body: string;
  readonly replyTarget: ReplyTarget;
  readonly codeAnchor?: CodeAnchor;
};
import {
  enqueueAck,
  enqueueAsk,
  enqueueDescription,
  enqueueReview,
  jobCorrelation,
} from "./queueing.js";
import {
  createAskWorkItem,
  createDescriptionWorkItem,
  createReviewWorkItem,
  fetchActiveWorkItem,
} from "./workItemRepository.js";

function clampStoredCommentText(text: string): string {
  return text.split("\u0000").join("").slice(0, MAX_STORED_COMMENT_TEXT_LEN);
}

type SlashIntakeContext = {
  readonly boss: PgBoss;
  readonly client: PoolClient;
  readonly input: SlashCommandInput;
  readonly eventId: string;
  readonly correlation: JobCorrelation;
  readonly ref: PrRef;
  readonly baseAck: Omit<AckJobData, "workItemId" | "progress" | "reply"> & { kind: "ack" };
  readonly intakeLog: RequestLogger;
};

async function enqueueSlashAck(
  ctx: SlashIntakeContext,
  extra: Partial<Pick<AckJobData, "workItemId" | "progress" | "reply">>,
): Promise<void> {
  await enqueueAck(ctx.boss, ctx.client, {
    ...ctx.baseAck,
    ...ctx.correlation,
    ...extra,
  });
}

async function handleSlashHelp(ctx: SlashIntakeContext): Promise<void> {
  await enqueueSlashAck(ctx, {
    reply: { target: ctx.input.replyTarget, body: SLASH_HELP_BODY },
  });
}

async function handleSlashAsk(ctx: SlashIntakeContext): Promise<void> {
  const askParse = parseAskQuestionResult(ctx.input.body);
  if (askParse.kind === "too_long") {
    await enqueueSlashAck(ctx, {
      reply: { target: ctx.input.replyTarget, body: ASK_QUESTION_TOO_LONG_HINT },
    });
    return;
  }
  if (askParse.kind !== "ok") {
    await enqueueSlashAck(ctx, {
      reply: { target: ctx.input.replyTarget, body: ASK_USAGE_HINT },
    });
    return;
  }
  const askRef = { ...ctx.ref, headSha: DEFERRED_HEAD_SHA };
  const workItemId = await createAskWorkItem(ctx.client, {
    webhookEventId: ctx.eventId,
    ref: askRef,
    question: askParse.question,
    replyTarget: ctx.input.replyTarget,
    commentId: ctx.input.commentId,
    commenterId: ctx.input.commenterId,
    codeAnchor: ctx.input.codeAnchor,
  });
  await enqueueSlashAck(ctx, { workItemId });
  await enqueueAsk(ctx.boss, ctx.client, ctx.ref, workItemId, ctx.correlation);
  recordEvent(ctx.intakeLog, "agent_work_enqueued", {
    type: "ask",
    source: "slash",
    workItemId,
    ...ctx.correlation,
  });
}

async function handleSlashDescribe(ctx: SlashIntakeContext): Promise<void> {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const existing = await fetchActiveWorkItem(ctx.client, { kind: "description", resourceKey });
  if (existing) {
    await enqueueSlashAck(ctx, {
      reply: { target: ctx.input.replyTarget, body: DESCRIPTION_ALREADY_IN_PROGRESS },
    });
    return;
  }
  const workItemId = await createDescriptionWorkItem(ctx.client, {
    webhookEventId: ctx.eventId,
    ref: ctx.ref,
    source: "slash",
    userSupplement: clampStoredCommentText(`User invoked /describe with:\n${ctx.input.body}`),
    commenterId: ctx.input.commenterId,
  });
  await enqueueSlashAck(ctx, { workItemId });
  await enqueueDescription(ctx.boss, ctx.client, ctx.ref, workItemId, ctx.correlation);
  recordEvent(ctx.intakeLog, "agent_work_enqueued", {
    type: "description",
    source: "slash",
    workItemId,
    resourceKey,
    ...ctx.correlation,
  });
}

async function handleSlashReview(ctx: SlashIntakeContext, command: ReviewMode): Promise<void> {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const existing = await fetchActiveWorkItem(ctx.client, {
    kind: "review",
    resourceKey,
    lens: command,
  });
  if (existing) {
    await enqueueSlashAck(ctx, {
      reply: {
        target: ctx.input.replyTarget,
        body: `A \`/${command}\` run is already queued or in progress for this pull request.`,
      },
    });
    return;
  }
  const workItemId = await createReviewWorkItem(ctx.client, {
    webhookEventId: ctx.eventId,
    ref: ctx.ref,
    source: "slash",
    lens: command,
    userSupplement: clampStoredCommentText(`User invoked /${command} with:\n${ctx.input.body}`),
    commenterId: ctx.input.commenterId,
  });
  await enqueueSlashAck(ctx, {
    workItemId,
    progress: { lens: command, headSha: ctx.ref.headSha, source: "slash" },
  });
  await enqueueReview(ctx.boss, ctx.client, ctx.ref, workItemId, command, ctx.correlation);
  recordEvent(ctx.intakeLog, "agent_work_enqueued", {
    type: "review",
    source: "slash",
    workItemId,
    resourceKey,
    lens: command,
    ...ctx.correlation,
  });
}

async function handleSlashUnknown(ctx: SlashIntakeContext, command: string): Promise<void> {
  await enqueueSlashAck(ctx, {
    reply: {
      target: ctx.input.replyTarget,
      body: `Unknown command \`/${command}\`. Try \`/help\`.`,
    },
  });
}

const SLASH_INTAKE_HANDLERS: Record<
  string,
  (ctx: SlashIntakeContext, command: string) => Promise<void>
> = {
  help: (ctx) => handleSlashHelp(ctx),
  ask: (ctx) => handleSlashAsk(ctx),
  describe: (ctx) => handleSlashDescribe(ctx),
  review: (ctx, command) => handleSlashReview(ctx, command as ReviewMode),
  "review-security": (ctx, command) => handleSlashReview(ctx, command as ReviewMode),
  "review-quality": (ctx, command) => handleSlashReview(ctx, command as ReviewMode),
};

export async function applySlashCommandIntake(
  boss: PgBoss,
  client: PoolClient,
  input: SlashCommandInput,
  intakeLog: RequestLogger,
): Promise<void> {
  const command = parseSlashCommand(input.body);
  if (!command) {
    await insertWebhookEvent(client, input.headers, "ignored_no_slash_command");
    return;
  }

  const event = await insertWebhookEvent(client, input.headers, `slash_${command}`);
  if (event.duplicate) {
    recordEvent(intakeLog, "deduped_delivery", {
      dedupeKey: dedupeKey(input.headers),
      event: input.headers.event,
    });
    return;
  }

  const correlation = jobCorrelation(event.id, input.headers);
  const ref: PrRef = {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    installationId: input.installationId,
    headSha: DEFERRED_HEAD_SHA,
    repositorySizeKb: input.repositorySizeKb,
  };
  const targets: AckTarget[] = [
    { kind: "pr", prNumber: input.prNumber },
    input.replyTarget.kind === "prConversation"
      ? { kind: "issueComment", commentId: input.commentId }
      : { kind: "reviewComment", commentId: input.commentId },
  ];
  const ctx: SlashIntakeContext = {
    boss,
    client,
    input,
    eventId: event.id,
    correlation,
    ref,
    baseAck: {
      kind: "ack",
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      targets,
      commenterId: input.commenterId,
    },
    intakeLog,
  };

  const handler = SLASH_INTAKE_HANDLERS[command];
  if (handler) {
    await handler(ctx, command);
    return;
  }
  await handleSlashUnknown(ctx, command);
}
