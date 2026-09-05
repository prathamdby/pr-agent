import { AppError } from "../../errors/appError.js";
import { BOT_META_PATTERNS, SENSITIVE_PATH_PATTERNS } from "../../settings/index.js";

export type AskQuestionIntent = "code" | "bot_meta";

export function classifyAskQuestionIntent(question: string): AskQuestionIntent {
  for (const pattern of BOT_META_PATTERNS) {
    if (pattern.test(question.trim())) return "bot_meta";
  }
  return "code";
}

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

export function pathAllowedForAsk(path: string, gate: AskPathGate): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!isSensitivePath(normalized)) return true;
  return gate.prChangedPaths.has(normalized);
}

export function assertPathAllowedForAsk(path: string, gate: AskPathGate): void {
  const normalized = path.replace(/\\/g, "/");
  if (pathAllowedForAsk(normalized, gate)) return;
  throw new AppError({
    code: "ask.sensitive_path_blocked",
    message: `getFileContent blocked for sensitive path "${normalized}" (not in this PR's changed files). Ask about files touched by the PR instead.`,
    context: { path: normalized },
  });
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

export function sanitizeToolResultForAsk(toolName: string, result: unknown): unknown {
  if (toolName === "getWorkspaceBlame") return redactEmailsInJson(result);
  return result;
}

export function redactPorcelainBlame(text: string): string {
  return text.replace(/^author-mail .+$/gm, "author-mail [redacted]");
}
