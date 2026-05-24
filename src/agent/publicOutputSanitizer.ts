import {
  PUBLIC_OUTPUT_BANNED_PATTERNS,
  PUBLIC_OUTPUT_REDACTION,
} from "../settings/index.js";
import type { ReviewPayload } from "./reviewSchema.js";

export { PUBLIC_OUTPUT_REDACTION } from "../settings/index.js";

/** Agent publish/runtime leakage — reject on overview fields before sanitize. */
const INTERNAL_FAILURE_PHRASING: RegExp[] = [
  /\bstructured publish\b/i,
  /\b\d+\/\d+ attempt\(s\)\b/i,
  /\bcheck server logs\b/i,
  /\btooling budget\b/i,
  /\bBEGIN_SHARED_METHODOLOGY\b/,
  /\bSingle-pass review contract\b/i,
];

export function containsBannedPublicOutput(text: string): boolean {
  return PUBLIC_OUTPUT_BANNED_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsInternalFailurePhrasing(text: string): boolean {
  return INTERNAL_FAILURE_PHRASING.some((pattern) => pattern.test(text));
}

export function sanitizePublicReviewText(text: string): string {
  if (!text) return text;
  return containsBannedPublicOutput(text) ? PUBLIC_OUTPUT_REDACTION : text;
}

export function sanitizePublicReviewFields(fields: {
  title?: string;
  detail?: string;
  fixPrompt?: string;
  prCharacter?: string;
  securityConcerns?: string | null;
  followUps?: readonly string[];
}): typeof fields {
  return {
    title: fields.title == null ? fields.title : sanitizePublicReviewText(fields.title),
    detail: fields.detail == null ? fields.detail : sanitizePublicReviewText(fields.detail),
    fixPrompt:
      fields.fixPrompt == null ? fields.fixPrompt : sanitizePublicReviewText(fields.fixPrompt),
    prCharacter:
      fields.prCharacter == null
        ? fields.prCharacter
        : sanitizePublicReviewText(fields.prCharacter),
    securityConcerns:
      fields.securityConcerns == null
        ? fields.securityConcerns
        : sanitizePublicReviewText(fields.securityConcerns),
    followUps: fields.followUps?.map((item) => sanitizePublicReviewText(item)),
  };
}

export function sanitizeReviewPayload(payload: ReviewPayload): ReviewPayload {
  const overview = sanitizePublicReviewFields({
    prCharacter: payload.prCharacter,
    securityConcerns: payload.securityConcerns,
    followUps: payload.followUps,
  });
  return {
    ...payload,
    ...overview,
    findings: payload.findings.map((finding) => ({
      ...finding,
      ...sanitizePublicReviewFields({
        title: finding.title,
        detail: finding.detail,
        fixPrompt: finding.fixPrompt,
      }),
    })),
  };
}
