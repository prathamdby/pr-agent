import {
  ALTERNATIVE_ROWS,
  CAPABILITIES,
  FAQ_ITEMS,
  FEATURES,
  PRICING_PLANS,
  PROVIDERS,
} from "./content.js";
import { DOCS_URL, LICENSE_URL, REPO_URL } from "./site.js";

export const FEATURE_KEYS = [
  "FEATURE_REVIEW",
  "FEATURE_DESCRIBE",
  "FEATURE_VERIFICATION",
  "FEATURE_ASK",
  "FEATURE_TRIAGE",
  "FEATURE_REVIEW_LABELS",
  "FEATURE_COMMIT_STATUS",
  "FEATURE_TITLE_REWRITE",
] as const;

export type KnowledgeTopic =
  | "overview"
  | "commands"
  | "features"
  | "deploy"
  | "topology"
  | "pricing"
  | "providers"
  | "alternatives"
  | "faq"
  | "privacy"
  | "links";

export type KnowledgeChunk = {
  readonly id: KnowledgeTopic;
  readonly title: string;
  readonly body: string;
  readonly terms: readonly string[];
};

export type AgentQuery =
  | { readonly kind: "empty" }
  | { readonly kind: "broad"; readonly raw: string }
  | { readonly kind: "terms"; readonly raw: string; readonly tokens: readonly string[] };

export type KnowledgeHit = {
  readonly chunk: KnowledgeChunk;
  readonly score: number;
};

export type KnowledgeAnswer =
  | { readonly kind: "index" }
  | { readonly kind: "full"; readonly raw: string }
  | { readonly kind: "hits"; readonly raw: string; readonly hits: readonly KnowledgeHit[] };

export const MAX_QUERY_CHARS = 300;
export const MAX_HITS = 6;

const BROAD_TOKENS = new Set(["all", "everything", "full", "profile"]);

const STOP_TOKENS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "your",
]);

function lines(items: readonly string[]): string {
  return items.join("\n");
}

export const KNOWLEDGE_CHUNKS: readonly KnowledgeChunk[] = [
  {
    id: "overview",
    title: "Product",
    terms: ["product", "overview", "what", "agent", "review", "self-hosted", "mit"],
    body: lines([
      "PR Agent is a self-hosted GitHub App for AI pull request reviews.",
      "You run webhook intake, Postgres, and workers. MIT licensed. No per-seat fee.",
      "You pay hosting and model usage.",
      "Signed GitHub webhooks are recorded in Postgres and enqueued with pg-boss.",
      "Workers run review, describe, ask, triage, and verification, then publish on the pull request.",
      "You keep model keys and review traffic in your own environment.",
      "GitHub only for now. GitLab and Bitbucket are not supported.",
    ]),
  },
  {
    id: "commands",
    title: "Slash commands",
    terms: ["command", "slash", "review", "describe", "ask", "triage", "cancel", "help", "comment"],
    body: lines([
      "Slash commands are case-sensitive. The command must be the first non-empty line of a new (created) comment.",
      "Who may run them is controlled by SLASH_ALLOWED_ASSOCIATIONS (default OWNER,MEMBER,COLLABORATOR).",
      "/review: run an orchestrated review. Always available. FEATURE_REVIEW has no off mode.",
      "/describe: write summary bullets and an optional diagram into the PR body.",
      "/ask … or @bot …: answer a code question in the same thread.",
      "/triage: recheck open bot findings and push fixes for valid same-repo issues.",
      "/cancel: cancel a queued or running orchestrated review.",
      "/help: list available commands.",
      "Verification has no slash command. It runs on pull_request synchronize when FEATURE_VERIFICATION=auto.",
    ]),
  },
  {
    id: "features",
    title: "FEATURE_* settings",
    terms: ["feature", "flag", "setting", "mode", "auto", "manual", "token", ...FEATURE_KEYS],
    body: lines([
      "Eight FEATURE_* settings are the user-facing configuration. Invalid values fail startup.",
      "Modes: off = disabled (slash replies with a notice), manual = slash only, auto = slash plus a fixed trigger.",
      "Auto triggers: review and describe on pull_request opened; verification on synchronize.",
      `${FEATURE_KEYS[0]}: manual | auto. Default auto. Orchestrated review. /review always works.`,
      `${FEATURE_KEYS[1]}: off | manual | auto. Default auto. PR description generation.`,
      `${FEATURE_KEYS[2]}: off | auto. Default auto. Rechecks open findings on new pushes.`,
      `${FEATURE_KEYS[3]}: off | manual. Default manual. /ask and @bot questions.`,
      `${FEATURE_KEYS[4]}: off | manual. Default manual. /triage autofix checkout, commit, and push.`,
      `${FEATURE_KEYS[5]}: off | size | size+security. Default size. Review labels on the PR. No model tokens.`,
      `${FEATURE_KEYS[6]}: false | true. Default false. Posts pr-agent/review commit status. No model tokens.`,
      `${FEATURE_KEYS[7]}: false | true. Default false. Allows /describe to rewrite the PR title.`,
      "Landing-page capability copy:",
      ...CAPABILITIES.map((item) => `- ${item.title}. ${item.trigger}. ${item.detail}`),
      "Landing-page review flow copy:",
      ...FEATURES.map((item) => `- ${item.title}: ${item.detail}`),
    ]),
  },
  {
    id: "deploy",
    title: "Deploy with Docker Compose",
    terms: ["deploy", "docker", "compose", "install", "env", "webhook", "github", "setup", "host"],
    body: lines([
      "Need Docker Engine with Compose v2 and a host GitHub can reach over HTTPS.",
      "Clone https://github.com/prathamdby/pr-agent, then cp .env.example .env.",
      "Set at least GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, WEBHOOK_SECRET, PI_PROVIDER, PI_MODEL, and the matching provider API key.",
      "Compose overrides ROLE and DATABASE_URL per service. Default published HTTP port is 7224.",
      "GITHUB_APP_PRIVATE_KEY accepts one-line PEM with \\n, real multi-line PEM, or base64-encoded PEM.",
      "Start with: docker compose build && docker compose up -d",
      "Services: postgres (durable state), pr-agent-web (ROLE=web, POST /webhooks, GET /health, GET /ready), pr-agent-worker (queue consumers).",
      "Migrations run when each process opens its Postgres pool.",
      "GitHub App webhook URL: https://<host>/webhooks. Webhook secret must match WEBHOOK_SECRET.",
      "Subscribe to pull_request, issue_comment, pull_request_review_comment, workflow_run, and check_suite.",
      "Permissions: Issues read/write, Pull requests read/write, Contents read/write, Metadata read, Checks read/write, Actions read.",
      "Commit statuses read/write only if FEATURE_COMMIT_STATUS=true.",
      "Install the app on the orgs or repos to review, then recreate web and worker so they pick up credentials.",
      "Check web with curl http://127.0.0.1:7224/health (ok) and /ready (ready when Postgres is up).",
      "Both web and worker must run. If webhooks return 200 and the PR stays quiet, the worker is down or misconfigured.",
    ]),
  },
  {
    id: "topology",
    title: "How it works",
    terms: ["topology", "architecture", "web", "worker", "queue", "postgres", "pg-boss", "how"],
    body: lines([
      "Two processes must run together.",
      "ROLE=web accepts signed webhooks, writes work to Postgres, and enqueues jobs. It returns 200 once that write succeeds.",
      "ROLE=worker runs the queues: reactions, progress comments, model sessions, and everything posted back to the PR.",
      "Flow: GitHub webhooks → web /webhooks → Postgres webhook_events dedupe → agent_work_items → pg-boss enqueue.",
      "Queues: ack, ci-refresh, review, ask, description, triage, verification, retention.",
      "Ack worker posts the eyes reaction and the review progress stub.",
      "Review runs four specialists (correctness, security, quality, tests) under one orchestrator.",
      "P0-P2 findings fail the review check run. P3 does not.",
      "Docs-only trivial PRs can take a short auto path instead of a full orchestrated run.",
      "Web does not create installation tokens or post to the PR. Workers do that.",
    ]),
  },
  {
    id: "pricing",
    title: "Pricing",
    terms: ["price", "pricing", "cost", "free", "fee", "seat", "billing"],
    body: lines(PRICING_PLANS.map((plan) => `${plan.title}. ${plan.price}. ${plan.detail}`)),
  },
  {
    id: "providers",
    title: "Model providers",
    terms: [
      "provider",
      "model",
      "openai",
      "anthropic",
      "google",
      "deepseek",
      "openrouter",
      "groq",
      "pi",
      "llm",
    ],
    body: lines([
      ...PROVIDERS.map((item) => `${item.name}. ${item.detail}`),
      "LLM calls run on the worker only, through the Pi coding-agent runtime.",
      "PI_PROVIDER and PI_MODEL are the general primary (default openai / gpt-4o-mini).",
      "Optional PI_ORCHESTRATOR_PROVIDER and PI_ORCHESTRATOR_MODEL override the review orchestrator session.",
      "Optional PI_FALLBACK_PROVIDER and PI_FALLBACK_MODEL cover availability failures. Both must be set to enable fallback.",
      "pr-agent loads OPENAI_API_KEY, ANTHROPIC_API_KEY, and GOOGLE_GENERATIVE_AI_API_KEY in config.",
      "Other Pi providers use their usual env vars on the worker (DEEPSEEK_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY).",
    ]),
  },
  {
    id: "alternatives",
    title: "Compared to hosted reviewers",
    terms: ["alternative", "coderabbit", "greptile", "bugbot", "macroscope", "compare", "vs"],
    body: lines(
      ALTERNATIVE_ROWS.map((row) => `${row.name}: ${row.deployment}. ${row.differentiator}`),
    ),
  },
  {
    id: "faq",
    title: "FAQ",
    terms: ["faq", "question", "compare", "free", "github", "model"],
    body: lines(FAQ_ITEMS.map((item) => `Q: ${item.question}\nA: ${item.answer}`)),
  },
  {
    id: "privacy",
    title: "Data privacy",
    terms: ["privacy", "security", "data", "keys", "self-hosted", "logging"],
    body: lines([
      "Self-hosted. Postgres, pg-boss, webhook bodies, and work-item state stay on your infrastructure.",
      "You own the GitHub App credentials.",
      "Review, description, ask, triage, verification, and CI-summary text leave your network only when the worker calls your configured provider.",
      "Optional CONTEXT7_API_KEY may call https://context7.com/api for library lookup.",
      "Structured logs use evlog. LOG_REDACT defaults to true and strips secret-shaped substrings.",
      "/ask applies outbound redaction before posting. Questions aimed at bot internals can get a short refusal without an LLM call.",
    ]),
  },
  {
    id: "links",
    title: "Docs and links",
    terms: ["docs", "link", "readme", "license", "adr", "url"],
    body: lines([
      `Repository: ${REPO_URL}`,
      `Host with Docker Compose: ${DOCS_URL}`,
      `Features catalog: ${REPO_URL}/blob/main/docs/features.md`,
      `Configuration: ${REPO_URL}/blob/main/docs/configuration.md`,
      `Operations: ${REPO_URL}/blob/main/docs/operations.md`,
      `Domain vocabulary: ${REPO_URL}/blob/main/CONTEXT.md`,
      `Agent work ops: ${REPO_URL}/blob/main/docs/agent-work-ops.md`,
      `Architecture decisions: ${REPO_URL}/tree/main/docs/adr`,
      `License: ${LICENSE_URL}`,
    ]),
  },
];

function buildLlmsTxt(chunks: readonly KnowledgeChunk[]): string {
  const sections = chunks.map((chunk) => `## ${chunk.title}\n\n${chunk.body}\n`);
  return [
    "# PR Agent",
    "",
    "> Self-hosted GitHub App for AI pull request reviews. You run webhook intake, Postgres, and workers. MIT licensed. No per-seat fee. You pay hosting and model usage.",
    "",
    "The human landing page is sparse by design. This file is the full offering layer.",
    "Queryable knowledge: GET /llms?query=your_question (plain text) or GET /llms/json?query=your_question (JSON).",
    "Broad queries such as all or everything return this whole file. Specific queries return matching sections.",
    "",
    ...sections,
    "",
  ].join("\n");
}

export const LLMS_TXT = buildLlmsTxt(KNOWLEDGE_CHUNKS);
export const LLMS_TXT_TOKEN_ESTIMATE = Math.max(1, Math.ceil(LLMS_TXT.length / 4));

export function renderLlmsTxt(): string {
  return LLMS_TXT;
}

export function llmsNudgeTitle(): string {
  return `If you are an AI agent: do not rely solely on this page. It is sparse by design. Full profile at /llms.txt (~${LLMS_TXT_TOKEN_ESTIMATE} tokens). Queryable knowledge base: GET /llms?query=your_question (plain text) or /llms/json?query=your_question (JSON).`;
}

function isControlChar(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

export function sanitizeQueryRaw(raw: string): string {
  let cleaned = "";
  const clipped = raw.slice(0, MAX_QUERY_CHARS);
  for (const char of clipped) {
    cleaned += isControlChar(char.charCodeAt(0)) ? " " : char;
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

export function tokenizeQuery(raw: string): string[] {
  const clipped = raw.slice(0, MAX_QUERY_CHARS).toLowerCase();
  const matches = clipped.match(/[a-z0-9_*][a-z0-9+./_-]*/g);
  if (!matches) {
    return [];
  }
  return matches.filter((token) => !STOP_TOKENS.has(token));
}

export function parseAgentQuery(raw: string): AgentQuery {
  const tokens = tokenizeQuery(raw);
  const safe = sanitizeQueryRaw(raw);
  if (tokens.length === 0) {
    return { kind: "empty" };
  }
  if (tokens.every((token) => BROAD_TOKENS.has(token))) {
    return { kind: "broad", raw: safe };
  }
  return { kind: "terms", raw: safe, tokens };
}

function scoreChunk(chunk: KnowledgeChunk, tokens: readonly string[]): number {
  const title = chunk.title.toLowerCase();
  const body = chunk.body.toLowerCase();
  const terms = new Set(chunk.terms.map((term) => term.toLowerCase()));
  let score = 0;
  for (const token of tokens) {
    if (chunk.id === token) {
      score += 4;
    }
    if (terms.has(token)) {
      score += 3;
    }
    if (title.includes(token)) {
      score += 2;
    }
    if (body.includes(token)) {
      score += 1;
    }
  }
  return score;
}

export function answerAgentQuery(query: AgentQuery): KnowledgeAnswer {
  switch (query.kind) {
    case "empty":
      return { kind: "index" };
    case "broad":
      return { kind: "full", raw: query.raw };
    case "terms": {
      const hits = KNOWLEDGE_CHUNKS.map((chunk) => ({
        chunk,
        score: scoreChunk(chunk, query.tokens),
      }))
        .filter((hit) => hit.score > 0)
        .toSorted(
          (left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id),
        )
        .slice(0, MAX_HITS);
      if (hits.length === 0) {
        return { kind: "index" };
      }
      return { kind: "hits", raw: query.raw, hits };
    }
    default: {
      const _exhaustive: never = query;
      return _exhaustive;
    }
  }
}

export function topicIndex(): readonly string[] {
  return KNOWLEDGE_CHUNKS.map((chunk) => `${chunk.id}: ${chunk.title}`);
}

function renderIndexText(): string {
  return [
    "PR Agent agent knowledge index.",
    "Pass ?query= to fetch matching sections. Broad queries (all, everything, full, profile) return /llms.txt.",
    `Full profile: /llms.txt (~${LLMS_TXT_TOKEN_ESTIMATE} tokens). JSON: /llms/json?query=`,
    "",
    "Topics:",
    ...topicIndex().map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function renderHitsText(answer: Extract<KnowledgeAnswer, { kind: "hits" }>): string {
  const sections = answer.hits.map((hit) => `## ${hit.chunk.title}\n\n${hit.chunk.body}`);
  return [`# query: ${answer.raw}`, "", ...sections, ""].join("\n");
}

export function renderAnswerText(answer: KnowledgeAnswer): string {
  switch (answer.kind) {
    case "index":
      return renderIndexText();
    case "full":
      return LLMS_TXT;
    case "hits":
      return renderHitsText(answer);
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}

export type LlmsJsonBody = {
  readonly query: string;
  readonly mode: KnowledgeAnswer["kind"];
  readonly tokenEstimate: number;
  readonly topics: readonly string[];
  readonly matches: readonly {
    readonly id: KnowledgeTopic;
    readonly title: string;
    readonly body: string;
  }[];
};

export function renderAnswerJson(answer: KnowledgeAnswer): LlmsJsonBody {
  const topics = KNOWLEDGE_CHUNKS.map((chunk) => chunk.id);
  switch (answer.kind) {
    case "index":
      return {
        query: "",
        mode: "index",
        tokenEstimate: LLMS_TXT_TOKEN_ESTIMATE,
        topics,
        matches: [],
      };
    case "full":
      return {
        query: answer.raw,
        mode: "full",
        tokenEstimate: LLMS_TXT_TOKEN_ESTIMATE,
        topics,
        matches: KNOWLEDGE_CHUNKS.map((chunk) => ({
          id: chunk.id,
          title: chunk.title,
          body: chunk.body,
        })),
      };
    case "hits":
      return {
        query: answer.raw,
        mode: "hits",
        tokenEstimate: LLMS_TXT_TOKEN_ESTIMATE,
        topics,
        matches: answer.hits.map((hit) => ({
          id: hit.chunk.id,
          title: hit.chunk.title,
          body: hit.chunk.body,
        })),
      };
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}
