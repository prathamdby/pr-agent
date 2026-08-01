import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import { runFullPrTriage } from "../src/agent/triage/triageRun.js";
import { makeTestConfig } from "./helpers/config.js";

const providerState = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock("../src/agent/runtime/createFeatureSession.js", () => ({
  createFeaturePiSession: providerState.createSession,
}));

const cfg = makeTestConfig();

function checkout(): WritablePrCheckout {
  return {
    dir: "/tmp/checkout",
    headRef: "main",
    baseSha: "a".repeat(40),
    commit: vi.fn(),
    push: vi.fn(),
    listCommittedShas: () => [],
    listCommittedDetails: () => [],
  };
}

const inventory = [
  {
    rootCommentId: 1,
    lens: "review" as const,
    path: "src/app.ts",
    line: 1,
    severity: "P2" as const,
    titleSnippet: "P2 · Bug",
    humanReplies: [],
    threadUrl: "https://github.test/thread",
  },
];

describe("triage run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits a validated triage payload", async () => {
    providerState.createSession.mockImplementation(async (params) => ({
      role: "triage",
      send: vi.fn(async () => {
        await params.executors.submitTriage({
          verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "needs product call" }],
        });
        return { text: "done" };
      }),
      abort: vi.fn(async () => undefined),
      setActiveTools: vi.fn(),
      restoreTools: vi.fn(),
      dispose: vi.fn(),
    }));

    const result = await runFullPrTriage({
      cfg,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(),
      inventory,
    });

    expect(result.submitted).toBe(true);
    expect(result.payload?.verdicts[0]?.verdict).toBe("skipped");
  });

  it("does not publish prose-only endings", async () => {
    providerState.createSession.mockImplementation(async () => ({
      role: "triage",
      send: vi.fn(async () => ({ text: "I am done" })),
      abort: vi.fn(async () => undefined),
      setActiveTools: vi.fn(),
      restoreTools: vi.fn(),
      dispose: vi.fn(),
    }));

    const result = await runFullPrTriage({
      cfg,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(),
      inventory,
    });

    expect(result.submitted).toBe(false);
    expect(result.payload).toBeNull();
  });

  it("pre-submit finalize keeps commitFix and caps tool rounds", async () => {
    const setActiveTools = vi.fn();
    const send = vi.fn(async () => ({ text: "I am done" }));
    providerState.createSession.mockImplementation(async () => ({
      role: "triage",
      send,
      abort: vi.fn(async () => undefined),
      setActiveTools,
      restoreTools: vi.fn(),
      dispose: vi.fn(),
    }));

    await runFullPrTriage({
      cfg,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(),
      inventory,
    });

    expect(send.mock.calls.length).toBeGreaterThan(1);
    const finalizeCall = send.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("commitFix") &&
        call[0].includes("submitTriage"),
    );
    expect(finalizeCall?.[1]).toMatchObject({
      phase: "triage",
      maxToolRounds: 32,
    });

    const finalizeToolSets = setActiveTools.mock.calls.map(
      (call) => (call[0] as { name: string }[]).map((tool) => tool.name),
    );
    expect(
      finalizeToolSets.some(
        (names) => names.includes("commitFix") && names.includes("submitTriage"),
      ),
    ).toBe(true);
  });
});
