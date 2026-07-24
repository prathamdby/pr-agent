import { describe, expect, it } from "vitest";
import { agentAuditRecordFromLifecycleEvent } from "../src/agent/runtime/agentAudit.js";
import { sanitizeAgentLifecycleEvent } from "../src/agent/runtime/lifecycleSanitizer.js";

describe("sanitizeAgentLifecycleEvent", () => {
  it("allows allowlisted turn fields", () => {
    const event = sanitizeAgentLifecycleEvent({
      kind: "turn",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "cp-1",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(event).toEqual({
      kind: "turn",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "cp-1",
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("rejects prompts, model text, tool payloads, and credentials", () => {
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "turn",
        role: "ask",
        phase: "ask",
        checkpointId: "cp",
        provider: "openai",
        model: "gpt-4o-mini",
        prompt: "secret user prompt",
      }),
    ).toBeNull();

    expect(
      sanitizeAgentLifecycleEvent({
        kind: "completion",
        role: "ask",
        provider: "openai",
        model: "gpt-4o-mini",
        text: "model answer",
        ok: true,
      }),
    ).toBeNull();

    expect(
      sanitizeAgentLifecycleEvent({
        kind: "tool",
        role: "specialist",
        toolName: "readFile",
        provider: "openai",
        model: "gpt-4o-mini",
        arguments: { path: "src/secret.ts" },
      }),
    ).toBeNull();

    expect(
      sanitizeAgentLifecycleEvent({
        kind: "failure",
        role: "ask",
        provider: "openai",
        model: "gpt-4o-mini",
        failureCode: "provider.auth",
        token: "sk-live",
        ok: false,
      }),
    ).toBeNull();
  });

  it("rejects free-form exception messages as failure codes", () => {
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "failure",
        role: "ask",
        provider: "openai",
        model: "gpt-4o-mini",
        failureCode: "ENOENT: no such file /repo/src/auth.ts",
        ok: false,
      }),
    ).toBeNull();
  });
});

describe("agentAuditRecordFromLifecycleEvent", () => {
  it("derives metadata-only audit records without content fields", () => {
    const record = agentAuditRecordFromLifecycleEvent(
      {
        kind: "failure",
        role: "specialist",
        phase: "specialist",
        checkpointId: "cp-9",
        provider: "openai",
        model: "gpt-4o-mini",
        ok: false,
        failureCode: "provider.rate_limit",
        failureDomain: "provider",
        errorKind: "rate_limit",
      },
      () => new Date("2026-07-23T00:00:00.000Z"),
    );
    expect(record).toEqual({
      source: "agent_lifecycle",
      kind: "failure",
      role: "specialist",
      phase: "specialist",
      checkpointId: "cp-9",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: false,
      failureCode: "provider.rate_limit",
      failureDomain: "provider",
      errorKind: "rate_limit",
      recordedAt: "2026-07-23T00:00:00.000Z",
    });
    expect(JSON.stringify(record)).not.toMatch(/prompt|reasoning|sk-|diff|toolCall/i);
  });
});
