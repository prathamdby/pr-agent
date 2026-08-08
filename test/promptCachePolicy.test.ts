import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_CACHE_POLICY,
  SESSION_CACHE_ID_MAX_LENGTH,
  cacheIdentityFromAssignment,
  sessionCacheIdFromIdentity,
} from "../src/agent/runtime/promptCachePolicy.js";

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
    expect(a).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
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
      cacheIdentityFromAssignment(
        "specialist",
        { provider: "openai", model: "gpt-5" },
        "security",
      ),
    );
    const orchestrator = sessionCacheIdFromIdentity(
      cacheIdentityFromAssignment("orchestrator", { provider: "openai", model: "gpt-5" }),
    );
    expect(correctness).not.toBe(security);
    expect(correctness).not.toBe(orchestrator);
  });

  it("clamps oversized identities to the OpenAI key length", () => {
    const id = sessionCacheIdFromIdentity({
      role: "specialist",
      specialistId: "correctness",
      provider: "a".repeat(40),
      model: "b".repeat(40),
    });
    expect(id.length).toBeLessThanOrEqual(SESSION_CACHE_ID_MAX_LENGTH);
    expect(id).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
  });
});
