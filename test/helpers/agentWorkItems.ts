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
} from "../../src/agentWork/types.js";

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

export function makeReviewWorkItem(overrides: ReviewOverrides = {}): ReviewWorkItem {
  const { payload, reviewLens = "review", source = "auto", ...rest } = overrides;
  return {
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
  };
}

export function makeAskWorkItem(overrides: AskOverrides = {}): AskWorkItem {
  const { payload, ...rest } = overrides;
  return {
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
  };
}

export function makeDescriptionWorkItem(overrides: DescriptionOverrides = {}): DescriptionWorkItem {
  const { payload, source = "auto", ...rest } = overrides;
  return {
    ...base,
    type: "description",
    source,
    reviewLens: null,
    payload: {
      source,
      ...payload,
    },
    ...rest,
  };
}

export function makeTriageWorkItem(overrides: TriageOverrides = {}): TriageWorkItem {
  const { payload, ...rest } = overrides;
  return {
    ...base,
    type: "triage",
    source: "slash",
    reviewLens: null,
    payload: {
      source: "slash",
      commentId: 5,
      scope: "all",
      replyTarget: { kind: "prConversation", prNumber: 1 },
      ...payload,
    },
    ...rest,
  };
}

export function makeVerificationWorkItem(
  overrides: VerificationOverrides = {},
): VerificationWorkItem {
  const { payload, ...rest } = overrides;
  return {
    ...base,
    type: "verification",
    source: "auto",
    reviewLens: null,
    payload: {
      source: "auto",
      ...payload,
    },
    ...rest,
  };
}
