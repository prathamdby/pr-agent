import { runFeatureAgent } from "../src/agent/runtime/featureAgent.js";
import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import { createFakePiSession } from "../src/agent/runtime/fakePiSession.js";
import { makeTestConfig } from "./helpers/config.js";
import { runValidationRepairLoop } from "../src/agent/runtime/featureAgent.js";
import { describe, expect, it } from "vitest";
import {
  buildSubmitTriageTool,
  createSubmitTriageState,
} from "../src/agent/triage/submitTriageTool.js";
import type { TriageWorkspaceToolState } from "../src/agent/triage/triageWorkspaceTools.js";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";

function inventoryThread(): BotFindingThread {
  return {
    rootCommentId: 1,
    lens: "review",
    path: "src/a.ts",
    line: 1,
    severity: "P1",
    titleSnippet: "Guard the missing value",
    humanReplies: [],
    threadUrl: "https://example.com/threads/1",
  };
}

function buildTool(thread: BotFindingThread = inventoryThread()) {
  const submitState = createSubmitTriageState();
  const checkout = { listCommittedShas: () => [] } as unknown as WritablePrCheckout;
  const workspaceState = {
    commitByThreadRootCommentId: new Map(),
  } as unknown as TriageWorkspaceToolState;
  const tool = buildSubmitTriageTool({
    owner: "o",
    repo: "r",
    prNumber: 1,
    inventory: [thread],
    checkout,
    workspaceState,
    submitState,
  });
  return { ...tool, submitState };
}

const skippedVerdict = { verdict: "skipped", threadRootCommentId: 1, reason: "later" };
const dismissedVerdict = {
  verdict: "dismissed",
  threadRootCommentId: 1,
  evidence: "false positive",
};

describe("submitTriage tool", () => {
  it("accepts a valid verdict payload", async () => {
    const { executor, submitState } = buildTool();

    await expect(executor({ verdicts: [skippedVerdict] })).resolves.toEqual({ ok: true });
    expect(submitState.payload?.verdicts).toEqual([skippedVerdict]);
  });

  it("repairs a stringified verdicts array at the parse seam", async () => {
    const { executor, submitState } = buildTool();

    await expect(executor({ verdicts: JSON.stringify([skippedVerdict]) })).resolves.toEqual({
      ok: true,
    });
    expect(submitState.payload?.verdicts).toEqual([skippedVerdict]);
  });

  it("rejects unrepairable payloads with the formatted issue list", async () => {
    const { executor, submitState } = buildTool();

    await expect(executor({ verdicts: "not json" })).rejects.toMatchObject({
      code: "triage.validation_failed",
    });
    expect(submitState.lastValidationError).toContain("verdicts");
  });

  it("rejects dismissal from an unauthorized reply", async () => {
    const { executor, submitState } = buildTool({
      ...inventoryThread(),
      humanReplies: ["false positive"],
      untrustedReplies: ["false positive"],
      authorizedReplies: [],
    });

    await expect(executor({ verdicts: [dismissedVerdict] })).rejects.toMatchObject({
      code: "triage.validation_failed",
    });
    expect(submitState.lastValidationError).toContain("authorized maintainer decision");
  });

  it("accepts dismissal only with a server-authorized reply", async () => {
    const { executor } = buildTool({
      ...inventoryThread(),
      humanReplies: ["false positive"],
      authorizedReplies: ["false positive"],
      untrustedReplies: [],
    });

    await expect(executor({ verdicts: [dismissedVerdict] })).resolves.toEqual({ ok: true });
  });
});

// Failure mode: cap-aborted repairs must not erase the diagnostic.
describe("feature submit repair", () => {
  it.each(["verification", "description", "triage"])(
    "%s retains the error after the final capped repair",
    async () => {
      let error: string | null = "invalid payload";
      let calls = 0;
      await runValidationRepairLoop({
        rounds: 2,
        shouldContinue: () => true,
        getValidationError: () => error,
        clearValidationError: () => {
          error = null;
        },
        restoreValidationError: (value: string) => {
          error = value;
        },
        repair: async () => {
          calls++;
        },
      });
      expect(error).toBe("invalid payload");
      expect(calls).toBe(2);
    },
  );
});

import {
  buildSubmitVerificationTool,
  createSubmitVerificationState,
} from "../src/agent/verification/submitVerificationTool.js";

function verificationInventoryThread(): BotFindingThread {
  return {
    rootCommentId: 1,
    lens: "review",
    path: "src/a.ts",
    line: 1,
    severity: "P1",
    titleSnippet: "Guard the missing value",
    humanReplies: [],
    threadUrl: "https://example.com/threads/1",
  };
}

function buildVerificationFixture(thread: BotFindingThread = verificationInventoryThread()) {
  const submitState = createSubmitVerificationState();
  const tool = buildSubmitVerificationTool({
    owner: "o",
    repo: "r",
    prNumber: 1,
    inventory: [thread],
    pushedShas: [],
    submitState,
  });
  return { ...tool, submitState };
}

const verificationSkippedVerdict = { verdict: "skipped", threadRootCommentId: 1, reason: "later" };
const verificationDismissedVerdict = {
  verdict: "dismissed",
  threadRootCommentId: 1,
  evidence: "intentional",
};

describe("submitVerification tool", () => {
  it("accepts a valid verdict payload", async () => {
    const { executor, submitState } = buildVerificationFixture();

    await expect(executor({ verdicts: [verificationSkippedVerdict] })).resolves.toEqual({
      ok: true,
    });
    expect(submitState.payload?.verdicts).toEqual([verificationSkippedVerdict]);
  });

  it("repairs a stringified verdicts array at the parse seam", async () => {
    const { executor, submitState } = buildVerificationFixture();

    await expect(
      executor({ verdicts: JSON.stringify([verificationSkippedVerdict]) }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(submitState.payload?.verdicts).toEqual([verificationSkippedVerdict]);
  });

  it("rejects unrepairable payloads with the formatted issue list", async () => {
    const { executor, submitState } = buildVerificationFixture();

    await expect(executor({ verdicts: "not json" })).rejects.toMatchObject({
      code: "verification.validation_failed",
    });
    expect(submitState.lastValidationError).toContain("verdicts");
  });

  it("rejects dismissal from an unauthorized reply", async () => {
    const { executor, submitState } = buildVerificationFixture({
      ...verificationInventoryThread(),
      humanReplies: ["intentional"],
      untrustedReplies: ["intentional"],
      authorizedReplies: [],
    });

    await expect(executor({ verdicts: [verificationDismissedVerdict] })).rejects.toMatchObject({
      code: "verification.validation_failed",
    });
    expect(submitState.lastValidationError).toContain("authorized maintainer decision");
  });

  it("accepts dismissal only with a server-authorized reply", async () => {
    const { executor } = buildVerificationFixture({
      ...verificationInventoryThread(),
      humanReplies: ["intentional"],
      authorizedReplies: ["intentional"],
      untrustedReplies: [],
    });

    await expect(executor({ verdicts: [verificationDismissedVerdict] })).resolves.toEqual({
      ok: true,
    });
  });

  it("validates against only the bound inventory and reports dropped threads", async () => {
    const { executor, submitState } = buildVerificationFixture({
      ...verificationInventoryThread(),
      rootCommentId: 2,
    });

    await expect(executor({ verdicts: [verificationSkippedVerdict] })).rejects.toMatchObject({
      code: "verification.validation_failed",
    });
    expect(submitState.lastValidationError).toContain("1 is not in the verification inventory");
    expect(submitState.lastValidationError).toContain("2 is missing a verdict");

    await expect(
      executor({ verdicts: [{ verdict: "skipped", threadRootCommentId: 2, reason: "later" }] }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("injected feature agent", () => {
  it.each(["verification", "description", "triage"] as const)(
    "%s preserves repair budgets and disposes the injected adapter",
    async (role) => {
      const state = { lastValidationError: "invalid payload", payload: null };
      let fake: ReturnType<typeof createFakePiSession> | undefined;
      const result = await runFeatureAgent(
        {
          state,
          shouldContinue: () => true,
          userContent: "investigate",
          investigation: { phase: role, checkpointId: `${role}:${role}`, maxToolRounds: 32 },
          finalize: {
            phase: role,
            checkpointId: `${role}:${role}`,
            maxToolRounds: role === "triage" ? 32 : 4,
          },
          nudge: "submit now",
          nudgeRounds: 1,
          repairRounds: 2,
          repairPrompt: (error) => error,
        },
        {
          session: {
            role,
            cfg: makeTestConfig(),
            systemPrompt: "system",
            tools: [],
            executors: {},
          },
          createSession: (params) =>
            createFeaturePiSession({
              ...params,
              createSession: (options) => {
                fake = createFakePiSession(options);
                return fake.session;
              },
            }),
        },
      );
      expect(state.lastValidationError).toBe("invalid payload");
      expect(result.lastText).toBe("");
      expect(fake?.controls.sends).toHaveLength(6);
      expect(fake?.controls.sends[0]?.opts.maxToolRounds).toBe(32);
      expect(
        fake?.controls.sends
          .slice(1)
          .every(({ opts }) => opts.maxToolRounds === (role === "triage" ? 32 : 4)),
      ).toBe(true);
      await expect(
        fake?.session.send("late", { phase: role, checkpointId: "late" }),
      ).rejects.toMatchObject({ code: "runtime.session_disposed" });
    },
  );
});
