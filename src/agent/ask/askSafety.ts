import { AppError } from "../../errors/appError.ts";
import { BOT_META_PATTERNS, SENSITIVE_PATH_PATTERNS } from "../../settings/index.ts";

export type AskQuestionIntent = "code" | "bot_meta";

export function classifyAskQuestionIntent(question: string) {
  for (const pattern of BOT_META_PATTERNS) {
    if (pattern.test(question.trim()))
      return ((pinnedReturn: AskQuestionIntent) => pinnedReturn)("bot_meta");
  }
  return ((pinnedReturn: AskQuestionIntent) => pinnedReturn)("code");
}

export function isSensitivePath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return ((pinnedReturn: boolean) => pinnedReturn)(
    SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized)),
  );
}

export type AskPathGate = {
  readonly prChangedPaths: ReadonlySet<string>;
  readonly addPaths: (paths: Iterable<string>) => void;
};

export function createAskPathGate() {
  const prChangedPaths = new Set<string>();
  return ((pinnedReturn: AskPathGate) => pinnedReturn)({
    prChangedPaths,
    addPaths(paths: Iterable<string>) {
      for (const p of paths) prChangedPaths.add(p);
    },
  });
}

export function pathAllowedForAsk(path: string, gate: AskPathGate) {
  if (!isSensitivePath(path)) return ((pinnedReturn: boolean) => pinnedReturn)(true);
  return ((pinnedReturn: boolean) => pinnedReturn)(gate.prChangedPaths.has(path));
}

export function assertPathAllowedForAsk(path: string, gate: AskPathGate) {
  if (pathAllowedForAsk(path, gate)) return;
  throw new AppError({
    domain: "ask",
    kind: "sensitive_path_blocked",
    message: `getFileContent blocked for sensitive path "${path}" (not in this PR's changed files). Ask about files touched by the PR instead.`,
    context: { path },
  });
}

const redactEmailsInJson: (value: unknown) => unknown = (value: unknown) => {
  if (Array.isArray(value))
    return ((pinnedReturn: unknown) => pinnedReturn)(value.map(redactEmailsInJson));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "authorEmail" || k === "email") {
        out[k] = v == null ? v : "[redacted]";
      } else {
        out[k] = redactEmailsInJson(v);
      }
    }
    return ((pinnedReturn: unknown) => pinnedReturn)(out);
  }
  return ((pinnedReturn: unknown) => pinnedReturn)(value);
};

export function sanitizeToolResultForAsk(toolName: string, result: unknown) {
  if (toolName === "getWorkspaceBlame")
    return ((pinnedReturn: unknown) => pinnedReturn)(redactEmailsInJson(result));
  return ((pinnedReturn: unknown) => pinnedReturn)(result);
}

export function redactPorcelainBlame(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    text.replace(/^author-mail .+$/gm, "author-mail [redacted]"),
  );
}
