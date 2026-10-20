import { describe, expect, it, vi } from "vitest";
import { buildAskUserContent } from "../src/prompts/ask/prompt.ts";
import {
  DISCUSSION_CONVERSATION_NOT_LOADED,
  DISCUSSION_INCOMPLETE_NOTICE,
  DISCUSSION_OMISSION_MARKER,
  formatPullRequestDiscussion,
} from "../src/prompts/shared/context.ts";
import type { AskRunParams } from "../src/agent/ask/askRunTypes.ts";
import {
  emptyPullRequestDiscussion,
  loadPullRequestDiscussion,
  type PullRequestDiscussion,
} from "../src/agent/discussion/pullRequestDiscussion.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";
import type { ReviewThreadSnapshot } from "../src/github/reviewThreadResolution.ts";
import { buildVerificationRunSetup } from "../src/agent/verification/verificationRunSetup.ts";
import type { LocalPrWorkspace } from "../src/prWorkspace/localPrWorkspace.ts";
import { makeTestConfig } from "./helpers/config.ts";

function baseParams(overrides: Partial<AskRunParams> = {}): AskRunParams {
  const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  return {
    cfg: makeTestConfig(),
    prSurface: surface,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "abc",
    question: "why?",
    replyTarget: { kind: "prConversation", prNumber: 1 },
    workspace: {} as AskRunParams["workspace"],
    discussion: emptyPullRequestDiscussion(),
    ...overrides,
  };
}

function snapshot(params: {
  readonly rootCommentId: number;
  readonly body: string;
  readonly author: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly isResolved: boolean;
  readonly isOutdated?: boolean;
  readonly commentsComplete?: boolean;
  readonly extra?: ReviewThreadSnapshot["comments"];
}): ReviewThreadSnapshot {
  return {
    threadNodeId: `thread-${params.rootCommentId}`,
    isResolved: params.isResolved,
    rootCommentId: params.rootCommentId,
    path: params.path,
    line: params.line,
    startLine: null,
    originalLine: params.line,
    originalStartLine: null,
    isOutdated: params.isOutdated ?? false,
    diffSide: "RIGHT",
    commentsComplete: params.commentsComplete ?? true,
    comments: [
      {
        databaseId: params.rootCommentId,
        authorLogin: params.author,
        body: params.body,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        url: `https://github.test/thread/${params.rootCommentId}`,
      },
      ...(params.extra ?? []),
    ],
  };
}

function discussionFrom(threads: readonly ReviewThreadSnapshot[]): PullRequestDiscussion {
  return {
    reviewThreads: {
      byRootCommentId: new Map(
        threads.map((thread) => [
          thread.rootCommentId,
          { threadNodeId: thread.threadNodeId, isResolved: thread.isResolved },
        ]),
      ),
      threads,
      status: "ok",
    },
    conversation: { loaded: true, comments: [], groups: [], truncated: false },
  };
}

describe("buildAskUserContent discussion", () => {
  it("renders an explicit empty discussion when both reads succeed empty", () => {
    const content = buildAskUserContent(baseParams());
    expect(content).toContain('<discussion untrusted="true">');
    expect(content).toContain("Inline review threads:\nnone");
    expect(content).toContain("Conversation:\nnone");
    expect(content).not.toContain("thread_transcript");
  });

  it("includes a read-only ci_state block from durable facts", () => {
    const content = buildAskUserContent(
      baseParams({
        ciState: {
          rollup: "failing",
          version: 3,
          checks: [{ name: "lint", status: "completed", conclusion: "failure" }],
        },
      }),
    );
    expect(content).toContain('<ci_state untrusted="true">');
    expect(content).toContain("rollup: failing");
    expect(content).toContain("- lint: completed/failure");
  });

  it("omits ci_state when facts were not loaded", () => {
    const content = buildAskUserContent(baseParams());
    expect(content).not.toContain("ci_state");
  });

  it("shows resolved, human, and conversation text to ask and verification, and only the open finding on the work list", async () => {
    const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const openBody = "Open bot finding body";
    const resolvedBody = "Resolved sibling still visible";
    const humanBody = "Human reviewer note";
    const conversationBody = "Conversation note beside the threads";
    controls.setThreads(
      new Map([
        [
          21,
          snapshot({
            rootCommentId: 21,
            body: resolvedBody,
            author: "pr-agent[bot]",
            path: "src/resolved.ts",
            line: 8,
            isResolved: true,
          }),
        ],
        [
          31,
          snapshot({
            rootCommentId: 31,
            body: humanBody,
            author: "ada",
            path: "src/human.ts",
            line: 3,
            isResolved: false,
          }),
        ],
        [
          11,
          snapshot({
            rootCommentId: 11,
            body: openBody,
            author: "pr-agent[bot]",
            path: "src/open.ts",
            line: 4,
            isResolved: false,
          }),
        ],
      ]),
    );
    controls.setConversationComments([
      { id: 80, inReplyToId: null, authorLogin: "ada", body: conversationBody },
    ]);

    const discussion = await loadPullRequestDiscussion(surface);
    const ask = buildAskUserContent(
      baseParams({
        discussion,
        discussionTrigger: { kind: "conversation", commentId: 81 },
      }),
    );
    const verification = buildVerificationRunSetup({
      cfg: makeTestConfig(),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc",
      workspace: { reader: { agentCwd: process.cwd() } } as LocalPrWorkspace,
      inventory: [
        {
          rootCommentId: 11,
          lens: "review",
          path: "src/open.ts",
          line: 4,
          severity: "P1",
          titleSnippet: "Only open work item",
          humanReplies: [],
          threadUrl: "https://github.test/open",
        },
      ],
      pushedCommits: [],
      discussion,
    }).userContent;

    for (const message of [ask, verification]) {
      expect(message).toContain(resolvedBody);
      expect(message).toContain(humanBody);
      expect(message).toContain(conversationBody);
    }
    const workList = verification.split("<discussion")[0] ?? "";
    expect(workList).toContain("Only open work item");
    expect(workList).not.toContain(resolvedBody);
    expect(workList).not.toContain(humanBody);
    expect(workList).not.toContain(conversationBody);
  });
});

describe("formatPullRequestDiscussion", () => {
  it("redacts secrets in comment bodies before they enter the block", () => {
    const text = formatPullRequestDiscussion(
      discussionFrom([
        snapshot({
          rootCommentId: 1,
          body: "token ghp_1234567890123456789012345678901234",
          author: "alice",
          path: "src/a.ts",
          line: 1,
          isResolved: false,
        }),
      ]),
    );
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("ghp_");
  });

  it("keeps the root and the newest reply when a named thread exceeds its share", () => {
    const text = formatPullRequestDiscussion(
      discussionFrom([
        snapshot({
          rootCommentId: 1,
          body: "ROOT ANCHOR COMMENT",
          author: "alice",
          path: "a.ts",
          line: 1,
          isResolved: false,
          extra: [
            {
              databaseId: 2,
              authorLogin: "bob",
              body: "middle comment that should be omitted from the transcript",
              createdAt: "2026-01-02T00:00:00Z",
              updatedAt: "2026-01-02T00:00:00Z",
              url: "https://github.test/thread/2",
            },
            {
              databaseId: 3,
              authorLogin: "carol",
              body: "newest reply",
              createdAt: "2026-01-03T00:00:00Z",
              updatedAt: "2026-01-03T00:00:00Z",
              url: "https://github.test/thread/3",
            },
          ],
        }),
      ]),
      undefined,
      240,
    );
    expect(text).toContain("ROOT ANCHOR COMMENT");
    expect(text).toContain(DISCUSSION_OMISSION_MARKER);
    expect(text).toContain("newest reply");
    expect(text).not.toContain("middle comment");
    expect(text.length).toBeLessThanOrEqual(240);
  });

  it("stays within maxChars when the next identity line does not fit", () => {
    const text = formatPullRequestDiscussion(
      discussionFrom([
        snapshot({
          rootCommentId: 1,
          body: "R".repeat(100),
          author: "alice",
          path: "a.ts",
          line: 1,
          isResolved: false,
        }),
      ]),
      undefined,
      80,
    );
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text).toContain(DISCUSSION_INCOMPLETE_NOTICE);
    expect(text).not.toContain("R".repeat(100));
  });

  it("prints a review-thread warning and the incomplete notice without dropping the snapshot", () => {
    const warning = "GitHub App lacks review thread permission.";
    const text = formatPullRequestDiscussion({
      reviewThreads: {
        byRootCommentId: new Map([[1, { threadNodeId: "thread-1", isResolved: false }]]),
        threads: [
          snapshot({
            rootCommentId: 1,
            body: "Partial snapshot body",
            author: "bot",
            path: "src/a.ts",
            line: 2,
            isResolved: false,
          }),
        ],
        status: "partial",
        warning,
      },
      conversation: { loaded: true, comments: [], groups: [], truncated: false },
    });
    expect(text).toContain(warning);
    expect(text).toContain(DISCUSSION_INCOMPLETE_NOTICE);
    expect(text).toContain("Partial snapshot body");
  });

  it("says the conversation was not loaded and still renders review threads", () => {
    const text = formatPullRequestDiscussion({
      reviewThreads: {
        byRootCommentId: new Map([[1, { threadNodeId: "thread-1", isResolved: true }]]),
        threads: [
          snapshot({
            rootCommentId: 1,
            body: "Snapshot survives conversation failure",
            author: "bot",
            path: null,
            line: null,
            isResolved: true,
            commentsComplete: false,
          }),
        ],
        status: "ok",
      },
      conversation: { loaded: false },
    });
    expect(text).toContain(DISCUSSION_CONVERSATION_NOT_LOADED);
    expect(text).toContain("Snapshot survives conversation failure");
    expect(text).toContain("comments incomplete");
    expect(text).toContain("path= ");
    expect(text).toContain("state=resolved");
    expect(text).not.toContain("Conversation:\nnone");
  });

  it("prints the incomplete notice for a truncated conversation and keeps the loaded prefix", () => {
    const text = formatPullRequestDiscussion({
      reviewThreads: {
        byRootCommentId: new Map(),
        threads: [],
        status: "ok",
      },
      conversation: {
        loaded: true,
        truncated: true,
        comments: [
          { id: 4, inReplyToId: null, authorLogin: "ada", body: "kept conversation prefix" },
        ],
        groups: [
          [{ id: 4, inReplyToId: null, authorLogin: "ada", body: "kept conversation prefix" }],
        ],
      },
    });
    expect(text).toContain(DISCUSSION_INCOMPLETE_NOTICE);
    expect(text).toContain("kept conversation prefix");
    expect(text).toContain("Inline review threads:\nnone");
  });
});

describe("loadPullRequestDiscussion", () => {
  it("keeps review-thread snapshots when the conversation read throws", async () => {
    const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    controls.setThreads(
      new Map([
        [
          11,
          snapshot({
            rootCommentId: 11,
            body: "Snapshot survives conversation failure",
            author: "pr-agent[bot]",
            path: "src/open.ts",
            line: 4,
            isResolved: false,
          }),
        ],
      ]),
    );
    vi.spyOn(surface, "listConversationComments").mockRejectedValue(new Error("boom"));

    const discussion = await loadPullRequestDiscussion(surface);

    expect(discussion.conversation.loaded).toBe(false);
    expect(discussion.reviewThreads.threads.map((thread) => thread.rootCommentId)).toEqual([11]);
    const text = formatPullRequestDiscussion(discussion);
    expect(text).toContain(DISCUSSION_CONVERSATION_NOT_LOADED);
    expect(text).toContain("Snapshot survives conversation failure");
  });
});
