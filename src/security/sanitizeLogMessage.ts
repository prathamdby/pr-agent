import { MAX_LOG_MESSAGE_LEN } from "../settings/index.js";

export function sanitizeLogMessage(raw: string): string {
  return raw
    .split("\u0000")
    .join("")
    .replace(/\b[Aa]uthorization\s*:\s*.+/gi, "Authorization: [redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .slice(0, MAX_LOG_MESSAGE_LEN);
}
