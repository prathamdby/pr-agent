import { redactOutboundSecrets } from "../security/redactOutboundSecrets.js";
import type { ReviewPayload } from "./reviewSchema.js";

export function redactReviewText(text: string): string {
  return redactOutboundSecrets(text);
}

export function redactReviewFindingFields(fields: {
  title?: string;
  detail?: string;
  fixPrompt?: string;
}): {
  title?: string;
  detail?: string;
  fixPrompt?: string;
} {
  return {
    title: fields.title == null ? fields.title : redactReviewText(fields.title),
    detail: fields.detail == null ? fields.detail : redactReviewText(fields.detail),
    fixPrompt: fields.fixPrompt == null ? fields.fixPrompt : redactReviewText(fields.fixPrompt),
  };
}

export function redactReviewOverviewFields(fields: {
  prCharacter?: string;
  securityConcerns?: string | null;
  followUps?: readonly string[];
}): {
  prCharacter?: string;
  securityConcerns?: string | null;
  followUps?: string[];
} {
  return {
    prCharacter:
      fields.prCharacter == null ? fields.prCharacter : redactReviewText(fields.prCharacter),
    securityConcerns:
      fields.securityConcerns == null
        ? fields.securityConcerns
        : redactReviewText(fields.securityConcerns),
    followUps: fields.followUps?.map((item) => redactReviewText(item)),
  };
}

export function redactReviewPayloadSecrets(payload: ReviewPayload): ReviewPayload {
  const overview = redactReviewOverviewFields({
    prCharacter: payload.prCharacter,
    securityConcerns: payload.securityConcerns,
    followUps: payload.followUps,
  });
  return {
    ...payload,
    ...overview,
    findings: payload.findings.map((finding) => ({
      ...finding,
      ...redactReviewFindingFields({
        title: finding.title,
        detail: finding.detail,
        fixPrompt: finding.fixPrompt,
      }),
    })),
  };
}
