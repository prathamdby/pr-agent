import {
  BOT_SECRET_PATTERNS,
  MAX_LOG_MESSAGE_LEN,
  MAX_LOG_REDACTION_SCAN_LEN,
} from "./settings.js";

export function redactOutboundSecrets(text: string): string {
  let out = text;
  for (const pattern of BOT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

const NUL = String.fromCharCode(0);
const PARTIAL_PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g;

function boundedRedactionInput(text: string): string {
  if (text.length <= MAX_LOG_REDACTION_SCAN_LEN) return text;
  return text.slice(0, MAX_LOG_REDACTION_SCAN_LEN).replace(PARTIAL_PRIVATE_KEY_RE, "[redacted]");
}

export function sanitizeLogMessage(raw: string): string {
  const withoutNul = raw.split(NUL).join("");
  return redactOutboundSecrets(boundedRedactionInput(withoutNul)).slice(0, MAX_LOG_MESSAGE_LEN);
}
