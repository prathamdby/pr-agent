import { createHash } from "node:crypto";
import type { Config } from "../settings/index.js";
import type { TracePart, TracePartKind } from "./traceTypes.js";

const CREDENTIALS =
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----|(?:gh[pso]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|xox(?:[a-z]-|e\.)[A-Za-z0-9.-]+|AKIA[A-Z0-9]{16})/g;

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
    redact(text: string): { body: string; redactions: number } {
      let redactions = 0;
      let body = text;
      for (const secret of [...secrets].toSorted((a, b) => b.length - a.length)) {
        if (!body.includes(secret)) continue;
        const pieces = body.split(secret);
        redactions += pieces.length - 1;
        body = pieces.join("[redacted]");
      }
      body = body.replace(CREDENTIALS, () => {
        redactions += 1;
        return "[redacted]";
      });
      return { body, redactions };
    },
  };
}

export function tracePart(kind: TracePartKind, body: string, redactions: number): TracePart {
  return {
    kind,
    body,
    redactions,
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export function untrustedTraceFence(body: string): string {
  const runs = body.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}untrusted_trace\n${body}\n${fence}`;
}
