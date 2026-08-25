import { AppError } from "../errors/appError.js";
import {
  CONTEXT7_LIBRARY_ID_MAX_CHARS,
  CONTEXT7_LIBRARY_NAME_MAX_CHARS,
  CONTEXT7_QUERY_MAX_CHARS,
  CONTEXT7_TOPIC_MAX_CHARS,
} from "../settings/index.js";
import { redactOutboundSecrets } from "./redactOutboundSecrets.js";

export const CONTEXT7_LIBRARY_NAME_PATTERN =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$/;
export const CONTEXT7_LIBRARY_ID_PATTERN =
  /^\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})+$/;

export type Context7OutboundTextField = "query" | "topic";

type Context7PolicyReason =
  | "invalid_identifier"
  | "too_long"
  | "control_character"
  | "secret_shaped_content"
  | "url_content"
  | "prompt_content"
  | "repository_content"
  | "conversation_content";

const URL_PATTERN =
  /(?:\b(?:https?|ftp|file):\/\/|\b(?:blob|data|javascript|mailto):|\bwww\.|%[0-9a-f]{2})/i;
const BARE_HOST_PATTERN =
  /(?:\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}[a-z]{2,}\b|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z]{2,}[/:?#][^\s]*)/i;
const PROMPT_CONTENT_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,48}\b(?:previous|prior|above|system|developer)\b[\s\S]{0,48}\b(?:instructions?|rules?|prompt)\b/i,
  /<\s*\/?\s*(?:system|developer|user|assistant|tool|prompt|instructions?|user_question|thread_transcript)\b/i,
  /\b(?:begin|end)\s+(?:system|developer|user|assistant|tool|prompt|context|instructions?)\b/i,
  /\b(?:system|developer|user|assistant|tool|user_question|thread_transcript)\s*[:_]/i,
  /\b(?:you are|act as|roleplay as)\s+(?:an?\s+)?(?:assistant|system|developer|chatgpt|bot)\b/i,
  /\btool\s+output\b/i,
];
const REPOSITORY_CONTENT_PATTERNS: readonly RegExp[] = [
  /```|\/\*|\*\/|(?:^|\s)\/\//,
  /\b(?:diff --git|git\s+(?:diff|show|log|status)|index\s+[0-9a-f]{7,}|@@\s*-\d)/i,
  /(?:^|\s)(?:import|export|const|let|var|function|class|interface|type)\s+[A-Za-z_$]/m,
  /(?:^|\s)(?:src|test|tests|lib|app|docs)\/[^\s]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|py|go|rs|java|rb|php)\b/i,
  /(?:^|\s)(?:package\.json|(?:pnpm|npm|yarn)[-]lock\.(?:yaml|yml|json)|\.env(?:\.[^\s]+)?|[^\s/]+\.(?:pem|key))\b/i,
];
const CONVERSATION_CONTENT_PATTERNS: readonly RegExp[] = [
  /<!--|-->/,
  /(?:^|\s)>\s/m,
  /\b(?:pull\s+request|pr\s+comment|review\s+comment|issue\s+comment|thread\s+transcript|conversation)\b/i,
  /\bpr\s*#?\d+\b/i,
  /\b(?:reviewer|author|maintainer)\s*:/i,
  /(?:^|\s)@[A-Za-z0-9][A-Za-z0-9_-]*/,
];

function rejectContext7Input(field: string, reason: Context7PolicyReason): never {
  throw new AppError({
    code: "context7.outbound_policy_rejected",
    message: `Context7 ${field} rejected: ${reason.replaceAll("_", " ")}`,
    context: { field, reason },
  });
}

export function assertContext7LibraryName(value: string): string {
  if (
    value.length > CONTEXT7_LIBRARY_NAME_MAX_CHARS ||
    !CONTEXT7_LIBRARY_NAME_PATTERN.test(value)
  ) {
    rejectContext7Input("libraryName", "invalid_identifier");
  }
  return value;
}

export function assertContext7LibraryId(value: string): string {
  if (value.length > CONTEXT7_LIBRARY_ID_MAX_CHARS || !CONTEXT7_LIBRARY_ID_PATTERN.test(value)) {
    rejectContext7Input("libraryId", "invalid_identifier");
  }
  return value;
}

function maxLengthFor(field: Context7OutboundTextField): number {
  return field === "query" ? CONTEXT7_QUERY_MAX_CHARS : CONTEXT7_TOPIC_MAX_CHARS;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function prepareContext7OutboundText(
  field: Context7OutboundTextField,
  value: string,
  apiKey: string = "",
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > maxLengthFor(field)) rejectContext7Input(field, "too_long");
  if (containsControlCharacter(trimmed)) {
    rejectContext7Input(field, "control_character");
  }

  const normalizedApiKey = apiKey.trim();
  if (normalizedApiKey && trimmed.includes(normalizedApiKey)) {
    rejectContext7Input(field, "secret_shaped_content");
  }
  const redacted = redactOutboundSecrets(trimmed);
  if (redacted !== trimmed) rejectContext7Input(field, "secret_shaped_content");
  if (URL_PATTERN.test(trimmed) || BARE_HOST_PATTERN.test(trimmed)) {
    rejectContext7Input(field, "url_content");
  }
  if (PROMPT_CONTENT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    rejectContext7Input(field, "prompt_content");
  }
  if (REPOSITORY_CONTENT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    rejectContext7Input(field, "repository_content");
  }
  if (CONVERSATION_CONTENT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    rejectContext7Input(field, "conversation_content");
  }
  return redacted;
}

/** Scrub provider-returned text so an echoed API key cannot reach logs or tools. */
export function redactContext7Response(text: string, apiKey: string): string {
  const normalizedApiKey = apiKey.trim();
  const withoutApiKey =
    normalizedApiKey.length > 0 ? text.split(normalizedApiKey).join("[redacted]") : text;
  return redactOutboundSecrets(withoutApiKey);
}
