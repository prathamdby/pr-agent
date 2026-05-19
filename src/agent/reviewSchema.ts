import { z } from "zod";

export const REVIEW_SUMMARY_SENTINEL = "## PR Agent Review";
export const SECURITY_REVIEW_SUMMARY_SENTINEL = "## PR Agent Security Review";

export type ReviewMode = "review" | "review-security";

export function reviewSummarySentinelForMode(mode: ReviewMode): string {
	return mode === "review-security" ? SECURITY_REVIEW_SUMMARY_SENTINEL : REVIEW_SUMMARY_SENTINEL;
}

const severitySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const reviewFindingSchema = z
	.object({
		severity: severitySchema,
		file: z.string().min(1),
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
		title: z.string().min(1),
		detail: z.string().min(1),
		fixPrompt: z.string().optional(),
	})
	.superRefine((f, ctx) => {
		if (f.startLine > f.endLine) {
			ctx.addIssue({
				code: "custom",
				message: "startLine must be <= endLine",
				path: ["endLine"],
			});
		}
		if (f.severity !== "P3" && (!f.fixPrompt || f.fixPrompt.trim().length === 0)) {
			ctx.addIssue({
				code: "custom",
				message: "fixPrompt is required for P0/P1/P2 findings",
				path: ["fixPrompt"],
			});
		}
	});

export const reviewPayloadSchema = z.object({
	prCharacter: z.string().min(1),
	findings: z.array(reviewFindingSchema).max(12),
	estimatedEffort: z.number().int().min(1).max(5),
	relevantTests: z.enum(["yes", "no", "partial"]),
	securityConcerns: z.string().nullable(),
	followUps: z.array(z.string()).max(5),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

export type ReviewPublishContext = {
	owner: string;
	repo: string;
	prNumber: number;
	headSha: string;
};

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3,
};

export function isInlineSeverity(severity: ReviewFinding["severity"]): boolean {
	return severity === "P0" || severity === "P1" || severity === "P2";
}

export function selectInlineFindings(findings: ReviewFinding[], maxFindings: number): ReviewFinding[] {
	const inline = findings.filter((f) => isInlineSeverity(f.severity));
	inline.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
	return inline.slice(0, maxFindings);
}

export function reviewEventForFindings(findings: ReviewFinding[]): "REQUEST_CHANGES" | "COMMENT" {
	return findings.some((f) => f.severity === "P0" || f.severity === "P1") ? "REQUEST_CHANGES" : "COMMENT";
}

export function normalizeReviewPayload(raw: ReviewPayload): ReviewPayload {
	const security =
		raw.securityConcerns == null || raw.securityConcerns.trim().length === 0
			? null
			: raw.securityConcerns.trim();
	return { ...raw, securityConcerns: security };
}
