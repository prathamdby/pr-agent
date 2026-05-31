import { MAX_LOG_MESSAGE_LEN } from "../settings/index.js";
import { redactOutboundSecrets } from "./redactOutboundSecrets.js";

const NUL = String.fromCharCode(0);

export function sanitizeLogMessage(raw: string): string {
  const withoutNul = raw.split(NUL).join("");
  return redactOutboundSecrets(withoutNul).slice(0, MAX_LOG_MESSAGE_LEN);
}
