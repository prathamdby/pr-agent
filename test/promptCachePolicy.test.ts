import { describe, expect, it } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createSessionStreamFn } from "../src/agent/runtime/sessionStream.ts";
import {
  DEFAULT_PROMPT_CACHE_POLICY,
  SESSION_CACHE_ID_MAX_LENGTH,
  cacheIdentityFromAssignment,
  comparePromptCacheSections,
  promptCacheSections,
  sessionCacheIdFromIdentity,
  sessionRecordsPromptCacheBreak,
  specialistSharedCacheId,
  splitAnthropicSystemBlocks,
  type PromptCacheBreak,
} from "../src/agent/runtime/promptCachePolicy.ts";
import { buildAutomatedSystemPrompt } from "../src/prompts/correctness/prompt.ts";
import { specialistSharedPrefix } from "../src/prompts/shared/prefix.ts";
import type { AgentSessionRole } from "../src/agent/runtime/types.ts";
import { SPECIALIST_IDS } from "../src/review/orchestrator/orchestratorTypes.ts";

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

  it("splits one Anthropic system block at the specialist prefix", () => {
    const prefix = "SHARED";
    const body = "You are the correctness specialist.";
    const text = `${prefix}\n\n${body}`;
    const marker = { type: "ephemeral" };
    const params = {
      system: [{ type: "text", text, cache_control: marker }],
      tools: [{ name: "execute" }],
      messages: [{ role: "user", content: "Review." }],
    };
    const split = splitAnthropicSystemBlocks(params, prefix);
    expect(split).toEqual({
      system: [
        { type: "text", text: prefix, cache_control: marker },
        { type: "text", text: body, cache_control: marker },
      ],
      tools: params.tools,
      messages: params.messages,
    });
    expect(split).not.toBe(params);
    if (isRecord(split)) {
      expect(split.tools).toBe(params.tools);
      expect(split.messages).toBe(params.messages);
    }
    const absent = { system: [{ type: "text", text: "other prompt", cache_control: marker }] };
    expect(splitAnthropicSystemBlocks(absent, prefix)).toBe(absent);
    const already = {
      system: [
        { type: "text", text: prefix, cache_control: marker },
        { type: "text", text: body, cache_control: marker },
      ],
    };
    expect(splitAnthropicSystemBlocks(already, prefix)).toBe(already);
    const notArray = { system: "SHARED" };
    expect(splitAnthropicSystemBlocks(notArray, prefix)).toBe(notArray);
    const real = {
      system: [
        {
          type: "text",
          text: buildAutomatedSystemPrompt(),
          cache_control: marker,
        },
      ],
      tools: [{ name: "execute" }],
    };
    const realSplit = splitAnthropicSystemBlocks(real, specialistSharedPrefix);
    const realSystem = systemBlocks(realSplit);
    expect(realSystem?.map((block) => block.text)).toEqual([
      specialistSharedPrefix,
      buildAutomatedSystemPrompt().slice(specialistSharedPrefix.length + 2),
    ]);
    expect(realSystem?.map((block) => block.text).join("\n\n")).toBe(buildAutomatedSystemPrompt());
    expect(realSystem?.[0]?.cache_control).toEqual(marker);
  });

  it("keeps the prefix cache marker when the payload already has four", () => {
    const prefix = "SHARED";
    const body = "You are the security specialist.";
    const marker = { type: "ephemeral" };
    const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
    const withIdentity = {
      system: [
        { type: "text", text: identity, cache_control: marker },
        { type: "text", text: `${prefix}\n\n${body}`, cache_control: marker },
      ],
      messages: [{ cache_control: marker }],
      tools: [{ cache_control: marker }],
    };
    const identitySplit = splitAnthropicSystemBlocks(withIdentity, prefix);
    expect(cacheMarkerCount(identitySplit)).toBe(4);
    expect(systemBlocks(identitySplit)?.[1]).toMatchObject({
      text: prefix,
      cache_control: marker,
    });
    expect(systemBlocks(identitySplit)?.[0]).toEqual({ type: "text", text: identity });
    const full = {
      system: [{ type: "text", text: `${prefix}\n\n${body}`, cache_control: marker }],
      messages: [{ cache_control: marker }],
      tools: [{ cache_control: marker }, { cache_control: marker }],
    };
    const fullSplit = splitAnthropicSystemBlocks(full, prefix);
    expect(cacheMarkerCount(fullSplit)).toBe(4);
    expect(systemBlocks(fullSplit)).toEqual([
      { type: "text", text: prefix, cache_control: marker },
      { type: "text", text: body },
    ]);
    if (isRecord(fullSplit)) {
      expect(fullSplit.tools).toBe(full.tools);
      expect(fullSplit.messages).toBe(full.messages);
    }
  });

  it("uses one shared cache id for prefixed specialist sessions", () => {
    const pair = { provider: "openai", model: "gpt-5" } as const;
    const ids = SPECIALIST_IDS.map((specialistId) =>
      specialistSharedCacheId(cacheIdentityFromAssignment("specialist", pair, specialistId)),
    );
    expect(new Set(ids).size).toBe(1);
    const shared = ids[0];
    expect(shared).toBeDefined();
    expect(shared).not.toBe(
      sessionCacheIdFromIdentity(cacheIdentityFromAssignment("specialist", pair, "correctness")),
    );
    expect(shared).not.toBe(
      sessionCacheIdFromIdentity(cacheIdentityFromAssignment("orchestrator", pair)),
    );
    expect(SPECIALIST_IDS).not.toContain("shared");
  });

  it("names the section and byte of the first cache difference", () => {
    const tools = [{ name: "execute", description: "run" }];
    const history = [{ role: "user", text: "hello" }];
    const base = promptCacheSections({
      systemText: `${specialistSharedPrefix}\n\nrole body`,
      tools,
      history,
    });
    const roleBody = promptCacheSections({
      systemText: `${specialistSharedPrefix}\n\nrolX body`,
      tools,
      history,
    });
    expect(comparePromptCacheSections(base, roleBody)).toEqual({ section: "role_body", byte: 3 });

    const prefix = specialistSharedPrefix;
    const changedPrefix = `${prefix.slice(0, 4)}X${prefix.slice(5)}`;
    const sharedPrefix = promptCacheSections({
      systemText: `${changedPrefix}\n\nrole body`,
      tools,
      history,
    });
    expect(comparePromptCacheSections(base, sharedPrefix)).toEqual({
      section: "shared_prefix",
      byte: 4,
    });

    const toolChange = promptCacheSections({
      systemText: `${prefix}\n\nrole body`,
      tools: [{ name: "execute", description: "ruX" }],
      history,
    });
    const toolByte = Buffer.from(base.tool_definitions).indexOf(Buffer.from("run"));
    expect(comparePromptCacheSections(base, toolChange)).toEqual({
      section: "tool_definitions",
      byte: toolByte + 2,
    });

    const historyChange = promptCacheSections({
      systemText: `${prefix}\n\nrole body`,
      tools,
      history: [{ role: "user", text: "hXllo" }],
    });
    const historyByte = Buffer.from(base.history).indexOf(Buffer.from("hello"));
    expect(comparePromptCacheSections(base, historyChange)).toEqual({
      section: "history",
      byte: historyByte + 1,
    });

    const appended = promptCacheSections({
      systemText: `${prefix}\n\nrole body`,
      tools,
      history: [...history, { role: "assistant", text: "next" }],
    });
    expect(comparePromptCacheSections(base, appended)).toEqual({
      section: "append_only",
      byte: null,
    });
  });

  it("records a cache break on the second request only", () => {
    const recorded: PromptCacheBreak[] = [];
    const session = createSessionStreamFn({ streamSimple: () => ({}) } as never, {
      cacheRetention: "short",
      sessionId: "session",
      timeoutMs: 1,
      maxRetries: 0,
      maxRetryDelayMs: 0,
      recordCacheBreak: (observed) => recorded.push(observed),
    });
    const context = (roleBody: string) =>
      normalizeContext({
        systemPrompt: `${specialistSharedPrefix}\n\n${roleBody}`,
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [],
      });
    session.streamFn({} as never, context("alpha"), undefined);
    expect(recorded).toEqual([]);
    session.streamFn({} as never, context("alXha"), undefined);
    expect(recorded).toEqual([{ section: "role_body", byte: 2 }]);
    expect(JSON.stringify(recorded)).not.toContain("alXha");
    expect(JSON.stringify(recorded)).not.toContain(specialistSharedPrefix);
  });

  it("skips cache-break recording outside review sessions", () => {
    expect(sessionRecordsPromptCacheBreak("specialist")).toBe(true);
    expect(sessionRecordsPromptCacheBreak("orchestrator")).toBe(true);
    expect(sessionRecordsPromptCacheBreak("ask")).toBe(false);
    expect(sessionRecordsPromptCacheBreak("triage")).toBe(false);
    expect(sessionRecordsPromptCacheBreak("description")).toBe(false);
    expect(sessionRecordsPromptCacheBreak("verification")).toBe(false);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function systemBlocks(
  value: unknown,
): Array<{ text?: string; cache_control?: unknown }> | undefined {
  if (!isRecord(value) || !Array.isArray(value.system)) return undefined;
  return value.system.filter(isRecord);
}

function cacheMarkerCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + cacheMarkerCount(item), 0);
  if (!isRecord(value)) return 0;
  let count = value.cache_control == null ? 0 : 1;
  for (const [key, child] of Object.entries(value)) {
    if (key === "cache_control") continue;
    count += cacheMarkerCount(child);
  }
  return count;
}
