import type { ReviewFinding, ReviewPayload, ReviewPublishContext } from "./reviewSchema.js";
import { REVIEW_SUMMARY_SENTINEL, isInlineSeverity, selectInlineFindings } from "./reviewSchema.js";

export type RenderContext = ReviewPublishContext & {
	maxFindings: number;
};

function escapeTableCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function blobLineUrl(ctx: RenderContext, file: string, startLine: number, endLine: number): string {
	const lineAnchor = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
	return `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.headSha}/${file}#${lineAnchor}`;
}

function effortBar(n: number): string {
	const filled = "🔵".repeat(n);
	const empty = "⚪".repeat(5 - n);
	return filled + empty;
}

function severityBadge(severity: ReviewFinding["severity"]): string {
	return `**${severity}**`;
}

export function renderInlineThreadBody(finding: ReviewFinding): string {
	const lines = [
		`[${finding.severity}] ${finding.title}`,
		"",
		finding.detail,
		"",
		"<details>",
		"<summary>Prompt to fix</summary>",
		"",
		"```",
		finding.fixPrompt ?? "",
		"```",
		"",
		"</details>",
	];
	return lines.join("\n");
}

export const REVIEW_POINTER_BODY = "See the structured review summary in the PR conversation.";

export function renderReviewSummaryComment(payload: ReviewPayload, ctx: RenderContext): string {
	const inlineCandidates = payload.findings.filter((f) => isInlineSeverity(f.severity));
	const shown = selectInlineFindings(payload.findings, ctx.maxFindings);
	const p3 = payload.findings.filter((f) => f.severity === "P3");
	const truncated = inlineCandidates.length > shown.length;

	const rows: string[] = [];
	rows.push(REVIEW_SUMMARY_SENTINEL);
	rows.push("");
	rows.push(escapeTableCell(payload.prCharacter.trim()));
	rows.push("");
	rows.push("| | |");
	rows.push("| --- | --- |");

	if (shown.length === 0) {
		rows.push("| Focus | No P0–P2 findings |");
	} else {
		for (const f of shown) {
			const link = blobLineUrl(ctx, f.file, f.startLine, f.endLine);
			rows.push(`| ${severityBadge(f.severity)} | [${f.title}](${link}) |`);
		}
		if (truncated) {
			rows.push(
				`| | Showing ${shown.length} of ${inlineCandidates.length} P0–P2 findings (truncated; lowest severity dropped first). |`,
			);
		}
	}

	if (p3.length > 0) {
		rows.push("| P3 | |");
		for (const f of p3) {
			const link = blobLineUrl(ctx, f.file, f.startLine, f.endLine);
			rows.push(`| | [${f.title}](${link}) |`);
		}
	}

	rows.push(`| Effort | ${effortBar(payload.estimatedEffort)} (${payload.estimatedEffort}/5) |`);
	rows.push(`| Relevant tests | ${payload.relevantTests} |`);
	rows.push(
		`| Security | ${payload.securityConcerns != null ? escapeTableCell(payload.securityConcerns) : "No security concerns identified"} |`,
	);

	if (payload.followUps.length > 0) {
		rows.push("| Follow-ups | |");
		for (const item of payload.followUps) {
			rows.push(`| | ${escapeTableCell(item)} |`);
		}
	}

	return rows.join("\n");
}
