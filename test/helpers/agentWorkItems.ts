import type {
  AskWorkItem,
  AskWorkPayload,
  DescriptionWorkItem,
  DescriptionWorkPayload,
  ReviewWorkItem,
  ReviewWorkPayload,
  TriageWorkItem,
  TriageWorkPayload,
  VerificationWorkItem,
  VerificationWorkPayload,
} from "../../src/agentWork/types.ts";

type ReviewOverrides = Omit<
  Partial<ReviewWorkItem>,
  "type" | "payload" | "reviewLens" | "source"
> & {
  reviewLens?: ReviewWorkItem["reviewLens"];
  source?: ReviewWorkItem["source"];
  payload?: Partial<ReviewWorkPayload>;
};

type AskOverrides = Omit<Partial<AskWorkItem>, "type" | "payload" | "reviewLens" | "source"> & {
  payload?: Partial<AskWorkPayload>;
};

type DescriptionOverrides = Omit<
  Partial<DescriptionWorkItem>,
  "type" | "payload" | "reviewLens" | "source"
> & {
  source?: DescriptionWorkItem["source"];
  payload?: Partial<DescriptionWorkPayload>;
};

type TriageOverrides = Omit<
  Partial<TriageWorkItem>,
  "type" | "payload" | "reviewLens" | "source"
> & {
  payload?: Partial<TriageWorkPayload>;
};

type VerificationOverrides = Omit<
  Partial<VerificationWorkItem>,
  "type" | "payload" | "reviewLens" | "source"
> & {
  source?: VerificationWorkItem["source"];
  payload?: Partial<VerificationWorkPayload>;
};

const base = {
  id: "wi-1",
  webhookEventId: "ev-1" as string | null,
  status: "running" as const,
  owner: "o",
  repo: "r",
  prNumber: 1,
  installationId: 42,
  headSha: "deadbeef",
  resourceKey: "o/r#1",
  attemptCount: 0,
  cancelRequestedAt: null as Date | null,
};

export function makeReviewWorkItem(overrides: ReviewOverrides = {}) {
  const { payload, reviewLens = "review", source = "auto", ...rest } = overrides;
  return ((pinnedReturn: ReviewWorkItem) => pinnedReturn)({
    ...base,
    type: "review",
    source,
    reviewLens,
    payload: {
      mode: reviewLens,
      source,
      ...payload,
    },
    ...rest,
  });
}

export function makeAskWorkItem(overrides: AskOverrides = {}) {
  const { payload, ...rest } = overrides;
  return ((pinnedReturn: AskWorkItem) => pinnedReturn)({
    ...base,
    type: "ask",
    source: "slash",
    reviewLens: null,
    payload: {
      question: "what changed?",
      replyTarget: { kind: "prConversation", prNumber: 1 },
      commentId: 99,
      ...payload,
    },
    ...rest,
  });
}

export function makeDescriptionWorkItem(overrides: DescriptionOverrides = {}) {
  const { payload, source = "auto", ...rest } = overrides;
  return ((pinnedReturn: DescriptionWorkItem) => pinnedReturn)({
    ...base,
    type: "description",
    source,
    reviewLens: null,
    payload: {
      source,
      ...payload,
    },
    ...rest,
  });
}

export function makeTriageWorkItem(overrides: TriageOverrides = {}) {
  const { payload, ...rest } = overrides;
  return ((pinnedReturn: TriageWorkItem) => pinnedReturn)({
    ...base,
    type: "triage",
    source: "slash",
    reviewLens: null,
    payload: {
      source: "slash",
      commentId: 5,
      scope: "all",
      mode: "apply",
      replyTarget: { kind: "prConversation", prNumber: 1 },
      ...payload,
    },
    ...rest,
  });
}

export function makeVerificationWorkItem(overrides: VerificationOverrides = {}) {
  const { payload, source = "auto", ...rest } = overrides;
  return ((pinnedReturn: VerificationWorkItem) => pinnedReturn)({
    ...base,
    type: "verification",
    source,
    reviewLens: null,
    payload: {
      source,
      ...payload,
    },
    ...rest,
  });
}
