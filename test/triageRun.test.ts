import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunnerProvider } from "../src/agent/providers/interface.js";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import { runFullPrTriage } from "../src/agent/triage/triageRun.js";
import { makeTestConfig } from "./helpers/config.js";

const providerState = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock("../src/agent/providers/index.js", () => ({
  resolveAgentRunnerProvider: vi.fn(
    () =>
      ({
        createSession: providerState.createSession,
      }) satisfies AgentRunnerProvider,
  ),
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
      send: vi.fn(async () => {
        await params.executors.submitTriage({
          verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "needs product call" }],
        });
        return { text: "done" };
      }),
      restrictToTools: vi.fn(),
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
      send: vi.fn(async () => ({ text: "I am done" })),
      restrictToTools: vi.fn(),
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
});
