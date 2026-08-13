import { createHash } from "node:crypto";
import { SESSION_CACHE_ID_MAX_LENGTH } from "../../settings/index.js";
import type { AgentSessionRole, ModelAssignment } from "./types.js";

export { SESSION_CACHE_ID_MAX_LENGTH };

/** v1 prompt-cache retention owned by the Pi session seam. Always short. */
export type PromptCacheRetention = "short";

export type PromptCachePolicy = {
  readonly retention: PromptCacheRetention;
};

export const DEFAULT_PROMPT_CACHE_POLICY: PromptCachePolicy = {
  retention: "short",
};

export type AgentSessionCacheIdentity = {
  readonly role: AgentSessionRole;
  readonly specialistId?: string;
  readonly provider: string;
  readonly model: string;
};

type MutableAgentSessionCacheIdentity = {
  -readonly [K in keyof AgentSessionCacheIdentity]: AgentSessionCacheIdentity[K];
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
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const prefixBudget = SESSION_CACHE_ID_MAX_LENGTH - digest.length - 1;
  const prefix = raw.slice(0, Math.max(prefixBudget, 0)).replace(/[._-]+$/g, "");
  const clamped = prefix.length > 0 ? `${prefix}.${digest}` : digest;
  return clamped.slice(0, SESSION_CACHE_ID_MAX_LENGTH) || "pragent";
}

export function cacheIdentityFromAssignment(
  role: AgentSessionRole,
  assignment: ModelAssignment,
  specialistId?: string,
): AgentSessionCacheIdentity {
  const identity: MutableAgentSessionCacheIdentity = {
    role,
    provider: assignment.provider,
    model: assignment.model,
  };
  if (specialistId) identity.specialistId = specialistId;
  return identity;
}

function sanitizeSessionCacheIdPart(part: string): string {
  const cleaned = part
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return cleaned.length > 0 ? cleaned : "x";
}
