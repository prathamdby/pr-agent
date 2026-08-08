import type { AgentSessionRole, ModelAssignment } from "./types.js";

/** v1 prompt-cache retention owned by the Pi session seam. Always short. */
export type PromptCacheRetention = "short";

export type PromptCachePolicy = {
  readonly retention: PromptCacheRetention;
};

export const DEFAULT_PROMPT_CACHE_POLICY: PromptCachePolicy = {
  retention: "short",
};

/** OpenAI `prompt_cache_key` max length (pi-ai clamp). */
export const SESSION_CACHE_ID_MAX_LENGTH = 64;

export type AgentSessionCacheIdentity = {
  readonly role: AgentSessionRole;
  readonly specialistId?: string;
  readonly provider: string;
  readonly model: string;
};

/**
 * Build a stable in-memory session id for OpenAI-style prompt cache keys.
 * Same identity → same id. Clamped to provider key length; charset safe for
 * SessionManager ids (`[A-Za-z0-9._-]`).
 */
export function sessionCacheIdFromIdentity(identity: AgentSessionCacheIdentity): string {
  const specialist = identity.specialistId?.trim() || undefined;
  const raw = ["pragent", identity.role, specialist ?? "-", identity.provider, identity.model]
    .map(sanitizeSessionCacheIdPart)
    .join(".");
  if (raw.length <= SESSION_CACHE_ID_MAX_LENGTH) return raw;
  return raw.slice(0, SESSION_CACHE_ID_MAX_LENGTH).replace(/[._-]+$/g, "") || "pragent";
}

export function cacheIdentityFromAssignment(
  role: AgentSessionRole,
  assignment: ModelAssignment,
  specialistId?: string,
): AgentSessionCacheIdentity {
  return {
    role,
    ...(specialistId ? { specialistId } : {}),
    provider: assignment.provider,
    model: assignment.model,
  };
}

function sanitizeSessionCacheIdPart(part: string): string {
  const cleaned = part
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return cleaned.length > 0 ? cleaned : "x";
}
