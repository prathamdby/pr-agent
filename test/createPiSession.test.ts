import { describe, expect, it } from "vitest";
import { makeTestConfig } from "./helpers/config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheIdentityFromAssignment,
  sessionCacheIdFromIdentity,
  specialistSharedCacheId,
  SESSION_CACHE_ID_MAX_LENGTH,
} from "../src/agent/runtime/promptCachePolicy.ts";
import { createPiSession } from "../src/agent/runtime/piSession.ts";
import { DEFAULT_THINKING_POLICY, DEFAULT_TOOL_POLICY } from "../src/agent/runtime/types.ts";
import { DEFAULT_PROMPT_CACHE_POLICY } from "../src/agent/runtime/promptCachePolicy.ts";
import { compactionPolicyForRole } from "../src/agent/runtime/compactionPolicy.ts";

describe("session cache identity", () => {
  it("derives a stable cache id from the assignment", () => {
    const identity = cacheIdentityFromAssignment("specialist", {
      provider: "stub",
      model: "stub-model",
    });
    const first = sessionCacheIdFromIdentity(identity);
    const second = sessionCacheIdFromIdentity(identity);
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(SESSION_CACHE_ID_MAX_LENGTH);
  });

  it("produces a shared cache id for specialists on one assignment", () => {
    const shared = specialistSharedCacheId(
      cacheIdentityFromAssignment("specialist", {
        provider: "stub",
        model: "stub-model",
      }),
    );
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.length).toBeLessThanOrEqual(SESSION_CACHE_ID_MAX_LENGTH);
  });
});

describe("createPiSession facade", () => {
  it("creates a durable session behind the shared runtime", async () => {
    const sqliteDir = mkdtempSync(join(tmpdir(), "pr-agent-sqlite-"));
    try {
      const cfg = makeTestConfig({ runtime: { sqliteDir } });
      const session = await createPiSession({
        cfg,
        role: "ask",
        primary: { provider: "stub", model: "stub-model" },
        thinkingPolicy: DEFAULT_THINKING_POLICY,
        compactionPolicy: compactionPolicyForRole("ask"),
        promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
        toolPolicy: DEFAULT_TOOL_POLICY,
        systemPrompt: "system",
        eventSink: () => {},
        tools: [],
        executors: {},
        codemode: false,
      });
      expect(session.role).toBe("ask");
      await session.abort();
      await session.dispose();
    } finally {
      rmSync(sqliteDir, { recursive: true, force: true });
    }
  });
});
