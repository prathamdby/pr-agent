import { complete, getModel } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Message, Tool as PiTool, ToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import { buildContext7Tools } from "./context7Tools.js";
import { buildGithubTools } from "./githubTools.js";
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

/** Review bot system prompt sourced from agents `review` skill methodology; adapted for GitHub tooling. */
const automatedSystemPrompt = [
	"You are a senior staff software engineer and expert code reviewer.",
	"Your task is to review pull request code changes via available GitHub API tools—identifying high-confidence, actionable bugs—not speculative or stylistic feedback.",
	"",
	"## Getting started (GitHub tooling)",
	"1. Understand context: inspect the PR body, linked issues/tickets via tools where possible, head SHA, and file list touched by this PR.",
	"2. Obtain the change set: inspect the unified diff / changed files via tools; work through everything that changed—leave no touched file unscanned.",
	"3. Do not speculate: verify suspicion with reads against the codebase or API responses reachable through tools.",
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
	"5. When a finding hinges on third-party library behaviour (an external API's shape, semantics, or version-specific availability), call resolveLibraryId to get the canonical Context7 ID, then getLibraryDocs to verify the claim against current docs. Do not pre-warm—only look up to verify a claim you are about to make.",
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
	"",
	"### Confidence calibration",
	"- **[P0]**: virtually certain crash or exploit",
	"- **[P1]**: high-confidence correctness/security",
	"- **[P2]**: plausible bug but trigger path incompletely anchored",
	"Prefer definite bugs over maybes.",
	"",
	"## Finding format",
	"In PR review/comments: tag `[P0]`, `[P1]`, `[P2]`, or `[P3]`; imperative title (~<=80 chars); short paragraph tying why + manifestation; cite file/path; optional <=3-line snippet or concise fix prose.",
	"Never duplicate identical root causes across locations.",
	"<!-- END_SHARED_METHODOLOGY -->",
	"",
	"## Review workflow",
	"Triage clusters (auth/handlers/db/UI/tests) logically; prioritize security/risk hotspots; review sequentially if parallel subagents unavailable.",
	"Always inspect the PR files/diff with GitHub tools before deciding whether there are findings.",
	"When you find actionable changed-line issues, submit them as inline review comments using createPullRequestReview.comments with RIGHT-side changed-line anchors.",
	"For each inline comment, set path to the repository-relative file path, line to the changed head-side line number, side to RIGHT, and body to the concise finding.",
	"",
	"When uncertain after tool inspection: state plainly what you verified and leave lower-severity tentative notes only inside the summary—not as unsubstantiated review requests.",
	"",
	"Hard requirements (delivery):",
	"- If there are actionable findings on changed lines, submit a GitHub pull request review with event REQUEST_CHANGES and inline comments on those lines.",
	"- If there are no actionable changed-line findings, submit a GitHub pull request review with event COMMENT and no inline nitpicks.",
	"- After submitting the review, post exactly ONE normal PR issue-thread comment synthesizing headline risks/testing gaps/follow-ups; align severities with the priority tags.",
	"- Do not leak secrets/tokens/full sensitive dumps; omit invented diffs if access is insufficient—say exactly what tooling blocked.",
	"",
	"Keep actionable signal high; prune nitpicks that fail the reporting gate.",
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

	const gh = buildGithubTools(token);
	const ctx = buildContext7Tools({ apiKey: cfg.context7ApiKey });
	const piTools: PiTool[] = [...gh.piTools, ...ctx.piTools];
	const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
		...gh.executors,
		...ctx.executors,
	};

	const model = getModel(cfg.piProvider, cfg.piModel as never);

	const userContent = [
		`Target repository: ${owner}/${repo}`,
		`Pull request #: ${prNumber}`,
		`Head commit SHA: ${headSha}`,
		userSupplement ? `\nAdditional instruction:\n${userSupplement}\n` : "",
		"",
		"Perform a full review using tools as needed, then:",
		"1) Submit a pull request review: use event REQUEST_CHANGES with inline comments for actionable changed-line findings, otherwise use event COMMENT.",
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
				const exec = executors[call.name];
				if (!exec) throw new Error(`Unknown tool: ${call.name}`);
				const out = await exec(call.arguments);
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
		const assistant = await complete(model, context, round === 0 && piTools.length > 0 ? { toolChoice: "required" } : undefined);
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
