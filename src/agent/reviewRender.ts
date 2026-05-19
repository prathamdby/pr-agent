import type { ReviewFinding, ReviewPayload, ReviewPublishContext, ReviewMode } from "./reviewSchema.js";
import { isInlineSeverity, selectInlineFindings } from "./reviewSchema.js";

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
export const SECURITY_REVIEW_POINTER_BODY =
	"See the security review summary in the PR conversation.";

export function reviewPointerBodyForMode(mode: ReviewMode): string {
	return mode === "review-security" ? SECURITY_REVIEW_POINTER_BODY : REVIEW_POINTER_BODY;
}

export const AGENT_FIX_PROMPT_PREAMBLE =
	"Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.";

export const AGENT_FIX_PROMPT_ACCORDION_SUMMARY = "Prompt for AI agents to fix all review findings";

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3,
};

/** GitHub review/comment body cap is 65,536; leave headroom for wrapper markup. */
export const REVIEW_POINTER_BODY_MAX_CHARS = 60_000;

const AGENT_FIX_PROMPT_TRUNCATION_SUFFIX =
	"\n...[truncated; see inline threads and PR summary]";

function formatLineRange(startLine: number, endLine: number): string {
	return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function findingIdentity(f: ReviewFinding): string {
	return `${f.severity}|${f.file}|${f.startLine}|${f.endLine}|${f.title}`;
}

function sortFindingsForAgentFixPrompt(findings: ReviewFinding[]): ReviewFinding[] {
	return [...findings].sort((a, b) => {
		const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
		if (bySeverity !== 0) return bySeverity;
		const byFile = a.file.localeCompare(b.file);
		if (byFile !== 0) return byFile;
		return a.startLine - b.startLine;
	});
}

function renderAgentFixFindingBlock(
	finding: ReviewFinding,
	opts: { inlinePosted: boolean },
): string {
	const location = `@${finding.file} ${formatLineRange(finding.startLine, finding.endLine)}`;
	const lines: string[] = [];

	if (finding.severity === "P3") {
		lines.push(`[P3 — no inline thread] ${finding.title}`);
		lines.push(finding.detail);
		return lines.join("\n");
	}

	lines.push(`[${finding.severity}] ${location}`);
	lines.push(finding.fixPrompt ?? "");
	if (!opts.inlinePosted) {
		lines.push("[inline thread omitted — severity cap]");
	}
	return lines.join("\n");
}

export function renderAgentFixPrompt(payload: ReviewPayload, ctx: RenderContext): string {
	const inlinePosted = new Set(
		selectInlineFindings(payload.findings, ctx.maxFindings).map(findingIdentity),
	);
	const sorted = sortFindingsForAgentFixPrompt(payload.findings);

	const blocks = sorted.map((f) =>
		renderAgentFixFindingBlock(f, { inlinePosted: inlinePosted.has(findingIdentity(f)) }),
	);

	return [
		AGENT_FIX_PROMPT_PREAMBLE,
		"",
		`Repository: ${ctx.owner}/${ctx.repo}`,
		`Pull request: #${ctx.prNumber}`,
		`Head SHA: ${ctx.headSha}`,
		"",
		"Findings:",
		"",
		blocks.join("\n\n"),
	].join("\n");
}

function assembleReviewPointerBody(pointerLine: string, agentFixPrompt: string): string {
	return [
		pointerLine,
		"",
		"<details>",
		`<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`,
		"",
		"```",
		agentFixPrompt,
		"```",
		"",
		"</details>",
	].join("\n");
}

function truncateAgentFixPromptForPointerBody(
	agentFixPrompt: string,
	pointerLine: string,
	maxBodyChars: number,
): {
	prompt: string;
	truncated: boolean;
} {
	const wrapperOverhead = assembleReviewPointerBody(pointerLine, "").length;
	const maxPromptChars = Math.max(0, maxBodyChars - wrapperOverhead);

	if (agentFixPrompt.length <= maxPromptChars) {
		return { prompt: agentFixPrompt, truncated: false };
	}

	const suffixBudget = AGENT_FIX_PROMPT_TRUNCATION_SUFFIX.length;
	const cutAt = Math.max(0, maxPromptChars - suffixBudget);
	return {
		prompt: agentFixPrompt.slice(0, cutAt) + AGENT_FIX_PROMPT_TRUNCATION_SUFFIX,
		truncated: true,
	};
}

export function renderReviewPointerBody(
	payload: ReviewPayload,
	ctx: RenderContext & { mode: ReviewMode },
): { body: string; truncated: boolean } {
	const pointerLine = reviewPointerBodyForMode(ctx.mode);
	let agentFixPrompt = renderAgentFixPrompt(payload, ctx);
	let truncated = false;

	let body = assembleReviewPointerBody(pointerLine, agentFixPrompt);
	if (body.length > REVIEW_POINTER_BODY_MAX_CHARS) {
		const result = truncateAgentFixPromptForPointerBody(
			agentFixPrompt,
			pointerLine,
			REVIEW_POINTER_BODY_MAX_CHARS,
		);
		agentFixPrompt = result.prompt;
		truncated = result.truncated;
		body = assembleReviewPointerBody(pointerLine, agentFixPrompt);
	}

	return { body, truncated };
}

export function renderReviewSummaryComment(
	payload: ReviewPayload,
	ctx: RenderContext & { summarySentinel: string },
): string {
	const inlineCandidates = payload.findings.filter((f) => isInlineSeverity(f.severity));
	const shown = selectInlineFindings(payload.findings, ctx.maxFindings);
	const p3 = payload.findings.filter((f) => f.severity === "P3");
	const truncated = inlineCandidates.length > shown.length;

	const rows: string[] = [];
	rows.push(ctx.summarySentinel);
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
