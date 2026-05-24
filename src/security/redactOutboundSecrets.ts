import { BOT_SECRET_PATTERNS } from "../settings/index.js";

export function redactOutboundSecrets(text: string): string {
  let out = text;
  for (const pattern of BOT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}
