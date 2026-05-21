const PUBLIC_OUTPUT_BANNED_PATTERNS: RegExp[] = [
  /\bsystem prompt\b/i,
  /\btooling budget\b/i,
  /\bserver logs\b/i,
  /Line could not be resolved/i,
  /\bsubmitReview\b/i,
  /\bstructured publish\b/i,
  /\bmanual review\b/i,
  /\bGitHub API\b/i,
  /\bDATABASE_URL\b/,
  /\bOPENAI_API_KEY\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d+\/\d+ attempt\(s\)\b/i,
  /\bBEGIN_SHARED_METHODOLOGY\b/,
  /\bSingle-pass review contract\b/i,
];

export const PUBLIC_OUTPUT_REDACTION = "[redacted internal details]";

export function containsBannedPublicOutput(text: string): boolean {
  return PUBLIC_OUTPUT_BANNED_PATTERNS.some((pattern) => pattern.test(text));
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
