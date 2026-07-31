import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { AppError } from "../../errors/appError.js";
import {
  DEFERRED_HEAD_SHA,
  DESCRIPTION_ALREADY_IN_PROGRESS,
  MAX_STORED_COMMENT_TEXT_LEN,
  SLASH_HELP_BODY,
  TRIAGE_ALREADY_IN_PROGRESS,
  TRIAGE_FULL_RUN_IN_PROGRESS,
  TRIAGE_INLINE_USAGE_HINT,
  slashDisabledBody,
  type Features,
} from "../../settings/index.js";
import type { DeferredIntakeEvent } from "./deferredEvents.js";
import {
  type AckJobData,
  type AckTarget,
  type JobCorrelation,
  type PrRef,
  type WebhookHeaders,
  prResourceKey,
} from "../types.js";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import { insertWebhookEvent } from "./webhookEvents.js";
import { captureTriageEvent } from "../triageAnalytics.js";
import {
  enqueueAck,
  enqueueDescription,
  enqueueReview,
  enqueueTriage,
  jobCorrelation,
} from "./queueing.js";
import { promoteAskFromWebhookEvent } from "./askIntake.js";
import { releaseReviewSingletonSlot } from "../singletonQueue.js";
import { pgBossDb } from "../../db/postgres.js";
import {
  createDescriptionWorkItem,
  createReviewWorkItem,
  createTriageWorkItem,
  fetchActiveTriageWorkItem,
} from "./workItemRepository.js";

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
  readonly command: string;
  readonly replyTarget: ReplyTarget;
  readonly codeAnchor?: CodeAnchor;
  readonly triageScope?: "all" | "thread";
  readonly threadAnchorCommentId?: number;
  readonly needsThreadRootResolution?: boolean;
  /** App bot login for `@mention` ask parsing. */
  readonly botLogin?: string;
};

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
  readonly baseAck: Omit<AckJobData, "workItemId" | "progress" | "reply"> & {
    kind: "ack";
  };
  readonly events: DeferredIntakeEvent[];
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
  const outcome = await promoteAskFromWebhookEvent(
    ctx.boss,
    ctx.client,
    {
      webhookEventId: ctx.eventId,
      correlation: ctx.correlation,
      installationId: ctx.input.installationId,
      owner: ctx.input.owner,
      repo: ctx.input.repo,
      repositorySizeKb: ctx.input.repositorySizeKb,
      prNumber: ctx.input.prNumber,
      body: ctx.input.body,
      replyTarget: ctx.input.replyTarget,
      commentId: ctx.input.commentId,
      commenterId: ctx.input.commenterId,
      codeAnchor: ctx.input.codeAnchor,
      ackTargets: ctx.baseAck.targets,
      botLogin: ctx.input.botLogin,
    },
    "skip",
  );

  switch (outcome.kind) {
    case "hint_acked":
    case "already_exists_skipped":
      return;
    case "promoted":
      ctx.events.push({
        name: "agent_work_enqueued",
        fields: {
          type: "ask",
          source: "slash",
          workItemId: outcome.workItemId,
          ...ctx.correlation,
        },
      });
      return;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

async function handleSlashDescribe(ctx: SlashIntakeContext): Promise<void> {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const insert = await createDescriptionWorkItem(ctx.client, {
    webhookEventId: ctx.eventId,
    ref: ctx.ref,
    source: "slash",
    userSupplement: clampStoredCommentText(`User invoked /describe with:\n${ctx.input.body}`),
    commenterId: ctx.input.commenterId,
    ackTargets: ctx.baseAck.targets,
  });
  if (!insert.created) {
    await enqueueSlashAck(ctx, {
      reply: {
        target: ctx.input.replyTarget,
        body: DESCRIPTION_ALREADY_IN_PROGRESS,
      },
    });
    return;
  }
  const workItemId = insert.id;
  await enqueueSlashAck(ctx, { workItemId });
  await enqueueDescription(ctx.boss, ctx.client, ctx.ref, workItemId, ctx.correlation);
  ctx.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "description",
      source: "slash",
      workItemId,
      resourceKey,
      ...ctx.correlation,
    },
  });
}

async function handleSlashTriage(ctx: SlashIntakeContext): Promise<void> {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const isInlineReply = ctx.input.replyTarget.kind === "inlineReviewThread";
  const scope = ctx.input.triageScope ?? (isInlineReply ? undefined : ("all" as const));
  if (isInlineReply && scope == null) {
    captureTriageEvent(
      {
        installationId: ctx.input.installationId,
        owner: ctx.input.owner,
        repo: ctx.input.repo,
        prNumber: ctx.input.prNumber,
      },
      "triage rejected",
      { reason: "inline_usage_hint" },
    );
    await enqueueSlashAck(ctx, {
      reply: {
        target: ctx.input.replyTarget,
        body: TRIAGE_INLINE_USAGE_HINT,
      },
    });
    return;
  }
  const triageScope = scope ?? "all";
  const rejectActiveTriage = async (existing: {
    id: string;
    payload: { scope?: "all" | "thread" };
  }): Promise<void> => {
    const activeScope = existing.payload.scope ?? "all";
    const body =
      triageScope === "thread" && activeScope === "all"
        ? TRIAGE_FULL_RUN_IN_PROGRESS
        : TRIAGE_ALREADY_IN_PROGRESS;
    captureTriageEvent(
      {
        installationId: ctx.input.installationId,
        owner: ctx.input.owner,
        repo: ctx.input.repo,
        prNumber: ctx.input.prNumber,
        scope: triageScope,
      },
      "triage rejected",
      {
        reason:
          triageScope === "thread" && activeScope === "all"
            ? "full_run_in_progress"
            : "already_in_progress",
      },
    );
    await enqueueSlashAck(ctx, {
      reply: {
        target: ctx.input.replyTarget,
        body,
      },
    });
  };
  const insert = await createTriageWorkItem(ctx.client, {
    webhookEventId: ctx.eventId,
    ref: ctx.ref,
    commentId: ctx.input.commentId,
    commenterId: ctx.input.commenterId,
    scope: triageScope,
    threadAnchorCommentId: ctx.input.threadAnchorCommentId,
    needsThreadRootResolution: ctx.input.needsThreadRootResolution,
    replyTarget: ctx.input.replyTarget,
    ackTargets: ctx.baseAck.targets,
  });
  if (!insert.created) {
    const winner = await fetchActiveTriageWorkItem(ctx.client, resourceKey);
    if (!winner) {
      throw new AppError({
        code: "agent_work.slash_triage_conflict_no_winner",
        message: `slash triage uniqueness conflict without winner for ${resourceKey}`,
        context: { resourceKey },
      });
    }
    await rejectActiveTriage(winner);
    return;
  }
  const workItemId = insert.id;
  await enqueueSlashAck(ctx, { workItemId });
  await enqueueTriage(ctx.boss, ctx.client, ctx.ref, workItemId, ctx.correlation);
  captureTriageEvent(
    {
      installationId: ctx.input.installationId,
      owner: ctx.input.owner,
      repo: ctx.input.repo,
      prNumber: ctx.input.prNumber,
      workItemId,
      scope: triageScope,
    },
    "triage enqueued",
    {
      thread_anchor_comment_id: ctx.input.threadAnchorCommentId,
      needs_thread_root_resolution: ctx.input.needsThreadRootResolution === true,
      reply_target_kind: ctx.input.replyTarget.kind,
    },
  );
  ctx.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "triage",
      source: "slash",
      workItemId,
      resourceKey,
      ...ctx.correlation,
    },
  });
}

async function handleSlashReview(ctx: SlashIntakeContext): Promise<void> {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const alreadyInProgressBody =
    "A `/review` run is already queued or in progress for this pull request.";
  const insert = await createReviewWorkItem(ctx.client, {
    webhookEventId: ctx.eventId,
    ref: ctx.ref,
    source: "slash",
    userSupplement: clampStoredCommentText(`User invoked /review with:\n${ctx.input.body}`),
    commenterId: ctx.input.commenterId,
    ackTargets: ctx.baseAck.targets,
  });
  if (!insert.created) {
    await enqueueSlashAck(ctx, {
      reply: {
        target: ctx.input.replyTarget,
        body: alreadyInProgressBody,
      },
    });
    return;
  }
  const workItemId = insert.id;
  // Clear failed key_strict_fifo blockers only; leave any live jobs alone.
  await releaseReviewSingletonSlot(ctx.boss, resourceKey, {
    db: pgBossDb(ctx.client),
    cancelNonTerminal: false,
  });
  await enqueueSlashAck(ctx, {
    workItemId,
    progress: { lens: "review", headSha: ctx.ref.headSha, source: "slash" },
  });
  await enqueueReview(ctx.boss, ctx.client, ctx.ref, workItemId, ctx.correlation);
  ctx.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "review",
      source: "slash",
      workItemId,
      resourceKey,
      lens: "review",
      ...ctx.correlation,
    },
  });
}

async function handleSlashUnknown(ctx: SlashIntakeContext, command: string): Promise<void> {
  await enqueueSlashAck(ctx, {
    reply: {
      target: ctx.input.replyTarget,
      body: `Unknown command \`/${command}\`. Run \`/help\` for available commands.`,
    },
  });
  ctx.events.push({
    name: "ignored_unknown_slash_command",
    fields: {
      command,
    },
  });
}

type SlashIntakeHandler = (ctx: SlashIntakeContext) => Promise<void>;

const SLASH_INTAKE_HANDLERS: Record<string, SlashIntakeHandler> = {
  help: handleSlashHelp,
  ask: handleSlashAsk,
  describe: handleSlashDescribe,
  triage: handleSlashTriage,
  review: handleSlashReview,
};

export async function applySlashCommandIntake(
  boss: PgBoss,
  client: PoolClient,
  input: SlashCommandInput,
  features: Features,
): Promise<DeferredIntakeEvent[]> {
  const events: DeferredIntakeEvent[] = [];
  const command = input.command;
  const event = await insertWebhookEvent(client, input.headers, `slash_${command}`);
  if (event.duplicate) {
    events.push({
      name: "deduped_delivery",
      fields: {
        dedupeKey: event.dedupeKey,
        event: input.headers.event,
      },
    });
    return events;
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
    events,
  };

  const handler = SLASH_INTAKE_HANDLERS[command];
  if (handler) {
    const disabledByFeature: Record<string, boolean> = {
      ask: features.ask === "off",
      describe: features.describe === "off",
      triage: features.triage === "off",
    };
    if (disabledByFeature[command]) {
      await enqueueSlashAck(ctx, {
        reply: { target: input.replyTarget, body: slashDisabledBody(command) },
      });
      events.push({ name: "ignored_disabled_slash_command", fields: { command } });
      return events;
    }
    await handler(ctx);
    return events;
  }
  await handleSlashUnknown(ctx, command);
  return events;
}
