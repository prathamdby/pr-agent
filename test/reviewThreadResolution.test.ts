import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  graphql: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
    graphql: mocks.graphql,
  })),
}));

import {
  listReviewThreadResolution,
  resolveReviewThread,
} from "../src/github/reviewThreadResolution.js";

describe("review thread resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paginates thread resolution by root comment database id", async () => {
    mocks.graphql
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              nodes: [
                {
                  id: "node-1",
                  isResolved: false,
                  comments: { nodes: [{ fullDatabaseId: "123" }] },
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "node-2",
                  isResolved: true,
                  comments: { nodes: [{ fullDatabaseId: 456 }] },
                },
              ],
            },
          },
        },
      });

    const result = await listReviewThreadResolution("tok", "o", "r", 1);

    expect(result.get(123)).toEqual({ threadNodeId: "node-1", isResolved: false });
    expect(result.get(456)).toEqual({ threadNodeId: "node-2", isResolved: true });
    expect(mocks.graphql).toHaveBeenCalledTimes(2);
  });

  it("resolves review threads by GraphQL node id", async () => {
    mocks.graphql.mockResolvedValue({});

    await resolveReviewThread("tok", "node-1");

    expect(mocks.graphql.mock.calls[0]?.[1]).toEqual({ threadId: "node-1" });
  });
});
