import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import { runFullPrTriage } from "../src/agent/triage/triageRun.js";
import {
  resetCreateFeaturePiSession,
  setCreateFeaturePiSession,
} from "../src/agent/runtime/createFeatureSession.js";
import {
  EMPTY_STRUCTURED_STATE,
  type PiSession,
  type PiSessionSendOptions,
} from "../src/agent/runtime/types.js";
import { makeTestConfig } from "./helpers/config.js";
import { isJsonString } from "../src/util/jsonValue.js";

const providerState = vi.hoisted(() => ({
  createSession: vi.fn(),
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

function fakeTriageSession(send: PiSession["send"]): PiSession {
  const session: PiSession = {
    role: "triage",
    primary: { provider: cfg.piProvider, model: cfg.piModel },
    send,
    abort: async () => undefined,
    dispose: async () => undefined,
    restartWithFallback: async () => session,
    getStructuredState: () => EMPTY_STRUCTURED_STATE,
    setStructuredState: () => undefined,
  };
  return session;
}

describe("triage run", () => {
  beforeEach(() => {
    setCreateFeaturePiSession(providerState.createSession);
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetCreateFeaturePiSession();
  });

  it("submits a validated triage payload", async () => {
    providerState.createSession.mockImplementation(async (params) =>
      fakeTriageSession(
        vi.fn(async () => {
          await params.executors.submitTriage({
            verdicts: [
              { verdict: "skipped", threadRootCommentId: 1, reason: "needs product call" },
            ],
          });
          return { text: "done" };
        }),
      ),
    );

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
    providerState.createSession.mockImplementation(async () =>
      fakeTriageSession(vi.fn(async () => ({ text: "I am done" }))),
    );

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
    const send = vi.fn(async (_prompt: string, _opts?: PiSessionSendOptions) => ({
      text: "I am done",
    }));
    providerState.createSession.mockImplementation(async () => fakeTriageSession(send));

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
    const finalizeCall = send.mock.calls.find((call) => {
      const prompt = call[0];
      return (
        isJsonString(prompt) &&
        prompt.includes("You replied with text only") &&
        prompt.includes("call commitFix") &&
        prompt.includes("call submitTriage once")
      );
    });
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
    providerState.createSession.mockImplementation(async (params) =>
      fakeTriageSession(
        vi.fn(async (prompt: string) => {
          if (prompt.includes("You replied with text only")) {
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
          if (prompt.includes("If needed")) {
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
      ),
    );

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
    providerState.createSession.mockImplementation(async (params) =>
      fakeTriageSession(
        vi.fn(async (prompt: string) => {
          if (prompt.includes("You replied with text only")) {
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
            } catch (cause) {
              errors.push(cause instanceof Error ? cause.message : String(cause));
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
      ),
    );

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
