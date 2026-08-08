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

  it("pre-submit finalize keeps commitFix nudge and caps tool rounds", async () => {
    const send = vi.fn(async (_prompt: string, _opts?: Record<string, unknown>) => ({
      text: "I am done",
    }));
    providerState.createSession.mockImplementation(async () => ({
      role: "triage",
      send,
      abort: vi.fn(async () => undefined),
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
        call[0].includes("You replied with text only") &&
        call[0].includes("call commitFix") &&
        call[0].includes("call submitTriage once"),
    );
    expect(finalizeCall?.[1]).toMatchObject({
      phase: "triage",
      checkpointId: "triage:triage",
      maxToolRounds: 32,
    });
  });

  it("validation-repair can commitFix then resubmit after a failed submitTriage", async () => {
    let submitAttempts = 0;
    const committed: string[] = [];
    const commit = vi.fn(async () => {
      const sha = "c".repeat(40);
      committed.push(sha);
      return { sha, diff: "diff --git a/x" };
    });
    providerState.createSession.mockImplementation(async (params) => ({
      role: "triage",
      send: vi.fn(async (prompt: string) => {
        if (typeof prompt === "string" && prompt.includes("You replied with text only")) {
          submitAttempts += 1;
          try {
            await params.executors.submitTriage({
              verdicts: [
                {
                  verdict: "fixed",
                  threadRootCommentId: 1,
                  commitSha: "d".repeat(40),
                  evidence: "claimed fix without commit",
                },
              ],
            });
          } catch {
            /* validation error recorded on submitState */
          }
          return { text: "nudge" };
        }
        if (typeof prompt === "string" && prompt.includes("If needed")) {
          await params.executors.commitFix({
            threadRootCommentId: 1,
            files: ["src/app.ts"],
            subject: "fix: app",
          });
          submitAttempts += 1;
          await params.executors.submitTriage({
            verdicts: [
              {
                verdict: "fixed",
                threadRootCommentId: 1,
                commitSha: "c".repeat(40),
                evidence: "committed the fix",
              },
            ],
          });
          return { text: "repaired" };
        }
        return { text: "investigate" };
      }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }));

    const result = await runFullPrTriage({
      cfg,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: {
        ...checkout(),
        commit,
        listCommittedShas: () => committed,
      },
      inventory,
    });

    expect(submitAttempts).toBeGreaterThanOrEqual(2);
    expect(commit).toHaveBeenCalled();
    expect(result.submitted).toBe(true);
    expect(result.commitByThreadRootCommentId.get(1)).toBe("c".repeat(40));
  });

  it("duplicate commitFix rejects without failing the finalize run", async () => {
    const committed: string[] = [];
    const commit = vi.fn(async () => {
      const sha = "c".repeat(40);
      committed.push(sha);
      return { sha, diff: "diff" };
    });
    const errors: string[] = [];
    providerState.createSession.mockImplementation(async (params) => ({
      role: "triage",
      send: vi.fn(async (prompt: string) => {
        if (typeof prompt === "string" && prompt.includes("You replied with text only")) {
          await params.executors.commitFix({
            threadRootCommentId: 1,
            files: ["src/app.ts"],
            subject: "fix: app",
          });
          try {
            await params.executors.commitFix({
              threadRootCommentId: 1,
              files: ["src/app.ts"],
              subject: "fix: app again",
            });
          } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
          }
          await params.executors.submitTriage({
            verdicts: [
              {
                verdict: "fixed",
                threadRootCommentId: 1,
                commitSha: "c".repeat(40),
                evidence: "one commit is enough",
              },
            ],
          });
          return { text: "done" };
        }
        return { text: "investigate" };
      }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }));

    const result = await runFullPrTriage({
      cfg,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: {
        ...checkout(),
        commit,
        listCommittedShas: () => committed,
      },
      inventory,
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(errors.some((msg) => msg.includes("already called") || msg.includes("duplicate"))).toBe(
      true,
    );
    expect(result.submitted).toBe(true);
  });
});
