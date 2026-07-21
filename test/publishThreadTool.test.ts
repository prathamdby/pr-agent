import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import {
  createThreadPublishRunState,
  buildPublishThreadTool,
} from "../src/review/orchestrator/publishThreadTool.js";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

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

    const getToken = vi.fn(() => "tok-1");
    const { executor } = buildPublishThreadTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      getToken,
      getTokenExpiresAtTs: () => Date.now() + 3_600_000,
      recordPublishStep: vi.fn(async () => undefined),
      runState,
    });

    const first = await executor({ findings: [finding()] });
    expect(first).toEqual(
      expect.objectContaining({
        kind: "published",
        reviewId: 10,
        posted: 1,
      }),
    );
    expect(publishFindingBatch).toHaveBeenCalledWith(
      [finding()],
      expect.objectContaining({ runState, getToken }),
    );

    runState.postedFingerprints.add("fp-from-batch");
    const second = await executor({
      findings: [finding({ file: "src/b.ts", title: "Bug B" })],
    });
    expect(second).toEqual(expect.objectContaining({ kind: "empty" }));
    expect(publishFindingBatch.mock.calls[1]?.[1].runState).toBe(runState);
    expect(runState.postedFingerprints.has("fp-existing")).toBe(true);
    expect(runState.postedFingerprints.has("fp-from-batch")).toBe(true);
  });

  it("returns same-file published-thread overlap hints", async () => {
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
      getToken: () => "tok",
      recordPublishStep: vi.fn(async () => undefined),
      runState,
    });

    const result = await executor({
      findings: [finding({ file: "src/a.ts", title: "New A", startLine: 8, endLine: 8 })],
    });
    expect(result).toEqual(
      expect.objectContaining({
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
    );
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
      getToken: () => "tok",
      recordPublishStep: vi.fn(async () => undefined),
      runState,
    });

    await expect(executor({ findings: [] })).resolves.toEqual(
      expect.objectContaining({ kind: "empty" }),
    );
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
      getToken: () => "tok",
      recordPublishStep: vi.fn(async () => undefined),
      runState,
    });

    const result = await executor({ findings: [batchFinding] });
    expect(result).toEqual(
      expect.objectContaining({
        kind: "budget_exhausted",
        acceptedAsSummaryOnly: true,
      }),
    );
    expect(runState.acceptedFindings).toEqual([batchFinding]);
  });

  it("reads getToken live and refreshes when near expiry before publish", async () => {
    const expiresAt = Date.now() + TOKEN_FRESHNESS_BUFFER_MS / 2;
    let token = "stale-tok";
    const refreshInstallationToken = vi.fn(async () => {
      token = "fresh-tok";
      return { token, expiresAtTs: Date.now() + 3_600_000 };
    });
    publishFindingBatch.mockImplementationOnce(async (_batch, context) => {
      expect(context.getToken()).toBe("fresh-tok");
      return { kind: "empty" };
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
      getToken: () => token,
      getTokenExpiresAtTs: () => expiresAt,
      refreshInstallationToken,
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState(),
    });

    await executor({ findings: [finding()] });
    expect(refreshInstallationToken).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the token is still fresh", async () => {
    const refreshInstallationToken = vi.fn(async () => ({
      token: "fresh",
      expiresAtTs: Date.now() + 3_600_000,
    }));
    publishFindingBatch.mockResolvedValueOnce({ kind: "empty" });

    const { executor } = buildPublishThreadTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      getToken: () => "tok",
      getTokenExpiresAtTs: () => Date.now() + 3_600_000,
      refreshInstallationToken,
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState(),
    });

    await executor({ findings: [finding()] });
    expect(refreshInstallationToken).not.toHaveBeenCalled();
  });
});
