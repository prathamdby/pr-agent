import { MAX_LOG_MESSAGE_LEN, MAX_LOG_REDACTION_SCAN_LEN } from "../settings/index.js";
import { redactOutboundSecrets } from "./redactOutboundSecrets.js";

const NUL = String.fromCharCode(0);
const PARTIAL_PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g;

function boundedRedactionInput(text: string): string {
  if (text.length <= MAX_LOG_REDACTION_SCAN_LEN) return text;
  // Secret patterns that need bytes beyond this cap are not fully scanned.
  return text.slice(0, MAX_LOG_REDACTION_SCAN_LEN).replace(PARTIAL_PRIVATE_KEY_RE, "[redacted]");
}

export function sanitizeLogMessage(raw: string): string {
  const withoutNul = raw.split(NUL).join("");
  return redactOutboundSecrets(boundedRedactionInput(withoutNul)).slice(0, MAX_LOG_MESSAGE_LEN);
}
