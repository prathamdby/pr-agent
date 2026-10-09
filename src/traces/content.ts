import type { Config } from "../settings/index.js";
import { isPlainObject } from "../util/typeGuards.js";

const CREDENTIALS =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|(?:gh[pso]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk_(?:live|test)_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|xox(?:[a-z]-|e\.)[A-Za-z0-9.-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})|(?:postgres(?:ql)?|mysql):\/\/[^\s:]+:[^\s@]+@/gi;

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
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item, redact));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactTraceValue(item, redact)]),
    );
  }
  const text = JSON.stringify(value);
  return typeof text === "string" ? redact(text) : value;
}
