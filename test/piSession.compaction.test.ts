import { describe, expect, it } from "vitest";
import {
  canCompactAtBoundary,
  structuredStateReinjectionPrompt,
} from "../src/agent/runtime/compactionPolicy.js";
import {
  createFakePiSession,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
} from "../src/agent/runtime/piSession.js";
import { makeTestConfig } from "./helpers/config.js";

describe("compaction policy", () => {
  it("requires a settled turn and no pending external mutation", () => {
    expect(
      canCompactAtBoundary({ turnSettled: false, pendingExternalMutation: false }).ok,
    ).toBe(false);
    expect(
      canCompactAtBoundary({ turnSettled: true, pendingExternalMutation: true }).ok,
    ).toBe(false);
    expect(
      canCompactAtBoundary({ turnSettled: true, pendingExternalMutation: false }).ok,
    ).toBe(true);
  });

  it("re-injects authoritative structured state and does not let summaries replace it", async () => {
    const authoritative = {
      version: 3,
      payload: {
        specialistReports: [{ specialist: "security", findingCount: 2 }],
        acceptedFindings: ["f1"],
        publishLedger: [{ step: "inline_review", status: "completed" }],
        phaseCheckpoint: "judgment-done",
        remainingWork: ["synthesis"],
      },
    };
    const { session, controls } = createFakePiSession({
      role: "orchestrator",
      primary: { provider: "openai", model: "gpt-4o-mini" },
      thinkingPolicy: DEFAULT_THINKING_POLICY,
      compactionPolicy: DEFAULT_COMPACTION_POLICY,
      toolPolicy: DEFAULT_TOOL_POLICY,
      structuredState: authoritative,
      systemPrompt: "test",
      eventSink: () => undefined,
      cfg: makeTestConfig(),
      tools: [],
      executors: {},
    });

    session.setExternalMutationPending(true);
    await expect(session.compactIfNeeded()).rejects.toThrow(/unresolved/);

    session.setExternalMutationPending(false);
    // Simulate a model-authored compaction summary trying to wipe state.
    session.setStructuredState({
      version: 3,
      payload: { ...authoritative.payload },
    });
    const compacted = await session.compactIfNeeded("threshold");
    expect(compacted).toBe(true);
    expect(controls.compactionCount()).toBe(1);
    expect(session.getStructuredState()).toEqual(authoritative);
    expect(structuredStateReinjectionPrompt(authoritative)).toContain("Authoritative structured state");
    expect(structuredStateReinjectionPrompt(authoritative)).toContain("specialistReports");
  });
});
