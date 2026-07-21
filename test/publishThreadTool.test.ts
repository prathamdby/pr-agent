import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { buildPublishThreadTool } from "../src/review/orchestrator/publishThreadTool.js";
import { createThreadPublishRunState } from "../src/review/publish/threadPublishRunState.js";
import { makeTestConfig } from "./helpers/config.js";
import { testTokenHandle } from "./helpers/tokenHandle.js";

const publishFindingBatch = vi.fn();

vi.mock("../src/review/publish/publishFindingBatch.js", () => ({
  publishFindingBatch: (...args: unknown[]) => publishFindingBatch(...args),
}));

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: "P1",
  file: "src/a.ts",
  startLine: 4,
  endLine: 4,
  title: "Bug A",
  detail: "Detail A",
  fixPrompt: "Fix A",
  ...overrides,
});

describe("publishThreadTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("threads runState across consecutive calls (fingerprint accumulation)", async () => {
    const runState = createThreadPublishRunState();
    runState.postedFingerprints.add("fp-existing");

    publishFindingBatch
      .mockResolvedValueOnce({
        kind: "published",
        reviewId: 10,
        posted: 1,
        suppressed: 0,
        dropped: 0,
      })
      .mockResolvedValueOnce({ kind: "empty" });

    const token = testTokenHandle({ token: "tok-1" });
    const { executor } = buildPublishThreadTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token,
      recordPublishStep: vi.fn(async () => undefined),
      runState,
      abortGate: async () => "continue" as const,
    });

    const first = await executor({ findings: [finding()] });
    expect(first).toEqual({
      accepted: true,
      value: expect.objectContaining({
        kind: "published",
        reviewId: 10,
        posted: 1,
      }),
    });
    expect(publishFindingBatch).toHaveBeenCalledWith(
      [finding()],
      expect.objectContaining({ runState, token }),
    );

    runState.postedFingerprints.add("fp-from-batch");
    const second = await executor({
      findings: [finding({ file: "src/b.ts", title: "Bug B" })],
    });
    expect(second).toEqual({
      accepted: true,
      value: expect.objectContaining({ kind: "empty" }),
    });
    expect(publishFindingBatch.mock.calls[1]?.[1].runState).toBe(runState);
    expect(runState.postedFingerprints.has("fp-existing")).toBe(true);
    expect(runState.postedFingerprints.has("fp-from-batch")).toBe(true);
  });

  it("returns same-file published-thread overlap hints in the accepted envelope", async () => {
    const runState = createThreadPublishRunState({
      acceptedFindings: [
        finding({ file: "src/a.ts", title: "Prior A", startLine: 2, endLine: 2 }),
        finding({ file: "src/other.ts", title: "Other", startLine: 1, endLine: 1 }),
      ],
    });
    publishFindingBatch.mockResolvedValueOnce({
      kind: "published",
      reviewId: 11,
      posted: 1,
      suppressed: 0,
      dropped: 0,
    });

    const { executor } = buildPublishThreadTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token: testTokenHandle(),
      recordPublishStep: vi.fn(async () => undefined),
      runState,
      abortGate: async () => "continue" as const,
    });

    const result = await executor({
      findings: [finding({ file: "src/a.ts", title: "New A", startLine: 8, endLine: 8 })],
    });
    expect(result).toEqual({
      accepted: true,
      value: expect.objectContaining({
        kind: "published",
        sameFilePublishedThreads: [
          expect.objectContaining({
            file: "src/a.ts",
            title: "Prior A",
            startLine: 2,
            endLine: 2,
          }),
        ],
      }),
    });
  });

  it("treats zero-thread judgment (empty batch) as valid", async () => {
    publishFindingBatch.mockResolvedValueOnce({ kind: "empty" });
    const runState = createThreadPublishRunState();
    const { executor } = buildPublishThreadTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token: testTokenHandle(),
      recordPublishStep: vi.fn(async () => undefined),
      runState,
      abortGate: async () => "continue" as const,
    });

    await expect(executor({ findings: [] })).resolves.toEqual({
      accepted: true,
      value: expect.objectContaining({ kind: "empty" }),
    });
  });

  it("converts budget_exhausted findings into accepted summary-only state", async () => {
    const runState = createThreadPublishRunState();
    const batchFinding = finding({ title: "Late finding" });
    publishFindingBatch.mockImplementationOnce(async (batch, context) => {
      for (const item of batch) {
        context.runState.acceptedFindings.push(item);
      }
      return { kind: "budget_exhausted" };
    });

    const { executor } = buildPublishThreadTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token: testTokenHandle(),
      recordPublishStep: vi.fn(async () => undefined),
      runState,
      abortGate: async () => "continue" as const,
    });

    const result = await executor({ findings: [batchFinding] });
    expect(result).toEqual({
      accepted: true,
      value: expect.objectContaining({
        kind: "budget_exhausted",
        acceptedAsSummaryOnly: true,
      }),
    });
    expect(runState.acceptedFindings).toEqual([batchFinding]);
  });

  it("passes InstallationTokenHandle and abortGate through to publishFindingBatch", async () => {
    publishFindingBatch.mockResolvedValueOnce({ kind: "empty" });
    const token = testTokenHandle({ token: "tok-live" });
    const abortGate = vi.fn(async () => "continue" as const);

    const { executor } = buildPublishThreadTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token,
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState(),
      abortGate,
    });

    await executor({ findings: [finding()] });
    expect(publishFindingBatch).toHaveBeenCalledWith(
      [finding()],
      expect.objectContaining({ token, abortGate }),
    );
  });

  it("returns rejected envelope on validation failure", async () => {
    const { executor, getLastError } = buildPublishThreadTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token: testTokenHandle(),
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState(),
      abortGate: async () => "continue" as const,
    });

    const result = await executor({ findings: [{ severity: "P1" }] });
    expect(result).toEqual({
      accepted: false,
      error: expect.stringContaining("validation"),
    });
    expect(getLastError()).toEqual(expect.stringContaining("validation"));
    expect(publishFindingBatch).not.toHaveBeenCalled();
  });
});
