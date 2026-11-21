import * as v from "valibot";
import { AppError } from "../errors/appError.ts";
import { LEGACY_REVIEW_LENSES, normalizeReviewLens } from "../settings/index.ts";
import { isRecord, nonEmptyString } from "../util/typeGuards.ts";
import type {
  AgentWorkItem,
  AgentWorkItemCore,
  AskWorkPayload,
  DescriptionWorkPayload,
  ReviewWorkPayload,
  StaleHeadReplacement,
  StaleHeadReplacementState,
  TriageWorkPayload,
  VerificationWorkPayload,
  WorkType,
} from "./types.ts";

export const STALE_HEAD_REPLACEMENT_ID_SQL = `COALESCE(
          payload->'staleHeadReplacement'->>'replacementWorkItemId',
          NULLIF(payload->>'staleHeadReplacementWorkItemId', '')
        )`;

function asReplacementState(value: unknown) {
  return ((pinnedReturn: StaleHeadReplacementState | undefined) => pinnedReturn)(
    value === "pending-enqueue" || value === "enqueued" ? value : undefined,
  );
}

export function normalizeStaleHeadReplacement(raw: {
  readonly staleHeadRescheduled?: unknown;
  readonly staleHeadReplacement?: unknown;
  readonly staleHeadReplacementWorkItemId?: unknown;
  readonly staleHeadReplacementEnqueued?: unknown;
}) {
  const nested = isRecord(raw.staleHeadReplacement) ? raw.staleHeadReplacement : undefined;
  const nestedId = nonEmptyString(nested?.replacementWorkItemId);
  const legacyId = nonEmptyString(raw.staleHeadReplacementWorkItemId);
  const replacementWorkItemId =
    nestedId ?? (raw.staleHeadRescheduled === true ? undefined : legacyId);
  if (!replacementWorkItemId)
    return ((pinnedReturn: StaleHeadReplacement | undefined) => pinnedReturn)(undefined);
  const state =
    asReplacementState(nested?.state) ??
    (raw.staleHeadReplacementEnqueued === true ? "enqueued" : "pending-enqueue");
  return ((pinnedReturn: StaleHeadReplacement | undefined) => pinnedReturn)({
    replacementWorkItemId,
    state,
  });
}

const ReviewModeSchema = v.pipe(
  v.picklist(["review", ...LEGACY_REVIEW_LENSES]),
  v.transform(normalizeReviewLens),
);
const WorkSourceSchema = v.picklist(["auto", "slash"]);

const positiveInt = () => v.pipe(v.number(), v.integer(), v.gtValue(0));

const ReplyTargetSchema = v.variant("kind", [
  v.looseObject({
    kind: v.literal("prConversation"),
    prNumber: positiveInt(),
  }),
  v.looseObject({
    kind: v.literal("inlineReviewThread"),
    prNumber: positiveInt(),
    inReplyToCommentId: positiveInt(),
  }),
]);

const CodeAnchorSchema = v.looseObject({
  path: v.pipe(v.string(), v.minLength(1)),
  line: positiveInt(),
  startLine: v.optional(positiveInt()),
  side: v.optional(v.picklist(["LEFT", "RIGHT"])),
  diffHunk: v.optional(v.string()),
});

const AckTargetSchema = v.variant("kind", [
  v.looseObject({
    kind: v.literal("pr"),
    prNumber: positiveInt(),
  }),
  v.looseObject({
    kind: v.literal("issueComment"),
    commentId: positiveInt(),
  }),
  v.looseObject({
    kind: v.literal("reviewComment"),
    commentId: positiveInt(),
  }),
]);

const ReviewWorkPayloadFieldsSchema = v.looseObject({
  mode: ReviewModeSchema,
  source: WorkSourceSchema,
  webhookReceivedAt: v.optional(v.number()),
  repositorySizeKb: v.optional(v.number()),
  userSupplement: v.optional(v.string()),
  commenterId: v.optional(v.pipe(v.number(), v.integer())),
  ackTargets: v.optional(v.array(AckTargetSchema)),
  publishDegraded: v.optional(v.boolean()),
  staleHeadRescheduled: v.optional(v.boolean()),
  staleHeadReplacement: v.optional(v.unknown()),
  staleHeadReplacementWorkItemId: v.optional(v.unknown()),
  staleHeadReplacementEnqueued: v.optional(v.unknown()),
  pushFollowUp: v.optional(
    v.object({
      webhookEventId: v.pipe(v.string(), v.minLength(1)),
      replacementWorkItemId: v.optional(v.pipe(v.string(), v.minLength(1))),
      state: v.optional(v.picklist(["pending-enqueue", "enqueued"])),
    }),
  ),
  cancelAttribution: v.optional(
    v.variant("kind", [
      v.object({ kind: v.literal("user"), login: v.pipe(v.string(), v.minLength(1)) }),
      v.object({ kind: v.literal("merged") }),
      v.object({ kind: v.literal("closed") }),
    ]),
  ),
});

const ReviewWorkPayloadSchema = v.pipe(
  ReviewWorkPayloadFieldsSchema,
  v.transform((input) => {
    const {
      staleHeadReplacement: _nested,
      staleHeadReplacementWorkItemId: _legacyId,
      staleHeadReplacementEnqueued: _legacyEnqueued,
      ...rest
    } = input;
    const staleHeadReplacement = normalizeStaleHeadReplacement(input);
    return staleHeadReplacement === undefined ? rest : { ...rest, staleHeadReplacement };
  }),
);

const AskWorkPayloadSchema = v.looseObject({
  question: v.string(),
  replyTarget: ReplyTargetSchema,
  repositorySizeKb: v.optional(v.number()),
  codeAnchor: v.optional(CodeAnchorSchema),
  commenterId: v.optional(v.pipe(v.number(), v.integer())),
  commentId: positiveInt(),
  ackTargets: v.optional(v.array(AckTargetSchema)),
});

const DescriptionWorkPayloadSchema = v.looseObject({
  source: WorkSourceSchema,
  repositorySizeKb: v.optional(v.number()),
  userSupplement: v.optional(v.string()),
  commenterId: v.optional(v.pipe(v.number(), v.integer())),
  ackTargets: v.optional(v.array(AckTargetSchema)),
});

const TriageWorkPayloadFieldsSchema = v.looseObject({
  source: v.literal("slash"),
  repositorySizeKb: v.optional(v.number()),
  commenterId: v.optional(v.pipe(v.number(), v.integer())),
  commentId: positiveInt(),
  scope: v.picklist(["all", "thread"]),
  mode: v.optional(v.picklist(["apply", "preview", "bulk"])),
  excludeThreadRootCommentIds: v.optional(v.array(positiveInt())),
  threadAnchorCommentId: v.optional(positiveInt()),
  needsThreadRootResolution: v.optional(v.boolean()),
  replyTarget: ReplyTargetSchema,
  publishDegraded: v.optional(v.boolean()),
  ackTargets: v.optional(v.array(AckTargetSchema)),
  cancelAttribution: v.optional(
    v.variant("kind", [
      v.object({ kind: v.literal("user"), login: v.pipe(v.string(), v.minLength(1)) }),
      v.object({ kind: v.literal("merged") }),
      v.object({ kind: v.literal("closed") }),
    ]),
  ),
});

const TriageWorkPayloadSchema = v.pipe(
  TriageWorkPayloadFieldsSchema,
  v.transform((input) => ({
    ...input,
    mode: input.mode ?? "apply",
  })),
);

const VerificationWorkPayloadSchema = v.looseObject({
  source: WorkSourceSchema,
  repositorySizeKb: v.optional(v.number()),
  pushBeforeSha: v.optional(v.pipe(v.string(), v.minLength(1))),
  ackTargets: v.optional(v.array(AckTargetSchema)),
  publishDegraded: v.optional(v.boolean()),
});

export class WorkItemPayloadValidationError extends AppError {
  readonly workType: WorkType;

  constructor(workType: WorkType, message: string) {
    super({
      domain: "agent_work",
      kind: "invalid_payload",
      message,
      context: { workType },
    });
    this.name = "WorkItemPayloadValidationError";
    this.workType = workType;
  }
}

function parseWithSchema<T>(workType: WorkType, schema: v.GenericSchema<unknown, T>, raw: unknown) {
  const result = v.safeParse(schema, raw);
  if (!result.success) {
    const issue = result.issues[0];
    const detail = !issue
      ? "invalid payload"
      : `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`;
    throw new WorkItemPayloadValidationError(
      workType,
      `Invalid ${workType} work item payload: ${detail}`,
    );
  }
  return ((pinnedReturn: T) => pinnedReturn)(result.output);
}

export function parseWorkItemPayload(type: "review", raw: unknown): ReviewWorkPayload;
export function parseWorkItemPayload(type: "ask", raw: unknown): AskWorkPayload;
export function parseWorkItemPayload(type: "description", raw: unknown): DescriptionWorkPayload;
export function parseWorkItemPayload(type: "triage", raw: unknown): TriageWorkPayload;
export function parseWorkItemPayload(type: "verification", raw: unknown): VerificationWorkPayload;
export function parseWorkItemPayload(
  type: WorkType,
  raw: unknown,
):
  | ReviewWorkPayload
  | AskWorkPayload
  | DescriptionWorkPayload
  | TriageWorkPayload
  | VerificationWorkPayload;
export function parseWorkItemPayload(type: WorkType, raw: unknown) {
  switch (type) {
    case "review":
      return ((
        pinnedReturn:
          | ReviewWorkPayload
          | AskWorkPayload
          | DescriptionWorkPayload
          | TriageWorkPayload
          | VerificationWorkPayload,
      ) => pinnedReturn)(parseWithSchema(type, ReviewWorkPayloadSchema, raw));
    case "ask":
      return ((
        pinnedReturn:
          | ReviewWorkPayload
          | AskWorkPayload
          | DescriptionWorkPayload
          | TriageWorkPayload
          | VerificationWorkPayload,
      ) => pinnedReturn)(parseWithSchema(type, AskWorkPayloadSchema, raw));
    case "description":
      return ((
        pinnedReturn:
          | ReviewWorkPayload
          | AskWorkPayload
          | DescriptionWorkPayload
          | TriageWorkPayload
          | VerificationWorkPayload,
      ) => pinnedReturn)(parseWithSchema(type, DescriptionWorkPayloadSchema, raw));
    case "triage":
      return ((
        pinnedReturn:
          | ReviewWorkPayload
          | AskWorkPayload
          | DescriptionWorkPayload
          | TriageWorkPayload
          | VerificationWorkPayload,
      ) => pinnedReturn)(parseWithSchema(type, TriageWorkPayloadSchema, raw));
    case "verification":
      return ((
        pinnedReturn:
          | ReviewWorkPayload
          | AskWorkPayload
          | DescriptionWorkPayload
          | TriageWorkPayload
          | VerificationWorkPayload,
      ) => pinnedReturn)(parseWithSchema(type, VerificationWorkPayloadSchema, raw));
    default: {
      const exhaustive: never = type;
      throw new WorkItemPayloadValidationError(
        "review",
        `Unknown work item type: ${String(exhaustive)}`,
      );
    }
  }
}

export function attachWorkItemPayload<T extends WorkType>(
  core: Extract<AgentWorkItemCore, { type: T }>,
  raw: unknown,
): Extract<AgentWorkItem, { type: T }>;
export function attachWorkItemPayload(core: AgentWorkItemCore, raw: unknown): AgentWorkItem;
export function attachWorkItemPayload(core: AgentWorkItemCore, raw: unknown) {
  switch (core.type) {
    case "review":
      return ((pinnedReturn: AgentWorkItem) => pinnedReturn)({
        ...core,
        payload: parseWorkItemPayload("review", raw),
      });
    case "ask":
      return ((pinnedReturn: AgentWorkItem) => pinnedReturn)({
        ...core,
        payload: parseWorkItemPayload("ask", raw),
      });
    case "description":
      return ((pinnedReturn: AgentWorkItem) => pinnedReturn)({
        ...core,
        payload: parseWorkItemPayload("description", raw),
      });
    case "triage":
      return ((pinnedReturn: AgentWorkItem) => pinnedReturn)({
        ...core,
        payload: parseWorkItemPayload("triage", raw),
      });
    case "verification":
      return ((pinnedReturn: AgentWorkItem) => pinnedReturn)({
        ...core,
        payload: parseWorkItemPayload("verification", raw),
      });
    default: {
      const exhaustive: never = core;
      throw new WorkItemPayloadValidationError(
        "review",
        `Unknown work item core: ${String(exhaustive)}`,
      );
    }
  }
}
