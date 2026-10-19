import { logWarn } from "../evlog.ts";
import { MAX_REVIEW_THREAD_PAGES } from "../settings/index.ts";
import { isRecord } from "../util/typeGuards.ts";
import { installationOctokit } from "./appAuth.ts";
import { classifyGithubError } from "./githubErrors.ts";
import { AppError } from "../errors/appError.ts";

export type ReviewThreadResolution = {
  readonly threadNodeId: string;
  readonly isResolved: boolean;
};

export type ReviewThreadSnapshotComment = {
  readonly databaseId: number;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
};

export type ReviewThreadSnapshot = ReviewThreadResolution & {
  readonly rootCommentId: number;
  readonly path: string | null;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  readonly isOutdated: boolean;
  readonly diffSide: "LEFT" | "RIGHT" | null;
  readonly comments: readonly ReviewThreadSnapshotComment[];
  readonly commentsComplete: boolean;
};

export type ReviewThreadResolutionStatus = "ok" | "permission_denied" | "partial" | "unavailable";

export type ListReviewThreadResolutionResult = {
  readonly byRootCommentId: Map<number, ReviewThreadResolution>;
  readonly threads: readonly ReviewThreadSnapshot[];
  readonly status: ReviewThreadResolutionStatus;
  readonly truncated?: boolean;
  readonly warning?: string;
};

type ReviewThreadNode = {
  readonly id?: unknown;
  readonly isResolved?: unknown;
  readonly isOutdated?: unknown;
  readonly path?: unknown;
  readonly line?: unknown;
  readonly startLine?: unknown;
  readonly originalLine?: unknown;
  readonly originalStartLine?: unknown;
  readonly diffSide?: unknown;
  readonly comments?: {
    readonly totalCount?: unknown;
    readonly nodes?: readonly {
      readonly fullDatabaseId?: unknown;
      readonly author?: unknown;
      readonly body?: unknown;
      readonly createdAt?: unknown;
      readonly updatedAt?: unknown;
      readonly url?: unknown;
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

const REVIEW_THREAD_COMMENT_PAGE = 100;

const REVIEW_THREAD_FIELDS = `
  id
  isResolved
  isOutdated
  path
  line
  startLine
  originalLine
  originalStartLine
  diffSide
  comments(first: ${REVIEW_THREAD_COMMENT_PAGE}) {
    totalCount
    nodes { fullDatabaseId author { login } body createdAt updatedAt url }
  }
`;

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REVIEW_THREAD_FIELDS} }
      }
    }
  }
}
`;

const REVIEW_THREAD_QUERY = `
query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread { ${REVIEW_THREAD_FIELDS} }
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
  return isRecord(value);
}

function isReviewThreadNode(value: unknown): value is ReviewThreadNode {
  return isRecord(value);
}

function positiveLine(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function threadSnapshot(thread: ReviewThreadNode): ReviewThreadSnapshot | null {
  if (typeof thread.id !== "string" || typeof thread.isResolved !== "boolean") return null;
  const nodes = thread.comments?.nodes;
  if (!Array.isArray(nodes)) return null;
  const comments: ReviewThreadSnapshotComment[] = [];
  let sawMalformedComment = false;
  for (const [index, node] of nodes.entries()) {
    const databaseId = isRecord(node) ? fullDatabaseId(node.fullDatabaseId) : null;
    if (databaseId == null) {
      if (index === 0) return null;
      sawMalformedComment = true;
      continue;
    }
    const author = node.author;
    const login = isRecord(author) ? author.login : undefined;
    comments.push({
      databaseId,
      authorLogin: typeof login === "string" ? login : null,
      body: typeof node.body === "string" ? node.body : "",
      createdAt: typeof node.createdAt === "string" ? node.createdAt : "",
      updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
      url: typeof node.url === "string" ? node.url : "",
    });
  }
  const root = comments[0];
  if (root == null) return null;
  const totalCount = thread.comments?.totalCount;
  return {
    threadNodeId: thread.id,
    isResolved: thread.isResolved,
    rootCommentId: root.databaseId,
    path: typeof thread.path === "string" && thread.path.length > 0 ? thread.path : null,
    line: positiveLine(thread.line),
    startLine: positiveLine(thread.startLine),
    originalLine: positiveLine(thread.originalLine),
    originalStartLine: positiveLine(thread.originalStartLine),
    isOutdated: thread.isOutdated === true,
    diffSide: thread.diffSide === "LEFT" || thread.diffSide === "RIGHT" ? thread.diffSide : null,
    comments,
    commentsComplete:
      !sawMalformedComment && typeof totalCount === "number" && totalCount <= comments.length,
  };
}

function ingestThreadsPage(
  page: ReviewThreadsPage,
  byRootCommentId: Map<number, ReviewThreadResolution>,
  threads: ReviewThreadSnapshot[],
): {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly sawMalformed: boolean;
} {
  const connection = page.repository?.pullRequest?.reviewThreads;
  if (connection == null) {
    return {
      hasNextPage: false,
      endCursor: null,
      sawMalformed: page.repository?.pullRequest == null,
    };
  }

  let sawMalformed = false;
  const nodes = connection.nodes;
  if (nodes != null && !Array.isArray(nodes)) {
    return { hasNextPage: false, endCursor: null, sawMalformed: true };
  }

  for (const thread of nodes ?? []) {
    const snapshot = threadSnapshot(thread);
    if (snapshot == null) {
      sawMalformed = true;
      continue;
    }
    byRootCommentId.set(snapshot.rootCommentId, {
      threadNodeId: snapshot.threadNodeId,
      isResolved: snapshot.isResolved,
    });
    threads.push(snapshot);
  }

  const pageInfo = connection.pageInfo;
  const hasNextPage = pageInfo?.hasNextPage === true;
  const endCursor = typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor : null;
  return { hasNextPage, endCursor, sawMalformed };
}

function permissionDeniedResult(
  byRootCommentId: Map<number, ReviewThreadResolution>,
  threads: readonly ReviewThreadSnapshot[],
): ListReviewThreadResolutionResult {
  return {
    byRootCommentId,
    threads,
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
  const threads: ReviewThreadSnapshot[] = [];
  let cursor: string | null = null;
  let sawMalformed = false;
  let pageCount = 0;
  let truncated = false;

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
        return permissionDeniedResult(byRootCommentId, threads);
      }
      if (byRootCommentId.size > 0) {
        return {
          byRootCommentId,
          threads,
          status: "partial",
          truncated,
          warning:
            "reviewThreads GraphQL pagination failed mid-fetch; continuing with partial resolution data.",
        };
      }
      return {
        byRootCommentId,
        threads,
        status: "unavailable",
        warning: "reviewThreads GraphQL failed; continuing without thread-resolution data.",
      };
    }

    if (!isReviewThreadsPage(page)) {
      return {
        byRootCommentId,
        threads,
        status: "unavailable",
        warning:
          "reviewThreads GraphQL returned a malformed response; continuing without resolution.",
      };
    }

    pageCount += 1;
    const ingested = ingestThreadsPage(page, byRootCommentId, threads);
    sawMalformed = sawMalformed || ingested.sawMalformed;
    if (!ingested.hasNextPage) break;
    if (!ingested.endCursor) {
      return {
        byRootCommentId,
        threads,
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
      threads,
      status: "partial",
      truncated: true,
      warning: `reviewThreads GraphQL pagination capped at ${MAX_REVIEW_THREAD_PAGES} pages; resolution coverage is partial.`,
    };
  }

  if (sawMalformed && byRootCommentId.size === 0) {
    return {
      byRootCommentId,
      threads,
      status: "unavailable",
      warning:
        "reviewThreads GraphQL returned malformed thread nodes; continuing without resolution.",
    };
  }

  if (sawMalformed) {
    return {
      byRootCommentId,
      threads,
      status: "partial",
      warning:
        "reviewThreads GraphQL included malformed thread nodes; using partial resolution data.",
    };
  }

  return { byRootCommentId, threads, status: "ok" };
}

export async function getReviewThreadSnapshot(
  token: string,
  threadNodeId: string,
  expiresAtTs?: number,
): Promise<ReviewThreadSnapshot | null> {
  const octokit = installationOctokit(token, expiresAtTs);
  const response: unknown = await octokit.graphql(REVIEW_THREAD_QUERY, { threadId: threadNodeId });
  const node = isRecord(response) ? response.node : undefined;
  if (node == null) return null;
  if (!isReviewThreadNode(node)) {
    throw new Error("reviewThread GraphQL returned a malformed node");
  }
  const snapshot = threadSnapshot(node);
  if (snapshot == null || snapshot.threadNodeId !== threadNodeId) {
    throw new Error("reviewThread GraphQL returned a malformed thread");
  }
  return snapshot;
}

export async function resolveReviewThread(
  token: string,
  threadNodeId: string,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  let response: unknown;
  try {
    response = await octokit.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId: threadNodeId });
  } catch (error) {
    throwResolutionDenial(error, threadNodeId);
    throw error;
  }
  throwResolutionDenial(response, threadNodeId);
  const data = isRecord(response) && isRecord(response.data) ? response.data : response;
  const mutation = isRecord(data) ? data.resolveReviewThread : undefined;
  const thread = isRecord(mutation) ? mutation.thread : undefined;
  if (!isRecord(thread) || thread.id !== threadNodeId || thread.isResolved !== true) {
    throw Object.assign(new Error("GitHub did not confirm review-thread resolution"), {
      data,
      ...(isRecord(response) && Array.isArray(response.errors) ? { errors: response.errors } : {}),
    });
  }
}

function throwResolutionDenial(response: unknown, threadNodeId: string): void {
  if (!isRecord(response) || classifyGithubError(response) === "rate_limit") return;
  const errors = response.errors;
  const data = Object.hasOwn(response, "data") ? response.data : response;
  if (data != null && (!isRecord(data) || data.resolveReviewThread != null)) return;
  if (
    !Array.isArray(errors) ||
    errors.length === 0 ||
    !errors.every(
      (error) =>
        isRecord(error) &&
        (error.type === "FORBIDDEN" ||
          (isRecord(error.extensions) && error.extensions.code === "FORBIDDEN")) &&
        Array.isArray(error.path) &&
        error.path[0] === "resolveReviewThread",
    )
  ) {
    return;
  }
  throw new AppError({
    domain: "github",
    kind: "review_thread_resolution_denied",
    message:
      "GitHub denied review-thread resolution. Grant the App Pull requests write access " +
      "and confirm this installation can resolve the finding thread, then run /verify.",
    context: { threadNodeId, mutationAccepted: false },
    cause: response,
  });
}

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
