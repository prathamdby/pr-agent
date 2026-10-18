import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.ts";
import type { ReviewPayload } from "../reviewSchema.ts";

export function redactReviewText(text: string): string {
  return redactOutboundSecrets(text);
}

export function redactReviewPayloadSecrets(payload: ReviewPayload): ReviewPayload {
  return {
    ...payload,
    followUps: payload.followUps.map((item) => redactReviewText(item)),
    mergeability: redactReviewText(payload.mergeability),
    blastRadius: redactReviewText(payload.blastRadius),
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
