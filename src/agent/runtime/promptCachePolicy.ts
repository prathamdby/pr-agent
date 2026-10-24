import { createHash } from "node:crypto";
import { specialistSharedPrefix } from "../../prompts/shared/prefix.ts";
import { SESSION_CACHE_ID_MAX_LENGTH } from "../../settings/index.ts";
import type { AgentSessionRole, ModelAssignment } from "./types.ts";

export { SESSION_CACHE_ID_MAX_LENGTH };

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
  return {
    role,
    ...(specialistId ? { specialistId } : {}),
    provider: assignment.provider,
    model: assignment.model,
  };
}

const ANTHROPIC_CACHE_MARKER_LIMIT = 4;
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export function systemPromptStartsWithSpecialistPrefix(systemPrompt: string): boolean {
  return specialistSharedPrefix.length > 0 && systemPrompt.startsWith(specialistSharedPrefix);
}

export function specialistSharedCacheId(identity: AgentSessionCacheIdentity): string {
  return sessionCacheIdFromIdentity({ ...identity, specialistId: "shared" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") return undefined;
  return value.text;
}

function withText(block: Record<string, unknown>, text: string): Record<string, unknown> {
  return { ...block, type: "text", text };
}

function withoutCacheControl(block: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(block, "cache_control")) return block;
  const next = { ...block };
  delete next.cache_control;
  return next;
}

function cacheMarkerCount(value: unknown): number {
  if (Array.isArray(value)) {
    let count = 0;
    for (const item of value) count += cacheMarkerCount(item);
    return count;
  }
  if (!isRecord(value)) return 0;
  let count = value.cache_control == null ? 0 : 1;
  for (const [key, child] of Object.entries(value)) {
    if (key === "cache_control") continue;
    count += cacheMarkerCount(child);
  }
  return count;
}

export function splitAnthropicSystemBlocks(params: unknown, prefix: string): unknown {
  if (!isRecord(params) || !Array.isArray(params.system)) return params;
  const system = params.system;
  if (system.some((block) => textOf(block) === prefix)) return params;
  const promptIndex = system.findIndex((block) => {
    const text = textOf(block);
    return text != null && text.startsWith(`${prefix}\n\n`) && text.length > prefix.length + 2;
  });
  if (promptIndex < 0) return params;
  const promptText = textOf(system[promptIndex]);
  const promptBlock = system[promptIndex];
  if (promptText == null || !isRecord(promptBlock)) return params;
  if (system.some((block) => textOf(block) == null)) return params;
  const extraText = system.filter((block, index) => index !== promptIndex);
  if (extraText.length > 1) return params;
  if (extraText.length === 1 && textOf(extraText[0]) !== CLAUDE_CODE_IDENTITY) return params;
  const body = promptText.slice(prefix.length + 2);
  const prefixBlock = withText(promptBlock, prefix);
  const bodyBlock = withText(promptBlock, body);
  let nextSystem: unknown[] = system.flatMap((block, index) =>
    index === promptIndex ? [prefixBlock, bodyBlock] : [block],
  );
  let next: Record<string, unknown> = { ...params, system: nextSystem };
  if (cacheMarkerCount(next) > ANTHROPIC_CACHE_MARKER_LIMIT) {
    nextSystem = nextSystem.map((block) =>
      isRecord(block) && textOf(block) === CLAUDE_CODE_IDENTITY
        ? withoutCacheControl(block)
        : block,
    );
    next = { ...next, system: nextSystem };
  }
  if (cacheMarkerCount(next) > ANTHROPIC_CACHE_MARKER_LIMIT) {
    nextSystem = nextSystem.map((block) =>
      isRecord(block) && textOf(block) === body ? withoutCacheControl(block) : block,
    );
    next = { ...next, system: nextSystem };
  }
  return next;
}

function sanitizeSessionCacheIdPart(part: string): string {
  const cleaned = part
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return cleaned.length > 0 ? cleaned : "x";
}
