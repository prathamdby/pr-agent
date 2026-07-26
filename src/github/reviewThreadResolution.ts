import { logWarn } from "../evlog.js";
import { installationOctokit } from "./appAuth.js";
import { classifyGithubError } from "./githubErrors.js";

export type ReviewThreadResolution = {
  readonly threadNodeId: string;
  readonly isResolved: boolean;
};

export type ReviewThreadResolutionStatus =
  | "ok"
  | "permission_denied"
  | "partial"
  | "unavailable";

export type ListReviewThreadResolutionResult = {
  readonly byRootCommentId: Map<number, ReviewThreadResolution>;
  readonly status: ReviewThreadResolutionStatus;
  /** One actionable warning when resolution is incomplete or unavailable. */
  readonly warning?: string;
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

const PERMISSION_WARNING =
  "GitHub App lacks Pull requests → read access required for reviewThreads GraphQL. " +
  "Verification continues without thread-resolution; grant the permission to restore resolve/dismiss actions.";

function fullDatabaseId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function isReviewThreadsPage(value: unknown): value is ReviewThreadsPage {
  return typeof value === "object" && value != null;
}

function ingestThreadsPage(
  page: ReviewThreadsPage,
  byRootCommentId: Map<number, ReviewThreadResolution>,
): { readonly hasNextPage: boolean; readonly endCursor: string | null; readonly sawMalformed: boolean } {
  const connection = page.repository?.pullRequest?.reviewThreads;
  if (connection == null) {
    return { hasNextPage: false, endCursor: null, sawMalformed: page.repository?.pullRequest == null };
  }

  let sawMalformed = false;
  const threads = connection.nodes;
  if (threads != null && !Array.isArray(threads)) {
    return { hasNextPage: false, endCursor: null, sawMalformed: true };
  }

  for (const thread of threads ?? []) {
    if (typeof thread.id !== "string" || typeof thread.isResolved !== "boolean") {
      sawMalformed = true;
      continue;
    }
    const rootCommentId = fullDatabaseId(thread.comments?.nodes?.[0]?.fullDatabaseId);
    if (rootCommentId == null) {
      sawMalformed = true;
      continue;
    }
    byRootCommentId.set(rootCommentId, {
      threadNodeId: thread.id,
      isResolved: thread.isResolved,
    });
  }

  const pageInfo = connection.pageInfo;
  const hasNextPage = pageInfo?.hasNextPage === true;
  const endCursor = typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor : null;
  return { hasNextPage, endCursor, sawMalformed };
}

function permissionDeniedResult(
  byRootCommentId: Map<number, ReviewThreadResolution>,
): ListReviewThreadResolutionResult {
  return {
    byRootCommentId,
    status: "permission_denied",
    warning: PERMISSION_WARNING,
  };
}

export async function listReviewThreadResolution(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
): Promise<ListReviewThreadResolutionResult> {
  const octokit = installationOctokit(token, expiresAtTs);
  const byRootCommentId = new Map<number, ReviewThreadResolution>();
  let cursor: string | null = null;
  let sawMalformed = false;

  for (;;) {
    let page: unknown;
    try {
      page = await octokit.graphql(REVIEW_THREADS_QUERY, {
        owner,
        repo,
        pr: prNumber,
        cursor,
      });
    } catch (error) {
      const kind = classifyGithubError(error);
      if (kind === "forbidden") {
        return permissionDeniedResult(byRootCommentId);
      }
      if (byRootCommentId.size > 0) {
        return {
          byRootCommentId,
          status: "partial",
          warning:
            "reviewThreads GraphQL pagination failed mid-fetch; continuing with partial resolution data.",
        };
      }
      return {
        byRootCommentId,
        status: "unavailable",
        warning: "reviewThreads GraphQL failed; continuing without thread-resolution data.",
      };
    }

    if (!isReviewThreadsPage(page)) {
      return {
        byRootCommentId,
        status: "unavailable",
        warning: "reviewThreads GraphQL returned a malformed response; continuing without resolution.",
      };
    }

    const ingested = ingestThreadsPage(page, byRootCommentId);
    sawMalformed = sawMalformed || ingested.sawMalformed;
    if (!ingested.hasNextPage) break;
    if (!ingested.endCursor) {
      return {
        byRootCommentId,
        status: "partial",
        warning:
          "reviewThreads GraphQL reported another page without an endCursor; stopping pagination.",
      };
    }
    cursor = ingested.endCursor;
  }

  if (sawMalformed && byRootCommentId.size === 0) {
    return {
      byRootCommentId,
      status: "unavailable",
      warning: "reviewThreads GraphQL returned malformed thread nodes; continuing without resolution.",
    };
  }

  if (sawMalformed) {
    return {
      byRootCommentId,
      status: "partial",
      warning: "reviewThreads GraphQL included malformed thread nodes; using partial resolution data.",
    };
  }

  return { byRootCommentId, status: "ok" };
}

export async function resolveReviewThread(
  token: string,
  threadNodeId: string,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  await octokit.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId: threadNodeId });
}

/** Log at most one resolution-permission warning for a verification/triage run. */
export function warnReviewThreadResolutionDegraded(
  result: ListReviewThreadResolutionResult,
  context: Record<string, unknown>,
): void {
  if (result.status === "ok" || result.warning == null) return;
  logWarn("review_threads_resolution_degraded", {
    ...context,
    status: result.status,
    warning: result.warning,
  });
}
