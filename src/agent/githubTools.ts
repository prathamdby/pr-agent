import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  DEFAULT_MAX_PR_FILES_LISTED,
  DEFAULT_MAX_PR_FILES_PATCH_BYTES,
} from "../settings/index.js";
import {
  listPullRequestFilesPaginated,
  type PullRequestFileEntry,
} from "../github/listPullRequestFiles.js";
import {
  parseCommentableRightLineRanges,
  type CommentableRightLineRanges,
} from "../review/reviewDiffIndex.js";

export type ListPullRequestFilesToolOutput = {
  files: Array<
    PullRequestFileEntry & {
      commentableRightLineRanges: CommentableRightLineRanges;
    }
  >;
  truncated: boolean;
  omittedCountLowerBound: number;
  totalChanges: number;
  warning?: string;
};
import { installationOctokit } from "../github/appAuth.js";

type ReviewTool<TSchema extends z.ZodType = z.ZodType> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: z.infer<TSchema>) => Promise<unknown>;
};

function defineTool<TSchema extends z.ZodType>(tool: ReviewTool<TSchema>): ReviewTool<TSchema> {
  return tool;
}

const PI_TOOL_CACHE = new Map<string, PiTool>();

function toPiTool(name: string, t: ReviewTool): PiTool {
  const cached = PI_TOOL_CACHE.get(name);
  if (cached) return cached;
  const tool = {
    name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema, {
      unrepresentable: "any",
    }) as PiTool["parameters"],
  };
  PI_TOOL_CACHE.set(name, tool);
  return tool;
}

function toExecutor(t: ReviewTool): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => t.run(t.schema.parse(args));
}

const BLAME_QUERY = `
  query ($owner: String!, $name: String!, $expression: String!, $path: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $expression) {
        ... on Commit {
          oid
          blame(path: $path) {
            ranges {
              startingLine
              endingLine
              age
              commit {
                oid
                abbreviatedOid
                messageHeadline
                authoredDate
                url
                author {
                  name
                  email
                  user {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

type BlameResponse = {
  repository: null | {
    object: null | {
      oid?: string;
      blame?: {
        ranges: Array<{
          startingLine: number;
          endingLine: number;
          age: number;
          commit: {
            oid: string;
            abbreviatedOid: string;
            messageHeadline: string;
            authoredDate: string;
            url: string;
            author: {
              name: string | null;
              email: string | null;
              user: { login: string | null } | null;
            } | null;
          };
        }>;
      };
    };
  };
};

export function buildGithubTools(
  token: string,
  limits: { maxPrFilesListed: number; maxPrFilesPatchBytes: number } = {
    maxPrFilesListed: DEFAULT_MAX_PR_FILES_LISTED,
    maxPrFilesPatchBytes: DEFAULT_MAX_PR_FILES_PATCH_BYTES,
  },
): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const octokit = installationOctokit(token);
  const fileLimits = limits;

  const getPullRequest = defineTool({
    description: "Get detailed information about a specific pull request",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      pullNumber: z.number().describe("Pull request number"),
    }),
    run: async ({ owner, repo, pullNumber }) => {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });
      return {
        number: data.number,
        title: data.title,
        body: data.body,
        state: data.state,
        url: data.html_url,
        authorLogin: data.user?.login,
        branch: data.head.ref,
        base: data.base.ref,
        draft: data.draft,
        merged: data.merged,
        mergeable: data.mergeable,
        additions: data.additions,
        deletions: data.deletions,
        changedFiles: data.changed_files,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        mergedAt: data.merged_at,
      };
    },
  });

  const listPullRequests = defineTool({
    description: "List pull requests for a GitHub repository",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      state: z
        .enum(["open", "closed", "all"])
        .optional()
        .default("open")
        .describe("Filter by state"),
      perPage: z.number().optional().default(30).describe("Number of results to return (max 100)"),
    }),
    run: async ({ owner, repo, state, perPage }) => {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state,
        per_page: perPage,
      });
      return data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        authorLogin: pr.user?.login,
        branch: pr.head.ref,
        base: pr.base.ref,
        draft: pr.draft,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
      }));
    },
  });

  const listPullRequestFiles = defineTool({
    description: "List files changed in a pull request, including diff status and patch content",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      pullNumber: z.number().describe("Pull request number"),
    }),
    run: async ({ owner, repo, pullNumber }) => {
      const result = await listPullRequestFilesPaginated(
        octokit,
        owner,
        repo,
        pullNumber,
        fileLimits,
      );
      return {
        files: result.files.map((file) => ({
          ...file,
          commentableRightLineRanges:
            file.patch && !file.patchOmitted ? parseCommentableRightLineRanges(file.patch) : [],
        })),
        truncated: result.truncated,
        omittedCountLowerBound: result.omittedCountLowerBound,
        totalChanges: result.totalChanges,
        warning: result.warning,
      };
    },
  });

  const listPullRequestReviews = defineTool({
    description: "List reviews on a pull request (approvals, change requests, and comments)",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      pullNumber: z.number().describe("Pull request number"),
      perPage: z.number().optional().default(30).describe("Number of results to return (max 100)"),
      page: z.number().optional().default(1).describe("Page number for pagination"),
    }),
    run: async ({ owner, repo, pullNumber, perPage, page }) => {
      const { data } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      return data.map((review) => ({
        id: review.id,
        state: review.state,
        body: review.body,
        authorLogin: review.user?.login,
        url: review.html_url,
        submittedAt: review.submitted_at,
      }));
    },
  });

  const getFileContent = defineTool({
    description: "Get the content of a file from a GitHub repository",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("Path to the file in the repository"),
      ref: z
        .string()
        .optional()
        .describe("Branch, tag, or commit SHA (defaults to the default branch)"),
    }),
    run: async ({ owner, repo, path, ref }) => {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });
      if (Array.isArray(data)) {
        return {
          type: "directory" as const,
          entries: data.map((e) => ({
            name: e.name,
            type: e.type,
            path: e.path,
          })),
        };
      }
      if (data.type !== "file") {
        return { type: data.type, path: data.path };
      }
      if (data.encoding === "none" || data.content == null) {
        return {
          type: "file" as const,
          path: data.path,
          sha: data.sha,
          size: data.size,
          content: null,
          note: "File exceeds the 1 MB inline-content limit; GitHub returned metadata only. Review this file's changes through the PR diff (listPullRequestFiles) or inspect specific lines with getBlame instead of the full contents.",
        };
      }
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return {
        type: "file" as const,
        path: data.path,
        sha: data.sha,
        size: data.size,
        content,
      };
    },
  });

  const listCommits = defineTool({
    description:
      "List commits for a GitHub repository. Filter by file path to see commits that touched a file. For line-by-line attribution at a given ref, use getBlame instead.",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      path: z.string().optional().describe("Only commits containing this file path"),
      sha: z.string().optional().describe("Branch name or commit SHA to start listing from"),
      author: z.string().optional().describe("GitHub username or email to filter commits by"),
      since: z.string().optional().describe("Only commits after this date (ISO 8601 format)"),
      until: z.string().optional().describe("Only commits before this date (ISO 8601 format)"),
      perPage: z.number().optional().default(30).describe("Number of results to return (max 100)"),
    }),
    run: async ({ owner, repo, path, sha, author, since, until, perPage }) => {
      const { data } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        path,
        sha,
        author,
        since,
        until,
        per_page: perPage,
      });
      return data.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        authorName: commit.commit.author?.name,
        authorLogin: commit.author?.login,
        date: commit.commit.author?.date,
        url: commit.html_url,
      }));
    },
  });

  const getCommit = defineTool({
    description:
      "Get detailed information about a specific commit, including the list of files changed with additions and deletions",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      ref: z.string().describe("Commit SHA, branch name, or tag"),
    }),
    run: async ({ owner, repo, ref }) => {
      const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref });
      return {
        sha: data.sha,
        message: data.commit.message,
        authorName: data.commit.author?.name,
        authorLogin: data.author?.login,
        date: data.commit.author?.date,
        url: data.html_url,
        additions: data.stats?.additions,
        deletions: data.stats?.deletions,
        changes: data.stats?.total,
        files: (data.files ?? []).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch,
        })),
      };
    },
  });

  const getBlame = defineTool({
    description:
      "Line-level git blame for a file at a commit-like ref (branch, tag, or SHA). Returns contiguous ranges mapping lines to the commits that last modified them — use this to see who introduced a line and when (GitHub GraphQL API).",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("Path to the file in the repository"),
      ref: z
        .string()
        .optional()
        .describe("Branch name, tag, or commit SHA (defaults to the repository default branch)"),
      line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("If set, only return blame ranges that include this line number"),
      lineStart: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("When used with lineEnd, only return ranges overlapping this window"),
      lineEnd: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("When used with lineStart, only return ranges overlapping this window"),
    }),
    run: async ({ owner, repo, path, ref, line, lineStart, lineEnd }) => {
      let expression = ref;
      if (!expression) {
        const { data } = await octokit.rest.repos.get({ owner, repo });
        expression = data.default_branch;
      }

      const data = await octokit.graphql<BlameResponse>(BLAME_QUERY, {
        owner,
        name: repo,
        expression,
        path,
      });

      if (!data.repository) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
      }
      const obj = data.repository.object;
      if (!obj?.oid || !obj?.blame) {
        throw new Error(
          `Ref "${expression}" did not resolve to a commit for this repository (or the path is invalid). Pass a branch name, tag, or full commit SHA.`,
        );
      }

      let ranges = obj.blame.ranges.map((r) => ({
        startingLine: r.startingLine,
        endingLine: r.endingLine,
        age: r.age,
        commit: {
          sha: r.commit.oid,
          abbreviatedSha: r.commit.abbreviatedOid,
          messageHeadline: r.commit.messageHeadline,
          authoredDate: r.commit.authoredDate,
          url: r.commit.url,
          authorName: r.commit.author?.name ?? null,
          authorEmail: r.commit.author?.email ?? null,
          authorLogin: r.commit.author?.user?.login ?? null,
        },
      }));

      if (line != null) {
        ranges = ranges.filter((r) => line >= r.startingLine && line <= r.endingLine);
      } else if (lineStart != null || lineEnd != null) {
        const start = lineStart ?? 1;
        const end = lineEnd ?? Number.MAX_SAFE_INTEGER;
        ranges = ranges.filter((r) => r.endingLine >= start && r.startingLine <= end);
      }

      return {
        ref: expression,
        tipSha: obj.oid,
        path,
        rangeCount: ranges.length,
        ranges,
      };
    },
  });

  const getRepository = defineTool({
    description:
      "Get information about a GitHub repository including description, stars, forks, language, and default branch",
    schema: z.object({
      owner: z.string().describe("Repository owner (user or organization)"),
      repo: z.string().describe("Repository name"),
    }),
    run: async ({ owner, repo }) => {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return {
        name: data.name,
        fullName: data.full_name,
        description: data.description,
        url: data.html_url,
        defaultBranch: data.default_branch,
        stars: data.stargazers_count,
        forks: data.forks_count,
        openIssues: data.open_issues_count,
        language: data.language,
        private: data.private,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    },
  });

  const listBranches = defineTool({
    description: "List branches in a GitHub repository",
    schema: z.object({
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      perPage: z.number().optional().default(30).describe("Number of branches to return (max 100)"),
    }),
    run: async ({ owner, repo, perPage }) => {
      const { data } = await octokit.rest.repos.listBranches({
        owner,
        repo,
        per_page: perPage,
      });
      return data.map((branch) => ({
        name: branch.name,
        sha: branch.commit.sha,
      }));
    },
  });

  const searchCode = defineTool({
    description:
      'Search for code in GitHub repositories. Use qualifiers like "repo:owner/name" to scope the search.',
    schema: z.object({
      query: z
        .string()
        .describe(
          'Search query. Supports GitHub search qualifiers, e.g. "useState repo:facebook/react"',
        ),
      perPage: z.number().optional().default(10).describe("Number of results to return (max 30)"),
    }),
    run: async ({ query, perPage }) => {
      const { data } = await octokit.rest.search.code({
        q: query,
        per_page: perPage,
      });
      return {
        totalCount: data.total_count,
        items: data.items.map((item) => ({
          name: item.name,
          path: item.path,
          url: item.html_url,
          repositoryFullName: item.repository.full_name,
          sha: item.sha,
        })),
      };
    },
  });

  const tools: Record<string, ReviewTool> = {
    getPullRequest,
    listPullRequests,
    listPullRequestFiles,
    listPullRequestReviews,
    getFileContent,
    listCommits,
    getCommit,
    getBlame,
    getRepository,
    listBranches,
    searchCode,
  };
  const entries = Object.entries(tools);

  return {
    piTools: entries.map(([name, t]) => toPiTool(name, t)),
    executors: Object.fromEntries(entries.map(([name, t]) => [name, toExecutor(t)])),
  };
}
