import { complete, getModel } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Message, ToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import { bridgeGithubToolsToPi } from "../bridge/aiSdkToolsToPiTools.js";
import { buildCodeReviewToolset } from "./githubTools.js";
import { log } from "../log.js";

export type ReviewRunResult = { lastAssistant: AssistantMessage };

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

const automatedSystemPrompt = [
	"You are an expert software engineer acting as a GitHub pull request review bot.",
	"You have tools to read the repository and pull request via GitHub's API, and to post review feedback.",
	"",
	"Hard requirements:",
	"- Default review outcome must be a pull request review with GitHub event COMMENT (not REQUEST_CHANGES and not APPROVE), unless the policy text from the user explicitly allows otherwise.",
	"- After submitting the review, post one additional normal issue comment on the PR thread with a short markdown summary: risks, testing gaps, and follow-ups.",
	"- Do not paste secrets, tokens, or large dumps of sensitive data. If you cannot access content due to permissions, say so plainly—never invent diffs.",
	"- Prioritize correctness and security; keep feedback actionable and avoid nitpick spam.",
].join("\n");

export async function runFullPrReview(params: {
	cfg: Config;
	token: string;
	owner: string;
	repo: string;
	prNumber: number;
	headSha: string;
	userSupplement?: string;
}): Promise<ReviewRunResult> {
	const { cfg, token, owner, repo, prNumber, headSha, userSupplement } = params;

	const ghToolset = buildCodeReviewToolset(token) as unknown as Record<string, unknown>;
	const { piTools, executeTool } = bridgeGithubToolsToPi(ghToolset);

	const model = getModel(cfg.piProvider, cfg.piModel as never);

	const userContent = [
		`Target repository: ${owner}/${repo}`,
		`Pull request #: ${prNumber}`,
		`Head commit SHA: ${headSha}`,
		userSupplement ? `\nAdditional instruction:\n${userSupplement}\n` : "",
		"",
		"Perform a full review using tools as needed, then:",
		"1) Submit a pull request review (event COMMENT) with useful inline comments when appropriate.",
		"2) Post a single issue comment on this PR summarizing findings.",
	].join("\n");

	const context: Context = {
		systemPrompt: automatedSystemPrompt,
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

	async function appendToolResults(toolCalls: ToolCall[]) {
		for (const call of toolCalls) {
			let text: string;
			let isError = false;
			try {
				const out = await executeTool(call.name, call.arguments, call.id);
				text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
			} catch (e) {
				isError = true;
				text = e instanceof Error ? e.message : `Error executing ${call.name}: ${String(e)}`;
				log.warn("tool_execute_failed", { tool: call.name, message: text });
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

	for (let round = 0; round < cfg.maxToolRounds; round++) {
		const assistant = await complete(model, context);
		lastAssistant = assistant;
		context.messages.push(assistant);

		const toolCalls = collectToolCalls(assistant);
		if (toolCalls.length === 0) {
			log.info("agent_round_complete_no_tools", { round, summary: assistantReplySummary(assistant).slice(0, 200) });
			break;
		}

		log.info("agent_tool_round", { round, tools: toolCalls.map((t) => t.name) });
		await appendToolResults(toolCalls);
	}

	/** If we still owe the model a turn after tool results (e.g. hit `MAX_TOOL_ROUNDS`), continue with a bounded finalize budget. */
	for (let f = 0; f < cfg.maxFinalizeRounds && endsWithToolResults(context.messages); f++) {
		log.warn("agent_finalize_pass", { pass: f });
		const assistant = await complete(model, context);
		lastAssistant = assistant;
		context.messages.push(assistant);

		const toolCalls = collectToolCalls(assistant);
		if (toolCalls.length === 0) {
			log.info("agent_finalize_complete", { pass: f });
			break;
		}

		log.info("agent_finalize_tool_round", { pass: f, tools: toolCalls.map((t) => t.name) });
		await appendToolResults(toolCalls);
	}

	if (endsWithToolResults(context.messages)) {
		log.warn("agent_incomplete_tool_chain", { maxToolRounds: cfg.maxToolRounds, maxFinalizeRounds: cfg.maxFinalizeRounds });
		const savedTools = context.tools;
		context.tools = [];
		context.messages.push({
			role: "user",
			content:
				"System: tooling budget is exhausted. Respond with **plain text only** (no tool calls). Summarize what was done, what failed or is blocked, and what the maintainers should do next.",
			timestamp: Date.now(),
		});

		const assistant = await complete(model, context);
		lastAssistant = assistant;
		context.messages.push(assistant);
		context.tools = savedTools;
	}

	if (!lastAssistant) {
		throw new Error("Agent produced no assistant message");
	}

	return { lastAssistant };
}
