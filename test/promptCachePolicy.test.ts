import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_CACHE_POLICY,
  SESSION_CACHE_ID_MAX_LENGTH,
  cacheIdentityFromAssignment,
  sessionCacheIdFromIdentity,
} from "../src/agent/runtime/promptCachePolicy.js";
import type { AgentSessionRole } from "../src/agent/runtime/types.js";
import { SPECIALIST_IDS } from "../src/review/orchestrator/orchestratorTypes.js";

const ROLES: readonly AgentSessionRole[] = [
  "orchestrator",
  "specialist",
  "ask",
  "description",
  "triage",
  "verification",
  "ci_summary",
];

const MODEL_PAIRS = [
  { provider: "openai", model: "gpt-5" },
  { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  { provider: "openai", model: "ft:gpt-4o-mini:org:name:abcdefghijklmnopqrstuvwxyz" },
] as const;

const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

describe("promptCachePolicy", () => {
  it("defaults retention to short", () => {
    expect(DEFAULT_PROMPT_CACHE_POLICY).toEqual({ retention: "short" });
  });

  it("builds a stable session cache id for the same identity", () => {
    const identity = cacheIdentityFromAssignment(
      "specialist",
      { provider: "openai", model: "gpt-5" },
      "correctness",
    );
    const a = sessionCacheIdFromIdentity(identity);
    const b = sessionCacheIdFromIdentity(identity);
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(SESSION_CACHE_ID_MAX_LENGTH);
    expect(a).toMatch(SESSION_ID_RE);
  });

  it("differentiates specialist ids and roles", () => {
    const correctness = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment(
        "specialist",
        { provider: "openai", model: "gpt-5" },
        "correctness",
      ),
    );
    const security = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment("specialist", { provider: "openai", model: "gpt-5" }, "security"),
    );
    const orchestrator = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment("orchestrator", { provider: "openai", model: "gpt-5" }),
    );
    expect(correctness).not.toBe(security);
    expect(correctness).not.toBe(orchestrator);
  });

  it("clamps oversized identities without collapsing distinct tails", () => {
    const left = sessionCacheIdFromIdentity({
      role: "specialist",
      specialistId: "correctness",
      provider: "a".repeat(40),
      model: "b".repeat(40),
    });
    const right = sessionCacheIdFromIdentity({
      role: "specialist",
      specialistId: "correctness",
      provider: "a".repeat(40),
      model: `${"b".repeat(39)}c`,
    });
    expect(left.length).toBeLessThanOrEqual(SESSION_CACHE_ID_MAX_LENGTH);
    expect(right.length).toBeLessThanOrEqual(SESSION_CACHE_ID_MAX_LENGTH);
    expect(left).toMatch(SESSION_ID_RE);
    expect(right).toMatch(SESSION_ID_RE);
    expect(left).not.toBe(right);
  });

  it("keeps unique charset-safe ids across the identity space", () => {
    const ids = new Set<string>();
    for (const role of ROLES) {
      const specialistIds = role === "specialist" ? SPECIALIST_IDS : ([undefined] as const);
      for (const specialistId of specialistIds) {
        for (const pair of MODEL_PAIRS) {
          const id = sessionCacheIdFromIdentity(
            cacheIdentityFromAssignment(role, pair, specialistId),
          );
          expect(id.length).toBeLessThanOrEqual(SESSION_CACHE_ID_MAX_LENGTH);
          expect(id).toMatch(SESSION_ID_RE);
          expect(ids.has(id)).toBe(false);
          ids.add(id);
        }
      }
    }
  });

  it("treats whitespace-only specialistId as absent and sanitizes punctuation", () => {
    const absent = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment("specialist", { provider: "openai", model: "gpt-5" }),
    );
    const whitespace = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment("specialist", { provider: "openai", model: "gpt-5" }, "   "),
    );
    const punctuated = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment("specialist", { provider: "openai", model: "gpt-5" }, "A/B!"),
    );
    expect(whitespace).toBe(absent);
    expect(punctuated).toMatch(SESSION_ID_RE);
    expect(punctuated).toContain("A-B");
  });
});
