import type { Config } from "../settings/index.ts";
import { isPlainObject } from "../util/typeGuards.ts";

const CREDENTIALS =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|(?:gh[phorsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]{36}|sk_(?:live|test)_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|xox(?:[a-z]-|e\.)[A-Za-z0-9.-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\s:]+:[^\s@]+@/gi;

export function createTraceRedactor(
  cfg: Pick<Config, "github" | "models" | "webhook" | "runtime" | "context7" | "posthog">,
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
    cfg.context7.apiKey,
    cfg.posthog.projectToken,
  ].forEach(addSecret);
  return {
    addSecret,
    redact(text: string): string {
      let body = text;
      for (const secret of [...secrets].toSorted((a, b) => b.length - a.length)) {
        if (!body.includes(secret)) continue;
        body = body.split(secret).join("[redacted]");
      }
      return body.replace(CREDENTIALS, "[redacted]");
    },
  };
}

export function redactTraceValue(value: unknown, redact: (text: string) => string): unknown {
  return walkRedacted(value, redact, new WeakSet());
}

function walkRedacted(
  value: unknown,
  redact: (text: string) => string,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (typeof value !== "object") {
    try {
      const text = JSON.stringify(value);
      return typeof text === "string" ? redact(text) : value;
    } catch {
      return "[trace content truncated]";
    }
  }
  if (seen.has(value)) return "[trace content truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => walkRedacted(item, redact, seen));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, walkRedacted(item, redact, seen)]),
    );
  }
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? redact(text) : value;
  } catch {
    return "[trace content truncated]";
  }
}
