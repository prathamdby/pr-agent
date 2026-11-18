import type { Config } from "../settings/index.ts";
import { isPlainObject } from "../util/typeGuards.ts";

const CREDENTIALS =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|(?:ghs_[A-Za-z0-9._-]+|gh[phorsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]{36}|sk_(?:live|test)_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|xox(?:[a-z]-|e\.)[A-Za-z0-9.-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\s:]+:[^\s@]+@/gi;

export function createTraceRedactor(
  cfg: Pick<Config, "github" | "models" | "webhook" | "runtime" | "posthog">,
) {
  const secrets = new Set<string>();
  const addSecret = (value: string | undefined) => {
    if (!value) return;
    secrets.add(value);
    secrets.add(JSON.stringify(value).slice(1, -1));
  };
  [
    cfg.github.privateKey,
    cfg.webhook.secret,
    cfg.runtime.databaseUrl,
    ...Object.values(cfg.models.providerKeys),
    cfg.posthog.projectToken,
  ].forEach(addSecret);
  return {
    addSecret,
    redact(text: string) {
      let body = text;
      for (const secret of [...secrets].toSorted((a, b) => b.length - a.length)) {
        if (!body.includes(secret)) continue;
        body = body.split(secret).join("[redacted]");
      }
      return ((pinnedReturn: string) => pinnedReturn)(body.replace(CREDENTIALS, "[redacted]"));
    },
  };
}

export function redactTraceValue(value: unknown, redact: (text: string) => string) {
  return ((pinnedReturn: unknown) => pinnedReturn)(walkRedacted(value, redact, new WeakSet()));
}

const walkRedacted: (
  value: unknown,
  redact: (text: string) => string,
  seen: WeakSet<object>,
) => unknown = (value: unknown, redact: (text: string) => string, seen: WeakSet<object>) => {
  if (typeof value === "string") return ((pinnedReturn: unknown) => pinnedReturn)(redact(value));
  if (typeof value === "number" || typeof value === "boolean" || value == null)
    return ((pinnedReturn: unknown) => pinnedReturn)(value);
  if (typeof value !== "object") {
    try {
      const text = JSON.stringify(value);
      return ((pinnedReturn: unknown) => pinnedReturn)(
        typeof text === "string" ? redact(text) : value,
      );
    } catch {
      return ((pinnedReturn: unknown) => pinnedReturn)("[trace content truncated]");
    }
  }
  if (seen.has(value))
    return ((pinnedReturn: unknown) => pinnedReturn)("[trace content truncated]");
  seen.add(value);
  if (Array.isArray(value))
    return ((pinnedReturn: unknown) => pinnedReturn)(
      value.map((item) => walkRedacted(item, redact, seen)),
    );
  if (isPlainObject(value)) {
    return ((pinnedReturn: unknown) => pinnedReturn)(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walkRedacted(item, redact, seen)]),
      ),
    );
  }
  try {
    const text = JSON.stringify(value);
    return ((pinnedReturn: unknown) => pinnedReturn)(
      typeof text === "string" ? redact(text) : value,
    );
  } catch {
    return ((pinnedReturn: unknown) => pinnedReturn)("[trace content truncated]");
  }
};
