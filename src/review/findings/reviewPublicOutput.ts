import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.js";
import type { ReviewPayload } from "../reviewSchema.js";

export function redactReviewText(text: string): string {
  return redactOutboundSecrets(text);
}

export function redactReviewPayloadSecrets(payload: ReviewPayload): ReviewPayload {
  return {
    ...payload,
    prCharacter: redactReviewText(payload.prCharacter),
    securityConcerns:
      payload.securityConcerns == null ? null : redactReviewText(payload.securityConcerns),
    followUps: payload.followUps.map((item) => redactReviewText(item)),
    findings: payload.findings.map((finding) => ({
      ...finding,
      title: redactReviewText(finding.title),
      detail: redactReviewText(finding.detail),
      fixPrompt:
        finding.fixPrompt == null ? finding.fixPrompt : redactReviewText(finding.fixPrompt),
      suggestedCode:
        finding.suggestedCode == null
          ? finding.suggestedCode
          : redactReviewText(finding.suggestedCode),
    })),
  };
}
