import { complete, getModel } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Message, Tool as PiTool, ToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { buildContext7Tools } from "./context7Tools.js";
import { buildGithubTools } from "./githubTools.js";
import { createIssueComment } from "../github/reviewPublish.js";
import { automatedSecuritySystemPrompt, githubToolingDiscipline } from "./securityPrompt.js";
import { buildSubmitReviewTool, filterReviewAgentExecutors, filterReviewAgentTools } from "./submitReviewTool.js";
import type { ReviewMode } from "./reviewSchema.js";
import {
	bumpRateLimitConsecutiveFailures,
	classifyGithubToolError,
	formatToolErrorMessage,
	isInstallationTokenNearExpiry,
	logGithubToolRequestError,
} from "../github/githubRequestError.js";

const RATE_LIMIT_CIRCUIT_THRESHOLD = 3;
const CIRCUIT_OPEN_USER_MESSAGE =
	"Stop GitHub tool calls; call submitReview now with your current analysis from the conversation above.";
const CIRCUIT_OPEN_TOOL_RESULT =
	"Rate-limit circuit open: further GitHub investigation tools are blocked for this review run. Call submitReview now.";

const PUBLISH_FALLBACK_SENTINEL = "## PR Agent Review — could not publish structured output";
const SECURITY_PUBLISH_FALLBACK_SENTINEL =
	"## PR Agent Security Review — could not publish structured output";

const PROSE_ONLY_NUDGE =
	"You replied with text only. Call submitReview now with a complete ReviewPayload (required).";

export type ReviewRunResult = {
	lastAssistant: AssistantMessage;
	published: boolean;
	publishAttempts: number;
};

const PUBLISH_RECOVERY_ROUNDS = 4;

const PUBLISH_RECOVERY_PROMPTS = [
	"You ended with a text reply but never called submitReview. Call submitReview exactly once now with a complete ReviewPayload based on your analysis above. Do not continue investigating unless required to fix payload validation.",
	"The structured review was still not published. You must call submitReview now with a valid ReviewPayload. No prose-only replies.",
	"Final publish attempt: call submitReview immediately with your ReviewPayload. This is required to complete the review.",
] as const;

function collectToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((p): p is ToolCall => p.type === "toolCall");
}

function assistantReplySummary(message: AssistantMessage): string {
	const parts = message.content
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text);
	return parts.join("\n").trim();
}

function endsWithToolResults(messages: Message[]): boolean {
	return messages[messages.length - 1]?.role === "toolResult";
}

function formatPublishFallbackComment(
	mode: ReviewMode,
	summary: string,
	attempts: number,
	maxAttempts: number,
): string {
	const retryCmd = mode === "review-security" ? "/review-security" : "/review";
	const sentinel =
		mode === "review-security" ? SECURITY_PUBLISH_FALLBACK_SENTINEL : PUBLISH_FALLBACK_SENTINEL;
	return [
		sentinel,
		"",
		`_Structured publish failed after ${attempts}/${maxAttempts} attempt(s). Re-run \`${retryCmd}\` or check server logs._`,
		"",
		summary,
	].join("\n");
}

type ToolLoopMode = {
	toolChoice: "first-round" | "every-round" | "optional";
	nudgeOnProseOnly?: boolean;
};

/** Review bot system prompt — methodology + structured submitReview contract. */
function buildAutomatedSystemPrompt(): string {
	return [
		"You are a senior staff software engineer and expert code reviewer.",
		"Your task is to review pull request code changes via available GitHub API tools—identifying high-confidence, actionable bugs—not speculative or stylistic feedback.",
		"",
		"## Getting started (GitHub tooling)",
		"1. Understand context: inspect the PR body, linked issues/tickets via tools where possible, head SHA, and file list touched by this PR.",
		"2. Obtain the change set: call `listPullRequestFiles` and inspect patches; work through everything that changed—leave no touched file unscanned.",
		"3. Do not speculate: verify suspicion with reads against the codebase or API responses reachable through tools.",
		"",
		githubToolingDiscipline,
		"",
		"<!-- BEGIN_SHARED_METHODOLOGY -->",
		"",
		"## Review focus",
		"- Functional correctness, syntax errors, logic bugs",
		"- Broken dependencies, contracts, or tests",
		"- Security issues and performance problems",
		"",
		"## Bug patterns",
		"Only flag issues you are confident about—avoid speculative or stylistic nitpicks.",
		"High-signal patterns to actively check (only comment when evidenced in the change set):",
		"- Null/undefined safety: dereferences on optional values, unchecked JSON payloads, unchecked .find()/array[0]/.get(), etc.",
		"- Resource leaks: unclosed files/streams; missing cleanup on error paths",
		"- Injection vulnerabilities: SQL, XSS, command/template injection; auth invariant violations",
		"- OAuth/CSRF invariants when relevant: unpredictable per-flow state, validation gaps",
		"- Concurrency hazards: TOCTOU, lost updates, unsafe shared lifecycle",
		"- Missing error handling for critical ops: network, persistence, auth, migrations, external APIs",
		"- Wrong-variable/shadowing, type-assumption bugs, offset/pagination/async pitfalls (including async forEach/map without await)",
		"",
		"## Systematic analysis patterns",
		"### Logic & variable usage",
		"- Correct variable in conditionals; AND vs OR in permission gates; return values intentional",
		"",
		"### Null/undefined safety",
		"- Property chains a.b.c: intermediates guarded; unwrap optionals safely",
		"",
		"### Type compatibility & data flow",
		"- Types into math/compares consistent; serializers vs validators aligned",
		"",
		"### Async/await (JavaScript/TypeScript)",
		"- forEach/map/filter with async callbacks; missing await; rejection handling when results matter",
		"",
		"### Security",
		"- SSRF/XSS/session & CSRF pitfalls; insecure origin checks; timing-unsafe compares; asymmetric security caching where relevant",
		"",
		"### Concurrency when applicable",
		"- Shared mutation, broken locking assumptions, non-atomic RMW races",
		"",
		"### API contract & breaking changes",
		"- Serializers/validators/schemas/signature churn and caller compatibility",
		"",
		"## Analysis discipline before flagging",
		"1. Verify with tooling against the codebase—do not guess",
		"2. Trace data flow to prove a reachable trigger path",
		"3. Check if the pattern appears elsewhere (may be deliberate)",
		"4. Align test assumptions vs production behaviour when citing tests",
		"5. When a finding hinges on third-party library behaviour, call resolveLibraryId then getLibraryDocs to verify the claim. Do not pre-warm.",
		"",
		"## Reporting gate",
		"### Report if at least one is true",
		"- Definite runtime failure (TypeError, KeyError, ImportError…)",
		"- Incorrect logic with clear trigger path and observable wrong behaviour",
		"- Exploitable vulnerability with plausible path",
		"- Data corruption/loss risks",
		"- Breaking contract/schema/API observable in changed code/tests/docs",
		"",
		"### Do NOT report",
		"- Cosmetic-only issues absent impact",
		"- Hypothetical defensiveness without a realistic trigger path",
		"- Style/formatting unless inseparable from a bug gate above",
		"- Suggested improvements, refactors, style upgrades, or opinions — you report problems, not prescriptions",
		"",
		"### Confidence calibration",
		"- **[P0]**: virtually certain crash or exploit",
		"- **[P1]**: high-confidence correctness/security",
		"- **[P2]**: plausible bug but trigger path incompletely anchored",
		"- **[P3]**: minor / low-confidence — title + link only in the conversation overview",
		"Prefer definite bugs over maybes.",
		"For clear bugs and security issues, be thorough. For lower-severity concerns, be certain before flagging.",
		"Do not flag intentional design choices or stylistic preferences unless they introduce a clear defect.",
		"When confidence is limited but potential impact is high (e.g., data loss, security), report with an explicit note on what remains uncertain — otherwise prefer not reporting over guessing.",
		"",
		"<!-- END_SHARED_METHODOLOGY -->",
		"",
		"## Review workflow",
		"Triage clusters logically; inspect the full diff with GitHub tools before submitting.",
		"",
		"## Structured delivery (submitReview)",
		"After investigation, call **submitReview exactly once** with a valid ReviewPayload, then stop.",
		"Never call createPullRequestReview or addPullRequestComment — the server renders and publishes both surfaces.",
		"Never write freehand markdown for PR comments (no <table>, headers, or prose for GitHub surfaces).",
		"",
		"ReviewPayload fields:",
		"- prCharacter: one paragraph describing what this PR does",
		"- findings: up to 8 items; each has severity (P0|P1|P2|P3), file, startLine, endLine, title (imperative, <=80 chars), detail (why + trigger path)",
		"- fixPrompt: required non-empty for P0/P1/P2 — a self-contained instruction for a coding AI agent (Claude Code / Cursor): name file + line range, state the bug in one sentence, fix direction in one or two sentences, mention tests/invariants; under ~60 words; do not paste buggy code back",
		"- estimatedEffort: integer 1–5",
		"- relevantTests: yes | no | partial",
		"- securityConcerns: string or null (null if none)",
		"- followUps: up to 5 non-blocking observations only (e.g. missing tests) — not refactor suggestions",
		"",
		"P0/P1/P2 appear as inline review threads on changed lines; P3 appears only as title + deep-link in the conversation overview.",
		"Do not leak secrets/tokens; say exactly what tooling blocked if access is insufficient.",
	].join("\n");
}

export async function runFullPrReview(params: {
	cfg: Config;
	token: string;
	tokenExpiresAtTs: number;
	owner: string;
	repo: string;
	prNumber: number;
	headSha: string;
	mode?: ReviewMode;
	userSupplement?: string;
}): Promise<ReviewRunResult> {
	const { cfg, token, tokenExpiresAtTs, owner, repo, prNumber, headSha, userSupplement } = params;
	const reviewMode = params.mode ?? "review";

	const gh = buildGithubTools(token, {
		maxPrFilesListed: cfg.maxPrFilesListed,
		maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
	});
	const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });
	const submitState = { published: false, inlinePublished: false, lastValidationError: null };
	const publishCtx = { owner, repo, prNumber, headSha };
	const { piTool: submitTool, executor: submitExecutor } = buildSubmitReviewTool({
		cfg,
		token,
		ctx: publishCtx,
		mode: reviewMode,
		state: submitState,
	});

	const piTools: PiTool[] = [
		...filterReviewAgentTools(gh.piTools),
		...ctx7.piTools,
		submitTool,
	];
	const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
		...filterReviewAgentExecutors(gh.executors),
		...ctx7.executors,
		submitReview: submitExecutor,
	};

	const model = getModel(cfg.piProvider, cfg.piModel as never);

	const userContent = [
		`Target repository: ${owner}/${repo}`,
		`Pull request #: ${prNumber}`,
		`Head commit SHA: ${headSha}`,
		userSupplement ? `\nAdditional instruction:\n${userSupplement}\n` : "",
		"",
		reviewMode === "review-security"
			? "Perform a deep security review of the PR diff using investigation tools, then call submitReview exactly once with a complete ReviewPayload."
			: "Perform a full review using investigation tools, then call submitReview exactly once with a complete ReviewPayload.",
	].join("\n");

	const context: Context = {
		systemPrompt:
			reviewMode === "review-security" ? automatedSecuritySystemPrompt : buildAutomatedSystemPrompt(),
		messages: [
			{
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			},
		],
		tools: piTools,
	};

	let lastAssistant: AssistantMessage | null = null;
	let stopLoop = false;
	let publishAttempts = 0;
	let rateLimitConsecutiveFailures = 0;
	let rateLimitCircuitOpen = false;
	let circuitUserMessageSent = false;

	const logCtx = {
		expiresAtTs: tokenExpiresAtTs,
		owner,
		repo,
		prNumber,
		mode: reviewMode,
	};

	const githubExecutorNames = new Set(Object.keys(gh.executors));

	async function appendToolResults(toolCalls: ToolCall[]) {
		for (const call of toolCalls) {
			let text: string;
			let isError = false;

			if (
				rateLimitCircuitOpen &&
				call.name !== "submitReview" &&
				githubExecutorNames.has(call.name)
			) {
				log.info("github_tool_circuit_short_circuit", { tool: call.name });
				context.messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: CIRCUIT_OPEN_TOOL_RESULT }],
					isError: true,
					timestamp: Date.now(),
				});
				continue;
			}

			const isGithubTool = githubExecutorNames.has(call.name);

			if (isGithubTool && isInstallationTokenNearExpiry(tokenExpiresAtTs)) {
				log.warn("token_expired_before_tool", {
					tool: call.name,
					tokenExpiresInSeconds: Math.max(
						0,
						Math.floor((tokenExpiresAtTs - Date.now()) / 1000),
					),
				});
				isError = true;
				const classified = classifyGithubToolError(
					new Error("token near expiry guard"),
					{ expiresAtTs: tokenExpiresAtTs },
				);
				logGithubToolRequestError(call.name, null, logCtx, classified);
				text = formatToolErrorMessage(call.name, null, classified);
				rateLimitConsecutiveFailures = 0;
				context.messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text }],
					isError,
					timestamp: Date.now(),
				});
				continue;
			}

			try {
				const exec = executors[call.name];
				if (!exec) throw new Error(`Unknown tool: ${call.name}`);
				const out = await exec(call.arguments);
				text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
				if (call.name === "submitReview" && submitState.published) {
					stopLoop = true;
				}
				if (githubExecutorNames.has(call.name)) {
					rateLimitConsecutiveFailures = 0;
				}
			} catch (e) {
				isError = true;
				if (isGithubTool) {
					const classified = classifyGithubToolError(e, { expiresAtTs: tokenExpiresAtTs });
					logGithubToolRequestError(call.name, e, logCtx, classified);
					text = formatToolErrorMessage(call.name, e, classified);

					rateLimitConsecutiveFailures = bumpRateLimitConsecutiveFailures(
						rateLimitConsecutiveFailures,
						classified.classification,
					);
					if (
						!rateLimitCircuitOpen &&
						rateLimitConsecutiveFailures >= RATE_LIMIT_CIRCUIT_THRESHOLD
					) {
						rateLimitCircuitOpen = true;
						log.warn("review_rate_limit_circuit_open", {
							consecutiveFailures: rateLimitConsecutiveFailures,
							owner,
							repo,
							pr: prNumber,
							mode: reviewMode,
						});
						if (!circuitUserMessageSent) {
							circuitUserMessageSent = true;
							context.messages.push({
								role: "user",
								content: CIRCUIT_OPEN_USER_MESSAGE,
								timestamp: Date.now(),
							});
						}
					}
				} else {
					text = e instanceof Error ? e.message : `Error executing ${call.name}: ${String(e)}`;
					log.warn("tool_execute_failed", { tool: call.name, message: text });
				}
			}

			context.messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text }],
				isError,
				timestamp: Date.now(),
			});
		}
	}

	async function runToolLoop(maxRounds: number, loopMode: ToolLoopMode) {
		for (let round = 0; round < maxRounds && !stopLoop; round++) {
			const requireTools =
				loopMode.toolChoice === "every-round" ||
				(loopMode.toolChoice === "first-round" && round === 0);

			const assistant = await complete(
				model,
				context,
				requireTools && piTools.length > 0 ? { toolChoice: "required" } : undefined,
			);
			lastAssistant = assistant;
			context.messages.push(assistant);

			const toolCalls = collectToolCalls(assistant);
			if (toolCalls.length === 0) {
				log.info("agent_round_complete_no_tools", {
					mode: reviewMode,
					round,
					summary: assistantReplySummary(assistant).slice(0, 200),
				});
				if (loopMode.nudgeOnProseOnly && !stopLoop && round < maxRounds - 1) {
					context.messages.push({
						role: "user",
						content: PROSE_ONLY_NUDGE,
						timestamp: Date.now(),
					});
					continue;
				}
				break;
			}

			log.info("agent_tool_round", {
				mode: reviewMode,
				round,
				tools: toolCalls.map((t) => t.name),
			});
			await appendToolResults(toolCalls);
		}
	}

	async function runValidationRepair() {
		if (!submitState.published && submitState.lastValidationError) {
			log.info("review_payload_repair_attempt", {
				mode: reviewMode,
				message: submitState.lastValidationError,
			});
			context.messages.push({
				role: "user",
				content: `Your submitReview payload failed validation: ${submitState.lastValidationError}. Fix the payload and call submitReview again.`,
				timestamp: Date.now(),
			});
			submitState.lastValidationError = null;
			stopLoop = false;
			await runToolLoop(1, { toolChoice: "optional" });
		}
	}

	async function runFinalizePasses() {
		for (let f = 0; f < cfg.maxFinalizeRounds && endsWithToolResults(context.messages) && !stopLoop; f++) {
			log.warn("agent_finalize_pass", { mode: reviewMode, pass: f });
			const assistant = await complete(model, context);
			lastAssistant = assistant;
			context.messages.push(assistant);

			const toolCalls = collectToolCalls(assistant);
			if (toolCalls.length === 0) {
				log.info("agent_finalize_complete", { mode: reviewMode, pass: f });
				break;
			}

			log.info("agent_finalize_tool_round", {
				mode: reviewMode,
				pass: f,
				tools: toolCalls.map((t) => t.name),
			});
			await appendToolResults(toolCalls);
		}
	}

	async function runInvestigationPhase() {
		stopLoop = false;
		await runToolLoop(cfg.maxToolRounds, { toolChoice: "first-round" });
		await runFinalizePasses();
		await runValidationRepair();
	}

	async function runPublishRecoveryPhase(attemptIndex: number) {
		const prompt =
			PUBLISH_RECOVERY_PROMPTS[attemptIndex - 1] ??
			PUBLISH_RECOVERY_PROMPTS[PUBLISH_RECOVERY_PROMPTS.length - 1];
		log.info("review_publish_retry", {
			mode: reviewMode,
			attempt: attemptIndex + 1,
			maxAttempts: cfg.maxReviewPublishAttempts,
			owner,
			repo,
			pr: prNumber,
		});
		stopLoop = false;
		context.messages.push({
			role: "user",
			content: prompt,
			timestamp: Date.now(),
		});
		await runToolLoop(PUBLISH_RECOVERY_ROUNDS, {
			toolChoice: "every-round",
			nudgeOnProseOnly: true,
		});
		await runValidationRepair();
	}

	async function runMaintainerPlainTextFallback() {
		log.warn("agent_publish_fallback", {
			mode: reviewMode,
			publishAttempts,
			maxAttempts: cfg.maxReviewPublishAttempts,
			endsOnToolResult: endsWithToolResults(context.messages),
		});
		const savedTools = context.tools;
		context.tools = [];
		const prompt = endsWithToolResults(context.messages)
			? "System: tooling budget is exhausted or review was not published. Respond with **plain text only** (no tool calls). Summarize what was done, what failed or is blocked, and what the maintainers should do next."
			: `System: the structured review was not published after multiple attempts. Respond with **plain text only** (no tool calls). Summarize your findings and what maintainers should do next (including re-running ${reviewMode === "review-security" ? "/review-security" : "/review"}).`;
		context.messages.push({
			role: "user",
			content: prompt,
			timestamp: Date.now(),
		});

		const assistant = await complete(model, context);
		lastAssistant = assistant;
		context.messages.push(assistant);
		context.tools = savedTools;

		const summary = assistantReplySummary(assistant);
		if (summary.length === 0) return;

		const body = formatPublishFallbackComment(
			reviewMode,
			summary,
			publishAttempts,
			cfg.maxReviewPublishAttempts,
		);
		try {
			const comment = await createIssueComment(token, owner, repo, prNumber, body);
			log.info("review_publish_fallback_comment", {
				mode: reviewMode,
				owner,
				repo,
				pr: prNumber,
				commentId: comment.id,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.warn("review_publish_fallback_comment_failed", {
				mode: reviewMode,
				owner,
				repo,
				pr: prNumber,
				message,
			});
		}
	}

	for (let attempt = 0; attempt < cfg.maxReviewPublishAttempts && !submitState.published; attempt++) {
		publishAttempts = attempt + 1;
		if (attempt === 0) {
			await runInvestigationPhase();
		} else {
			await runPublishRecoveryPhase(attempt);
		}
	}

	if (!submitState.published) {
		log.warn("review_publish_exhausted", {
			mode: reviewMode,
			attempts: publishAttempts,
			maxAttempts: cfg.maxReviewPublishAttempts,
			owner,
			repo,
			pr: prNumber,
		});
	}

	if (!submitState.published) {
		await runMaintainerPlainTextFallback();
	}

	if (!lastAssistant) {
		throw new Error("Agent produced no assistant message");
	}

	return { lastAssistant, published: submitState.published, publishAttempts };
}
