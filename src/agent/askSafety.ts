import type { Tool as PiTool } from "@earendil-works/pi-ai";
import {
  ASK_TOOLS_WITH_OWNER_REPO,
  ASK_TOOLS_WITH_PULL_NUMBER,
  BOT_META_PATTERNS,
  SENSITIVE_PATH_PATTERNS,
} from "../settings/index.js";
import { redactOutboundSecrets } from "../security/redactOutboundSecrets.js";
import { buildGithubTools } from "./githubTools.js";

export { redactOutboundSecrets };

export type AskQuestionIntent = "code" | "bot_meta";

export { ASK_META_REFUSAL, MAX_ASK_QUESTION_CHARS } from "../settings/index.js";

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
  return ['<context trusted="server">', ...lines, "</context>"].join("\n");
}

export type AskToolScope = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
};

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

      if (ASK_TOOLS_WITH_OWNER_REPO.has(name)) {
        if (merged.owner != null && merged.owner !== scope.owner) {
          throw new Error(`Tool ${name} is scoped to owner "${scope.owner}".`);
        }
        if (merged.repo != null && merged.repo !== scope.repo) {
          throw new Error(`Tool ${name} is scoped to repo "${scope.repo}".`);
        }
        merged.owner = scope.owner;
        merged.repo = scope.repo;
      }

      if (ASK_TOOLS_WITH_PULL_NUMBER.has(name)) {
        if (merged.pullNumber != null && merged.pullNumber !== scope.prNumber) {
          throw new Error(`Tool ${name} is scoped to pull request #${scope.prNumber}.`);
        }
        merged.pullNumber = scope.prNumber;
      }

      if (name === "getFileContent") {
        const path = typeof merged.path === "string" ? merged.path : "";
        assertPathAllowedForAsk(path, gate);
        if (merged.ref == null || merged.ref === "") {
          merged.ref = scope.headSha;
        }
      }

      if (name === "searchCode") {
        merged.query = injectRepoIntoSearchQuery(
          typeof merged.query === "string" ? merged.query : "",
          scope.owner,
          scope.repo,
        );
      }

      if (name === "listPullRequestFiles") {
        const out = await fn(merged);
        if (
          out &&
          typeof out === "object" &&
          "files" in out &&
          Array.isArray((out as { files: unknown }).files)
        ) {
          const files = (out as { files: Array<{ filename?: string }> }).files;
          gate.addPaths(files.map((f) => f.filename ?? "").filter(Boolean));
        }
        return sanitizeToolResultForAsk(name, out);
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
    piTools: gh.piTools,
    executors: buildScopedAskExecutors(gh.executors, scope, gate),
  };
}
