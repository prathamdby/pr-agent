import * as v from "valibot";
import { nonErrorThrown } from "../errors/appError.js";
import { logWarn } from "../evlog.js";
import { MAX_REVIEW_THREAD_PAGES } from "../settings/index.js";
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../util/jsonValue.js";
import { installationOctokit } from "./appAuth.js";
import { classifyGithubError } from "./githubErrors.js";

export type ReviewThreadResolution = {
  readonly threadNodeId: string;
  readonly isResolved: boolean;
};

export type ReviewThreadResolutionStatus = "ok" | "permission_denied" | "partial" | "unavailable";

export type ListReviewThreadResolutionResult = {
  readonly byRootCommentId: Map<number, ReviewThreadResolution>;
  readonly status: ReviewThreadResolutionStatus;
  /** True when pagination stopped at MAX_REVIEW_THREAD_PAGES with more pages remaining. */
  readonly truncated?: boolean;
  /** One actionable warning when resolution is incomplete or unavailable. */
  readonly warning?: string;
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

function fullDatabaseId(value: JsonValue): number | null {
  if (isJsonNumber(value) && Number.isSafeInteger(value)) return value;
  if (isJsonString(value) && /^\d+$/.test(value)) return Number(value);
  return null;
}

function isReviewThreadsPage(value: JsonValue): value is JsonObject {
  return isJsonObject(value);
}

type IngestThreadsPageResult = {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly sawMalformed: boolean;
};

function ingestThreadsPage(
  page: JsonObject,
  byRootCommentId: Map<number, ReviewThreadResolution>,
): IngestThreadsPageResult {
  const repositoryValue = page.repository;
  if (repositoryValue === undefined) {
    return { hasNextPage: false, endCursor: null, sawMalformed: true };
  }
  if (!isJsonObject(repositoryValue)) {
    return { hasNextPage: false, endCursor: null, sawMalformed: true };
  }
  const pullRequestValue = repositoryValue.pullRequest;
  if (pullRequestValue === undefined) {
    return { hasNextPage: false, endCursor: null, sawMalformed: true };
  }
  if (!isJsonObject(pullRequestValue)) {
    return { hasNextPage: false, endCursor: null, sawMalformed: true };
  }
  const connectionValue = pullRequestValue.reviewThreads;
  if (connectionValue === undefined) {
    return { hasNextPage: false, endCursor: null, sawMalformed: false };
  }
  if (!isJsonObject(connectionValue)) {
    return { hasNextPage: false, endCursor: null, sawMalformed: true };
  }

  const threads = connectionValue.nodes;
  if (threads != null && !Array.isArray(threads)) {
    return { hasNextPage: false, endCursor: null, sawMalformed: true };
  }

  let sawMalformed = false;
  for (const thread of threads ?? []) {
    if (!isJsonObject(thread)) {
      sawMalformed = true;
      continue;
    }
    const threadId = thread.id;
    const isResolved = thread.isResolved;
    if (
      threadId === undefined ||
      isResolved === undefined ||
      !isJsonString(threadId) ||
      !isJsonBoolean(isResolved)
    ) {
      sawMalformed = true;
      continue;
    }
    const comments = thread.comments;
    let rootCommentId: number | null = null;
    if (comments !== undefined && isJsonObject(comments) && Array.isArray(comments.nodes)) {
      const first = comments.nodes[0];
      if (isJsonObject(first) && first.fullDatabaseId !== undefined) {
        rootCommentId = fullDatabaseId(first.fullDatabaseId);
      }
    }
    if (rootCommentId == null) {
      sawMalformed = true;
      continue;
    }
    byRootCommentId.set(rootCommentId, {
      threadNodeId: threadId,
      isResolved,
    });
  }

  const pageInfo = connectionValue.pageInfo;
  let hasNextPage = false;
  let endCursor: string | null = null;
  if (pageInfo !== undefined && isJsonObject(pageInfo)) {
    hasNextPage = pageInfo.hasNextPage === true;
    const cursor = pageInfo.endCursor;
    if (cursor !== undefined && isJsonString(cursor)) endCursor = cursor;
  }
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
  let pageCount = 0;
  let truncated = false;

  for (;;) {
    let graphqlRaw;
    try {
      graphqlRaw = await octokit.graphql(REVIEW_THREADS_QUERY, {
        owner,
        repo,
        pr: prNumber,
        cursor,
      });
    } catch (error) {
      const err = error instanceof Error ? error : nonErrorThrown("github.review_threads_list");
      const kind = classifyGithubError(err);
      if (kind === "forbidden") {
        return permissionDeniedResult(byRootCommentId);
      }
      if (byRootCommentId.size > 0) {
        return {
          byRootCommentId,
          status: "partial",
          truncated,
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

    const graphqlResult = v.parse(jsonValueSchema, graphqlRaw);
    if (!isReviewThreadsPage(graphqlResult)) {
      return {
        byRootCommentId,
        status: "unavailable",
        warning:
          "reviewThreads GraphQL returned a malformed response; continuing without resolution.",
      };
    }

    pageCount += 1;
    const ingested = ingestThreadsPage(graphqlResult, byRootCommentId);
    sawMalformed = sawMalformed || ingested.sawMalformed;
    if (!ingested.hasNextPage) break;
    if (!ingested.endCursor) {
      return {
        byRootCommentId,
        status: "partial",
        truncated,
        warning:
          "reviewThreads GraphQL reported another page without an endCursor; stopping pagination.",
      };
    }
    if (pageCount >= MAX_REVIEW_THREAD_PAGES) {
      truncated = true;
      break;
    }
    cursor = ingested.endCursor;
  }

  if (truncated) {
    return {
      byRootCommentId,
      status: "partial",
      truncated: true,
      warning: `reviewThreads GraphQL pagination capped at ${MAX_REVIEW_THREAD_PAGES} pages; resolution coverage is partial.`,
    };
  }

  if (sawMalformed && byRootCommentId.size === 0) {
    return {
      byRootCommentId,
      status: "unavailable",
      warning:
        "reviewThreads GraphQL returned malformed thread nodes; continuing without resolution.",
    };
  }

  if (sawMalformed) {
    return {
      byRootCommentId,
      status: "partial",
      warning:
        "reviewThreads GraphQL included malformed thread nodes; using partial resolution data.",
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

/** Log when resolution fetch is degraded. */
export function warnReviewThreadResolutionDegraded(
  result: ListReviewThreadResolutionResult,
  context: JsonObject,
): void {
  if (result.status === "ok" || result.warning == null) return;
  logWarn("review_threads_resolution_degraded", {
    ...context,
    status: result.status,
    warning: result.warning,
  });
}
