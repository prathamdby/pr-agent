import { installationOctokit } from "./appAuth.js";

export type ReviewThreadResolution = {
  readonly threadNodeId: string;
  readonly isResolved: boolean;
};

type ReviewThreadNode = {
  readonly id?: unknown;
  readonly isResolved?: unknown;
  readonly comments?: {
    readonly nodes?: readonly {
      readonly fullDatabaseId?: unknown;
    }[];
  };
};

type ReviewThreadsPage = {
  readonly repository?: {
    readonly pullRequest?: {
      readonly reviewThreads?: {
        readonly pageInfo?: {
          readonly hasNextPage?: unknown;
          readonly endCursor?: unknown;
        };
        readonly nodes?: readonly ReviewThreadNode[];
      };
    };
  };
};

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) { nodes { fullDatabaseId } }
        }
      }
    }
  }
}
`;

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}
`;

function fullDatabaseId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function pageInfoValue(page: ReviewThreadsPage) {
  return page.repository?.pullRequest?.reviewThreads?.pageInfo;
}

export async function listReviewThreadResolution(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
): Promise<Map<number, ReviewThreadResolution>> {
  const octokit = installationOctokit(token, expiresAtTs);
  const byRootCommentId = new Map<number, ReviewThreadResolution>();
  let cursor: string | null = null;

  for (;;) {
    const page = (await octokit.graphql(REVIEW_THREADS_QUERY, {
      owner,
      repo,
      pr: prNumber,
      cursor,
    })) as ReviewThreadsPage;
    const threads = page.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    for (const thread of threads) {
      if (typeof thread.id !== "string" || typeof thread.isResolved !== "boolean") continue;
      const rootCommentId = fullDatabaseId(thread.comments?.nodes?.[0]?.fullDatabaseId);
      if (rootCommentId == null) continue;
      byRootCommentId.set(rootCommentId, {
        threadNodeId: thread.id,
        isResolved: thread.isResolved,
      });
    }

    const pageInfo = pageInfoValue(page);
    if (pageInfo?.hasNextPage !== true) break;
    cursor = typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
    if (!cursor) break;
  }

  return byRootCommentId;
}

export async function resolveReviewThread(
  token: string,
  threadNodeId: string,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  await octokit.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId: threadNodeId });
}
