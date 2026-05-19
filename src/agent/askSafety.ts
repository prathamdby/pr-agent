import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { buildGithubTools } from "./githubTools.js";
import { filterReviewAgentExecutors, filterReviewAgentTools } from "./submitReviewTool.js";

export type AskQuestionIntent = "code" | "bot_meta";

export const ASK_META_REFUSAL =
	"I can only answer questions about this PR's code. I can't share bot configuration, credentials, or internal instructions.";

export const MAX_ASK_QUESTION_CHARS = 8192;

const BOT_META_PATTERNS: readonly RegExp[] = [
	/\b(your|the)\s+system\s+prompt\b/i,
	/\brepeat\s+(everything|all)\s+above\b/i,
	/\brepeat\s+your\s+(instructions|rules|prompt)\b/i,
	/\bwhat\s+(model|llm)\s+are\s+you\b/i,
	/\bwhat\s+(provider|pi[_-]?provider)\s+do\s+you\s+use\b/i,
	/\b(your|the)\s+(openai|anthropic|google)\s+api\s+key\b/i,
	/\bwhat\s+is\s+your\s+(database_url|webhook_secret|github_app(?:_id|_private_key)?)\b/i,
	/\b(show|reveal|print|output|dump|tell\s+me)\s+.{0,30}\b(your\s+)?(prompt|instructions|system\s+message)\b/i,
	/\bhow\s+are\s+you\s+(deployed|hosted|configured)\b/i,
	/\b(bot|agent)\s+(configuration|credentials|secrets|environment)\b/i,
	/\bignore\s+(all\s+)?(previous|prior|above)\s+instructions\b/i,
];

export function classifyAskQuestionIntent(question: string): AskQuestionIntent {
	for (const pattern of BOT_META_PATTERNS) {
		if (pattern.test(question.trim())) return "bot_meta";
	}
	return "code";
}

export function wrapUntrustedBlock(label: string, text: string): string {
	return [`<${label} untrusted="true">`, text.trim(), `</${label}>`].join("\n");
}

export function wrapTrustedContext(lines: string[]): string {
	return ["<context trusted=\"server\">", ...lines, "</context>"].join("\n");
}

const BOT_SECRET_PATTERNS: readonly RegExp[] = [
	/Bearer\s+\S+/gi,
	/(token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi,
	/Authorization:\s*\S+/gi,
	/\bghp_[A-Za-z0-9]{20,}\b/g,
	/\bghs_[A-Za-z0-9]{20,}\b/g,
	/\bsk-[A-Za-z0-9_-]{10,}\b/g,
	/\bpostgres(?:ql)?:\/\/\S+/gi,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactOutboundSecrets(text: string): string {
	let out = text;
	for (const pattern of BOT_SECRET_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	return out;
}

export type AskToolScope = {
	readonly owner: string;
	readonly repo: string;
	readonly prNumber: number;
	readonly headSha: string;
};

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.env(?:\.|$)/i,
	/(^|\/)\.env\.[^/]+$/i,
	/\.pem$/i,
	/(^|\/)id_rsa(?:\.pub)?$/i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)secrets?\./i,
	/(^|\/)\.netrc$/i,
];

export function isSensitivePath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized));
}

export type AskPathGate = {
	readonly prChangedPaths: ReadonlySet<string>;
	readonly addPaths: (paths: Iterable<string>) => void;
};

export function createAskPathGate(): AskPathGate {
	const prChangedPaths = new Set<string>();
	return {
		prChangedPaths,
		addPaths(paths: Iterable<string>) {
			for (const p of paths) prChangedPaths.add(p.replace(/\\/g, "/"));
		},
	};
}

export function assertPathAllowedForAsk(path: string, gate: AskPathGate): void {
	const normalized = path.replace(/\\/g, "/");
	if (!isSensitivePath(normalized)) return;
	if (gate.prChangedPaths.has(normalized)) return;
	throw new Error(
		`getFileContent blocked for sensitive path "${normalized}" (not in this PR's changed files). Ask about files touched by the PR instead.`,
	);
}

function redactEmailsInJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactEmailsInJson);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "authorEmail" || k === "email") {
				out[k] = v == null ? v : "[redacted]";
			} else {
				out[k] = redactEmailsInJson(v);
			}
		}
		return out;
	}
	return value;
}

function sanitizeToolResultForAsk(toolName: string, result: unknown): unknown {
	if (toolName === "getBlame") return redactEmailsInJson(result);
	return result;
}

const TOOLS_WITH_OWNER_REPO = new Set([
	"getPullRequest",
	"listPullRequests",
	"listPullRequestFiles",
	"listPullRequestReviews",
	"getFileContent",
	"listCommits",
	"getCommit",
	"getBlame",
	"getRepository",
	"listBranches",
]);

const TOOLS_WITH_PULL_NUMBER = new Set([
	"getPullRequest",
	"listPullRequestFiles",
	"listPullRequestReviews",
]);

function injectRepoIntoSearchQuery(query: string, owner: string, repo: string): string {
	const repoQualifier = `repo:${owner}/${repo}`;
	if (/\brepo:\S+/i.test(query)) {
		const foreignRepo = query.match(/\brepo:([^\s]+)/i)?.[1];
		if (foreignRepo && foreignRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
			throw new Error(
				`searchCode is scoped to ${owner}/${repo}; remove repo: qualifiers for other repositories.`,
			);
		}
		return query;
	}
	return `${query} ${repoQualifier}`.trim();
}

export function buildScopedAskExecutors(
	base: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
	scope: AskToolScope,
	gate: AskPathGate,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
	const scoped: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};

	for (const [name, fn] of Object.entries(base)) {
		scoped[name] = async (args) => {
			const merged = { ...args };

			if (TOOLS_WITH_OWNER_REPO.has(name)) {
				if (merged.owner != null && merged.owner !== scope.owner) {
					throw new Error(`Tool ${name} is scoped to owner "${scope.owner}".`);
				}
				if (merged.repo != null && merged.repo !== scope.repo) {
					throw new Error(`Tool ${name} is scoped to repo "${scope.repo}".`);
				}
				merged.owner = scope.owner;
				merged.repo = scope.repo;
			}

			if (TOOLS_WITH_PULL_NUMBER.has(name)) {
				if (merged.pullNumber != null && merged.pullNumber !== scope.prNumber) {
					throw new Error(`Tool ${name} is scoped to pull request #${scope.prNumber}.`);
				}
				merged.pullNumber = scope.prNumber;
			}

			if (name === "getFileContent") {
				const path = String(merged.path ?? "");
				assertPathAllowedForAsk(path, gate);
				if (merged.ref == null || merged.ref === "") {
					merged.ref = scope.headSha;
				}
			}

			if (name === "searchCode") {
				merged.query = injectRepoIntoSearchQuery(String(merged.query ?? ""), scope.owner, scope.repo);
			}

			if (name === "listPullRequestFiles") {
				const out = await fn(merged);
				if (out && typeof out === "object" && "files" in out && Array.isArray((out as { files: unknown }).files)) {
					const files = (out as { files: Array<{ filename?: string }> }).files;
					gate.addPaths(files.map((f) => f.filename ?? "").filter(Boolean));
				}
				return out;
			}

			const out = await fn(merged);
			return sanitizeToolResultForAsk(name, out);
		};
	}

	return scoped;
}

export function buildAskGithubTools(
	token: string,
	scope: AskToolScope,
	limits: { maxPrFilesListed: number; maxPrFilesPatchBytes: number },
	gate: AskPathGate,
): {
	piTools: PiTool[];
	executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
	const gh = buildGithubTools(token, limits);
	return {
		piTools: filterReviewAgentTools(gh.piTools),
		executors: buildScopedAskExecutors(filterReviewAgentExecutors(gh.executors), scope, gate),
	};
}
