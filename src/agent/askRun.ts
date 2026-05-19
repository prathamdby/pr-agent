import { complete, getModel } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Message, Tool as PiTool, ToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { ReplyTarget } from "../commands/slashCommandFlow.js";
import { log } from "../log.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { buildAskSystemPrompt } from "./askPrompt.js";
import { formatAskFailureReply, formatAskReply } from "./formatAskReply.js";
import { buildContext7Tools } from "./context7Tools.js";
import {
	ASK_META_REFUSAL,
	buildAskGithubTools,
	classifyAskQuestionIntent,
	createAskPathGate,
	wrapTrustedContext,
	wrapUntrustedBlock,
} from "./askSafety.js";
import {
	bumpRateLimitConsecutiveFailures,
	classifyGithubToolError,
	formatToolErrorMessage,
	isInstallationTokenNearExpiry,
	logGithubToolRequestError,
} from "../github/githubRequestError.js";

const RATE_LIMIT_CIRCUIT_THRESHOLD = 3;
const CIRCUIT_OPEN_USER_MESSAGE =
	"Stop GitHub tool calls; answer the question now using what you already found in this conversation.";
const CIRCUIT_OPEN_TOOL_RESULT =
	"Rate-limit circuit open: further GitHub investigation tools are blocked for this ask run. Answer the question with your current analysis.";

const ASK_RETRY_ROUNDS = 4;
const ASK_RETRY_NUDGE =
	"Answer the question now in plain text based on your investigation above. Do not call more tools unless absolutely required to fix a factual gap.";

const ASK_FAILURE_MESSAGE =
	"I could not put together a confident answer from the PR and repo tools available. Try rephrasing the question, narrowing it to a file or symbol, or run `/review` for a full pass.";

export type CodeAnchor = {
	path: string;
	line: number;
	startLine?: number;
	side?: "LEFT" | "RIGHT";
	diffHunk?: string;
};

export type AskRunParams = {
	cfg: Config;
	token: string;
	tokenExpiresAtTs: number;
	tokenTtlMs: number;
	owner: string;
	repo: string;
	prNumber: number;
	headSha: string;
	question: string;
	replyTarget: ReplyTarget;
	codeAnchor?: CodeAnchor;
};

export type AskRunResult = {
	answer: string;
	replied: boolean;
};

function collectToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((p): p is ToolCall => p.type === "toolCall");
}

function assistantReplySummary(message: AssistantMessage): string {
	return message.content
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("\n")
		.trim();
}

function endsWithToolResults(messages: Message[]): boolean {
	return messages[messages.length - 1]?.role === "toolResult";
}

function buildUserContent(params: AskRunParams): string {
	const blocks = [
		wrapTrustedContext([
			`Repository: ${params.owner}/${params.repo}`,
			`Pull request: #${params.prNumber}`,
			`Head commit SHA: ${params.headSha}`,
		]),
		wrapUntrustedBlock("user_question", params.question),
	];

	if (params.codeAnchor) {
		const { path, line, startLine, side, diffHunk } = params.codeAnchor;
		const range =
			startLine != null && startLine !== line ? `lines ${startLine}-${line}` : `line ${line}`;
		const anchorLines = [
			`File: ${path}`,
			`${range}${side ? ` (${side} side of diff)` : ""}`,
		];
		if (diffHunk?.trim()) {
			anchorLines.push("", "Diff hunk:", "```diff", diffHunk.trim(), "```");
		}
		anchorLines.push("", "Start from this anchor, then use tools to trace symbols and surrounding context.");
		blocks.push(wrapUntrustedBlock("code_anchor", anchorLines.join("\n")));
	} else {
		blocks.push(
			"Use GitHub tools to inspect the PR diff and related files, then answer the question in user_question.",
		);
	}

	return blocks.join("\n\n");
}

export async function runAskRun(params: AskRunParams): Promise<AskRunResult> {
	const { cfg, token, tokenExpiresAtTs, tokenTtlMs, owner, repo, prNumber, question, replyTarget } =
		params;

	if (classifyAskQuestionIntent(question) === "bot_meta") {
		log.info("ask_meta_refusal", { owner, repo, pr: prNumber });
		return {
			answer: formatAskReply({ question, answer: ASK_META_REFUSAL, replyTarget }),
			replied: true,
		};
	}

	if (!Number.isFinite(tokenExpiresAtTs)) {
		throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
	}
	if (!Number.isFinite(tokenTtlMs) || tokenTtlMs <= 0) {
		throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
	}

	const pathGate = createAskPathGate();
	if (params.codeAnchor?.path) {
		pathGate.addPaths([params.codeAnchor.path]);
	}
	const gh = buildAskGithubTools(
		token,
		{ owner, repo, prNumber, headSha: params.headSha },
		{
			maxPrFilesListed: cfg.maxPrFilesListed,
			maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
		},
		pathGate,
	);
	try {
		await gh.executors.listPullRequestFiles({});
		if (pathGate.prChangedPaths.size === 0) {
			log.warn("ask_path_gate_prime_empty", { owner, repo, pr: prNumber });
		}
	} catch (e) {
		log.warn("ask_path_gate_prime_failed", {
			owner,
			repo,
			pr: prNumber,
			message: sanitizeLogMessage(e instanceof Error ? e.message : String(e)),
		});
	}
	const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });

	const piTools: PiTool[] = [...gh.piTools, ...ctx7.piTools];
	const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
		...gh.executors,
		...ctx7.executors,
	};

	const model = getModel(cfg.piProvider, cfg.piModel as never);
	const context: Context = {
		systemPrompt: buildAskSystemPrompt(),
		messages: [
			{
				role: "user",
				content: buildUserContent(params),
				timestamp: Date.now(),
			},
		],
		tools: piTools,
	};

	let lastAssistant: AssistantMessage | null = null;
	let stopLoop = false;
	let rateLimitConsecutiveFailures = 0;
	let rateLimitCircuitOpen = false;
	let circuitUserMessagePending = false;
	let retried = false;

	const logCtx = {
		expiresAtTs: tokenExpiresAtTs,
		ttlMs: tokenTtlMs,
		owner,
		repo,
		prNumber,
		mode: "ask" as const,
	};

	const githubExecutorNames = new Set(Object.keys(gh.executors));

	async function appendToolResults(toolCalls: ToolCall[]) {
		for (const call of toolCalls) {
			let text: string;
			let isError = false;

			if (rateLimitCircuitOpen && githubExecutorNames.has(call.name)) {
				log.info("github_tool_circuit_short_circuit", { tool: call.name, mode: "ask" });
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
				isError = true;
				const classified = classifyGithubToolError(
					new Error("token near expiry guard"),
					{ expiresAtTs: tokenExpiresAtTs, ttlMs: tokenTtlMs },
				);
				logGithubToolRequestError(call.name, null, logCtx, classified);
				text = formatToolErrorMessage(call.name, null, classified);
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
				if (githubExecutorNames.has(call.name)) {
					rateLimitConsecutiveFailures = 0;
				}
			} catch (e) {
				isError = true;
				if (isGithubTool) {
					const classified = classifyGithubToolError(e, {
						expiresAtTs: tokenExpiresAtTs,
						ttlMs: tokenTtlMs,
					});
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
						log.warn("ask_rate_limit_circuit_open", {
							consecutiveFailures: rateLimitConsecutiveFailures,
							owner,
							repo,
							pr: prNumber,
						});
						circuitUserMessagePending = true;
					}
				} else {
					const raw = e instanceof Error ? e.message : `Error executing ${call.name}: ${String(e)}`;
					text = raw;
					log.warn("tool_execute_failed", {
						tool: call.name,
						message: sanitizeLogMessage(raw),
						mode: "ask",
					});
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

		if (circuitUserMessagePending) {
			circuitUserMessagePending = false;
			context.messages.push({
				role: "user",
				content: CIRCUIT_OPEN_USER_MESSAGE,
				timestamp: Date.now(),
			});
		}
	}

	async function runToolLoop(maxRounds: number, requireToolsFirstRound: boolean) {
		for (let round = 0; round < maxRounds && !stopLoop; round++) {
			const requireTools = requireToolsFirstRound && round === 0;
			const assistant = await complete(
				model,
				context,
				requireTools && piTools.length > 0 ? { toolChoice: "required" } : undefined,
			);
			lastAssistant = assistant;
			context.messages.push(assistant);

			const toolCalls = collectToolCalls(assistant);
			if (toolCalls.length === 0) {
				log.info("ask_round_complete_no_tools", { round, pr: prNumber });
				break;
			}

			log.info("ask_tool_round", { round, tools: toolCalls.map((t) => t.name), pr: prNumber });
			await appendToolResults(toolCalls);
		}
	}

	async function runFinalizePasses() {
		for (let f = 0; f < cfg.maxFinalizeRounds && endsWithToolResults(context.messages) && !stopLoop; f++) {
			const assistant = await complete(model, context);
			lastAssistant = assistant;
			context.messages.push(assistant);
			const toolCalls = collectToolCalls(assistant);
			if (toolCalls.length === 0) break;
			await appendToolResults(toolCalls);
		}
	}

	async function runTextOnlyPass(prompt: string) {
		const savedTools = context.tools;
		context.tools = [];
		context.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
		const assistant = await complete(model, context);
		lastAssistant = assistant;
		context.messages.push(assistant);
		context.tools = savedTools;
	}

	stopLoop = false;
	await runToolLoop(cfg.maxAskToolRounds, true);
	await runFinalizePasses();

	let summary = lastAssistant ? assistantReplySummary(lastAssistant) : "";

	if (!summary && !retried) {
		retried = true;
		log.info("ask_retry_nudge", { owner, repo, pr: prNumber });
		context.messages.push({ role: "user", content: ASK_RETRY_NUDGE, timestamp: Date.now() });
		stopLoop = false;
		await runToolLoop(ASK_RETRY_ROUNDS, false);
		await runFinalizePasses();
		summary = lastAssistant ? assistantReplySummary(lastAssistant) : "";
	}

	if (!summary) {
		log.warn("ask_text_only_fallback", { owner, repo, pr: prNumber });
		await runTextOnlyPass(
			"Respond with plain text only (no tool calls). Answer the question using what you found, or explain clearly what blocked a complete answer.",
		);
		summary = lastAssistant ? assistantReplySummary(lastAssistant) : "";
	}

	const answerText =
		summary.length > 0
			? formatAskReply({ question, answer: summary, replyTarget })
			: formatAskFailureReply({ question, message: ASK_FAILURE_MESSAGE, replyTarget });

	log.info("ask_completed", {
		owner,
		repo,
		pr: prNumber,
		hasAnswer: summary.length > 0,
		inline: replyTarget.kind === "inlineReviewThread",
	});

	return { answer: answerText, replied: true };
}
