import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  graphql: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
    graphql: mocks.graphql,
  })),
}));

vi.mock("../src/evlog.js", () => ({
  logWarn: mocks.logWarn,
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  listReviewThreadResolution,
  resolveReviewThread,
  warnReviewThreadResolutionDegraded,
} from "../src/github/reviewThreadResolution.js";
import { MAX_REVIEW_THREAD_PAGES } from "../src/settings/index.js";

function page(params: {
  readonly hasNextPage?: boolean;
  readonly endCursor?: string | null;
  readonly nodes: readonly unknown[];
}) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: {
            hasNextPage: params.hasNextPage ?? false,
            endCursor: params.endCursor ?? null,
          },
          nodes: params.nodes,
        },
      },
    },
  };
}

describe("review thread resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paginates thread resolution by root comment database id", async () => {
    mocks.graphql
      .mockResolvedValueOnce(
        page({
          hasNextPage: true,
          endCursor: "c1",
          nodes: [
            {
              id: "node-1",
              isResolved: false,
              comments: { nodes: [{ fullDatabaseId: "123" }] },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        page({
          nodes: [
            {
              id: "node-2",
              isResolved: true,
              comments: { nodes: [{ fullDatabaseId: 456 }] },
            },
          ],
        }),
      );

    const result = await listReviewThreadResolution("tok", "o", "r", 1);

    expect(result.status).toBe("ok");
    expect(result.byRootCommentId.get(123)).toEqual({
      threadNodeId: "node-1",
      isResolved: false,
    });
    expect(result.byRootCommentId.get(456)).toEqual({
      threadNodeId: "node-2",
      isResolved: true,
    });
    expect(mocks.graphql).toHaveBeenCalledTimes(2);
  });

  it("classifies reviewThreads 403 as permission_denied without throwing", async () => {
    mocks.graphql.mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), {
        name: "GraphqlResponseError",
        status: 403,
      }),
    );

    const result = await listReviewThreadResolution("tok", "o", "r", 1);

    expect(result.status).toBe("permission_denied");
    expect(result.byRootCommentId.size).toBe(0);
    expect(result.warning).toMatch(/reviewThreads/i);
    expect(result.warning).toMatch(/permission/i);
  });

  it("returns partial data when pagination fails after the first page", async () => {
    mocks.graphql
      .mockResolvedValueOnce(
        page({
          hasNextPage: true,
          endCursor: "c1",
          nodes: [
            {
              id: "node-1",
              isResolved: false,
              comments: { nodes: [{ fullDatabaseId: 1 }] },
            },
          ],
        }),
      )
      .mockRejectedValue(new Error("socket hang up"));

    const result = await listReviewThreadResolution("tok", "o", "r", 1);

    expect(result.status).toBe("partial");
    expect(result.byRootCommentId.get(1)).toEqual({
      threadNodeId: "node-1",
      isResolved: false,
    });
    expect(result.warning).toMatch(/pagination failed/i);
  });

  it("marks malformed GraphQL payloads as unavailable", async () => {
    mocks.graphql.mockResolvedValue("not-an-object");

    const result = await listReviewThreadResolution("tok", "o", "r", 1);

    expect(result.status).toBe("unavailable");
    expect(result.byRootCommentId.size).toBe(0);
    expect(result.warning).toMatch(/malformed/i);
  });

  it("skips malformed thread nodes and reports partial when some are usable", async () => {
    mocks.graphql.mockResolvedValue(
      page({
        nodes: [
          { id: 99, isResolved: false, comments: { nodes: [{ fullDatabaseId: 1 }] } },
          {
            id: "node-ok",
            isResolved: true,
            comments: { nodes: [{ fullDatabaseId: 2 }] },
          },
        ],
      }),
    );

    const result = await listReviewThreadResolution("tok", "o", "r", 1);

    expect(result.status).toBe("partial");
    expect(result.byRootCommentId.get(2)).toEqual({
      threadNodeId: "node-ok",
      isResolved: true,
    });
    expect(result.byRootCommentId.has(1)).toBe(false);
  });

  it("resolves review threads by GraphQL node id", async () => {
    mocks.graphql.mockResolvedValue({});

    await resolveReviewThread("tok", "node-1");

    expect(mocks.graphql.mock.calls[0]?.[1]).toEqual({ threadId: "node-1" });
  });

  it("warnReviewThreadResolutionDegraded logs once for non-ok status", () => {
    warnReviewThreadResolutionDegraded(
      {
        byRootCommentId: new Map(),
        status: "permission_denied",
        warning: "grant permission",
      },
      { workItemId: "wi-1" },
    );

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "review_threads_resolution_degraded",
      expect.objectContaining({
        workItemId: "wi-1",
        status: "permission_denied",
        warning: "grant permission",
      }),
    );
  });

  it("caps reviewThreads pagination and reports truncated partial coverage", async () => {
    mocks.graphql.mockImplementation(async (_query: string, vars: { cursor?: string | null }) => {
      const pageIndex = vars.cursor == null ? 0 : Number(String(vars.cursor).replace("c", "")) + 1;
      return page({
        hasNextPage: true,
        endCursor: `c${pageIndex}`,
        nodes: [
          {
            id: `node-${pageIndex}`,
            isResolved: false,
            comments: { nodes: [{ fullDatabaseId: pageIndex + 1 }] },
          },
        ],
      });
    });

    const result = await listReviewThreadResolution("tok", "o", "r", 1);

    expect(result.status).toBe("partial");
    expect(result.truncated).toBe(true);
    expect(result.warning).toMatch(/capped/i);
    expect(mocks.graphql).toHaveBeenCalledTimes(MAX_REVIEW_THREAD_PAGES);
    expect(result.byRootCommentId.size).toBe(MAX_REVIEW_THREAD_PAGES);
  });
});
