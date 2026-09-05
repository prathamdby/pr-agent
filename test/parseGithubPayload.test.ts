import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { AppError } from "../src/errors/appError.js";
import { WebhookParseError, parseGithubPayload } from "../src/webhook/parseGithubPayload.js";

describe("WebhookParseError", () => {
  it("preserves eventName and valibotError through AppError", () => {
    const valibotErr = new v.ValiError([
      {
        kind: "schema",
        type: "string",
        input: 42,
        expected: "string",
        received: "42",
        message: "Invalid type: Expected string but received 42",
      },
    ]);
    const err = new WebhookParseError("parse failed", "pull_request.opened", valibotErr);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(WebhookParseError);
    expect(err.code).toBe("webhook.parse_failed");
    expect(err.eventName).toBe("pull_request.opened");
    expect(err.valibotError).toBe(valibotErr);
  });
});

describe("parseGithubPayload", () => {
  it("returns ignored for unknown events", () => {
    const p = parseGithubPayload("ping", { installation: { id: 1 } });
    expect(p.name).toBe("ignored");
  });

  it("parses pull_request with required fields", () => {
    const raw = {
      action: "opened",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r", size: 1234 },
      pull_request: { number: 3, head: { sha: "abc" } },
    };
    const p = parseGithubPayload("pull_request", raw);
    expect(p.name).toBe("pull_request");
    if (p.name !== "pull_request") throw new Error("expected pull_request payload");
    expect(p.data.installation.id).toBe(42);
    expect(p.data.repository.size).toBe(1234);
    expect(p.data.pull_request.head.sha).toBe("abc");
    expect(p.data.pull_request.merged).toBe(false);
    expect(p.data.before).toBeUndefined();
  });

  it("parses pull_request closed with merged true", () => {
    const raw = {
      action: "closed",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r", size: 1234 },
      pull_request: { number: 3, head: { sha: "abc" }, merged: true },
    };
    const p = parseGithubPayload("pull_request", raw);
    expect(p.name).toBe("pull_request");
    if (p.name !== "pull_request") throw new Error("expected pull_request payload");
    expect(p.data.action).toBe("closed");
    expect(p.data.pull_request.merged).toBe(true);
  });

  it("defaults merged to false on closed when the field is absent", () => {
    const raw = {
      action: "closed",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r", size: 1234 },
      pull_request: { number: 3, head: { sha: "abc" } },
    };
    const p = parseGithubPayload("pull_request", raw);
    expect(p.name).toBe("pull_request");
    if (p.name !== "pull_request") throw new Error("expected pull_request payload");
    expect(p.data.action).toBe("closed");
    expect(p.data.pull_request.merged).toBe(false);
  });

  it("rejects closed payloads when merged is null", () => {
    const raw = {
      action: "closed",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r", size: 1234 },
      pull_request: { number: 3, head: { sha: "abc" }, merged: null },
    };
    expect(() => parseGithubPayload("pull_request", raw)).toThrow(WebhookParseError);
  });

  it("parses optional top-level before on pull_request synchronize", () => {
    const raw = {
      action: "synchronize",
      before: "d".repeat(40),
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r", size: 1234 },
      pull_request: { number: 3, head: { sha: "abc" } },
    };
    const p = parseGithubPayload("pull_request", raw);
    expect(p.name).toBe("pull_request");
    if (p.name !== "pull_request") throw new Error("expected pull_request payload");
    expect(p.data.before).toBe("d".repeat(40));
  });

  it("parses real-shaped pull_request payloads with extra GitHub fields", () => {
    const raw = {
      action: "synchronize",
      number: 3,
      installation: { id: 42, node_id: "I_kwDO" },
      repository: {
        id: 10,
        node_id: "R_kwDO",
        full_name: "o/r",
        owner: {
          id: 11,
          login: "o",
          node_id: "U_kwDO",
          avatar_url: "https://example.test/avatar.png",
          type: "User",
          site_admin: false,
        },
        name: "r",
        private: false,
        html_url: "https://github.com/o/r",
        default_branch: "main",
      },
      pull_request: {
        url: "https://api.github.com/repos/o/r/pulls/3",
        id: 12,
        node_id: "PR_kwDO",
        number: 3,
        head: {
          label: "o:feature",
          ref: "feature",
          sha: "abc",
          user: { login: "o", id: 11 },
          repo: { name: "r", full_name: "o/r" },
        },
        base: { ref: "main" },
        changed_files: 2,
      },
      sender: { login: "o", id: 11 },
    };

    const p = parseGithubPayload("pull_request", raw);
    expect(p.name).toBe("pull_request");
    if (p.name !== "pull_request") throw new Error("expected pull_request payload");
    expect(p.data.repository.owner.login).toBe("o");
    expect(p.data.pull_request.head.sha).toBe("abc");
  });

  it("parses real-shaped issue_comment payloads with extra GitHub fields", () => {
    const raw = {
      action: "created",
      installation: { id: 42, node_id: "I_kwDO" },
      repository: {
        id: 10,
        node_id: "R_kwDO",
        full_name: "o/r",
        owner: { id: 11, login: "o", node_id: "U_kwDO", type: "User" },
        name: "r",
        private: false,
        html_url: "https://github.com/o/r",
        default_branch: "main",
      },
      issue: {
        url: "https://api.github.com/repos/o/r/issues/3",
        id: 13,
        node_id: "I_kwDO_issue",
        number: 3,
        title: "PR title",
        user: { login: "author", id: 14 },
        pull_request: { url: "https://api.github.com/repos/o/r/pulls/3" },
        body: "description",
      },
      comment: {
        url: "https://api.github.com/repos/o/r/issues/comments/99",
        html_url: "https://github.com/o/r/pull/3#issuecomment-99",
        id: 99,
        node_id: "IC_kwDO",
        user: {
          id: 15,
          login: "commenter",
          node_id: "U_kwDO_commenter",
          avatar_url: "https://example.test/avatar.png",
          type: "User",
          site_admin: false,
        },
        author_association: "MEMBER",
        body: "/review",
        created_at: "2026-05-16T06:33:46Z",
      },
      sender: { login: "commenter", id: 15 },
    };

    const p = parseGithubPayload("issue_comment", raw);
    expect(p.name).toBe("issue_comment");
    if (p.name !== "issue_comment") throw new Error("expected issue_comment payload");
    expect(p.data.issue.number).toBe(3);
    expect(p.data.comment.body).toBe("/review");
    expect(p.data.comment.author_association).toBe("MEMBER");
  });

  it("parses real-shaped pull_request_review_comment payloads with extra GitHub fields", () => {
    const raw = {
      action: "created",
      installation: { id: 42, node_id: "I_kwDO" },
      repository: {
        id: 10,
        node_id: "R_kwDO",
        full_name: "o/r",
        owner: { id: 11, login: "o", node_id: "U_kwDO", type: "User" },
        name: "r",
        private: false,
      },
      pull_request: {
        id: 12,
        node_id: "PR_kwDO",
        number: 3,
        head: { sha: "abc" },
      },
      comment: {
        url: "https://api.github.com/repos/o/r/pulls/comments/100",
        id: 100,
        node_id: "PRRC_kwDO",
        user: { id: 15, login: "commenter", node_id: "U_kwDO_commenter" },
        author_association: "COLLABORATOR",
        body: "/ask what is this?",
        path: "src/hook.ts",
        line: 12,
        start_line: 10,
        side: "RIGHT",
        diff_hunk: "@@ -1,3 +1,3 @@\n-old\n+new",
        commit_id: "abc",
        original_commit_id: "abc",
      },
      sender: { login: "commenter", id: 15 },
    };

    const p = parseGithubPayload("pull_request_review_comment", raw);
    expect(p.name).toBe("pull_request_review_comment");
    if (p.name !== "pull_request_review_comment") {
      throw new Error("expected pull_request_review_comment payload");
    }
    expect(p.data.pull_request.number).toBe(3);
    expect(p.data.comment.id).toBe(100);
    expect(p.data.comment.author_association).toBe("COLLABORATOR");
    expect(p.data.comment.path).toBe("src/hook.ts");
    expect(p.data.comment.line).toBe(12);
    expect(p.data.comment.diff_hunk).toContain("@@");
  });

  it("parses pull_request_review_comment replies with in_reply_to_id", () => {
    const raw = {
      action: "created",
      installation: { id: 42 },
      repository: {
        owner: { login: "o" },
        name: "r",
      },
      pull_request: { number: 3 },
      comment: {
        id: 101,
        user: { id: 15 },
        author_association: "MEMBER",
        body: "why is this P1?",
        in_reply_to_id: 100,
        pull_request_review_id: 55,
        path: "src/hook.ts",
        line: 12,
        side: "RIGHT",
      },
    };

    const p = parseGithubPayload("pull_request_review_comment", raw);
    expect(p.name).toBe("pull_request_review_comment");
    if (p.name !== "pull_request_review_comment") {
      throw new Error("expected pull_request_review_comment payload");
    }
    expect(p.data.comment.in_reply_to_id).toBe(100);
    expect(p.data.comment.pull_request_review_id).toBe(55);
  });

  it("accepts null in_reply_to_id on top-level review comments", () => {
    const raw = {
      action: "created",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: { number: 3 },
      comment: {
        id: 100,
        user: { id: 15 },
        author_association: "MEMBER",
        body: "top-level note",
        in_reply_to_id: null,
        path: "src/hook.ts",
        line: 12,
        side: "RIGHT",
      },
    };

    const p = parseGithubPayload("pull_request_review_comment", raw);
    expect(p.name).toBe("pull_request_review_comment");
    if (p.name !== "pull_request_review_comment") {
      throw new Error("expected pull_request_review_comment payload");
    }
    expect(p.data.comment.in_reply_to_id).toBeNull();
  });

  it("rejects non-integer and out-of-range pull_request identifiers", () => {
    const base = {
      action: "opened",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r", size: 1234 },
      pull_request: { number: 3, head: { sha: "abc" } },
    };
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        pull_request: { number: 1.5, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        pull_request: { number: 0, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        pull_request: { number: -1, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        pull_request: { number: 2_147_483_648, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        installation: { id: 1.5 },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        installation: { id: -99 },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        pull_request: { number: 3, head: { sha: "" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        repository: { owner: { login: "" }, name: "r" },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        repository: { owner: { login: "o" }, name: "" },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        repository: { owner: { login: "o".repeat(40) }, name: "r" },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        pull_request: { number: 3, head: { sha: "a".repeat(65) } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        before: "",
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...base,
        before: "a".repeat(65),
      }),
    ).toThrow(WebhookParseError);
  });

  const int32Rejects = [
    1.5,
    0,
    -1,
    2_147_483_648,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "3",
  ] as const;
  const safeIdRejects = [
    1.5,
    0,
    -1,
    9_007_199_254_740_992,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "3",
  ] as const;

  it("rejects issue_comment out-of-range ids", () => {
    const base = {
      action: "created",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r" },
      issue: { number: 3, pull_request: {} },
      comment: { id: 99, user: { id: 15, login: "c" }, body: "/review" },
    };
    for (const number of int32Rejects) {
      expect(() =>
        parseGithubPayload("issue_comment", {
          ...base,
          issue: { number, pull_request: {} },
        }),
      ).toThrow(WebhookParseError);
    }
    for (const id of safeIdRejects) {
      expect(() =>
        parseGithubPayload("issue_comment", {
          ...base,
          comment: { ...base.comment, id },
        }),
      ).toThrow(WebhookParseError);
      expect(() =>
        parseGithubPayload("issue_comment", {
          ...base,
          comment: { ...base.comment, user: { id, login: "c" } },
        }),
      ).toThrow(WebhookParseError);
      expect(() =>
        parseGithubPayload("issue_comment", {
          ...base,
          comment: { ...base.comment, in_reply_to_id: id },
        }),
      ).toThrow(WebhookParseError);
    }
    expect(() =>
      parseGithubPayload("issue_comment", {
        ...base,
        comment: { ...base.comment, user: { id: 15, login: "o".repeat(40) } },
      }),
    ).toThrow(WebhookParseError);
  });

  it("rejects pull_request_review_comment out-of-range ids", () => {
    const base = {
      action: "created",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: { number: 3 },
      comment: {
        id: 100,
        user: { id: 15, login: "c" },
        body: "note",
        path: "src/hook.ts",
        line: 12,
        side: "RIGHT" as const,
      },
    };
    for (const number of int32Rejects) {
      expect(() =>
        parseGithubPayload("pull_request_review_comment", {
          ...base,
          pull_request: { number },
        }),
      ).toThrow(WebhookParseError);
    }
    for (const id of safeIdRejects) {
      expect(() =>
        parseGithubPayload("pull_request_review_comment", {
          ...base,
          comment: { ...base.comment, id },
        }),
      ).toThrow(WebhookParseError);
      expect(() =>
        parseGithubPayload("pull_request_review_comment", {
          ...base,
          comment: { ...base.comment, user: { id, login: "c" } },
        }),
      ).toThrow(WebhookParseError);
      expect(() =>
        parseGithubPayload("pull_request_review_comment", {
          ...base,
          comment: { ...base.comment, in_reply_to_id: id },
        }),
      ).toThrow(WebhookParseError);
    }
  });

  it("rejects workflow_run out-of-range ids and shas", () => {
    const base = {
      action: "completed",
      installation: { id: 9 },
      repository: { owner: { login: "acme" }, name: "pr-agent" },
      workflow_run: {
        id: 55,
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        pull_requests: [{ number: 12, head: { sha: "abc123" } }],
      },
    };
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        workflow_run: { ...base.workflow_run, id: 1.5 },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        workflow_run: { ...base.workflow_run, id: 0 },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        workflow_run: { ...base.workflow_run, id: -5 },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        workflow_run: { ...base.workflow_run, id: 9_007_199_254_740_992 },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        workflow_run: { ...base.workflow_run, head_sha: "" },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        workflow_run: { ...base.workflow_run, head_sha: "a".repeat(65) },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        repository: { owner: { login: "" }, name: "pr-agent" },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        repository: { owner: { login: "o".repeat(40) }, name: "pr-agent" },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        repository: { owner: { login: "acme" }, name: "" },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...base,
        repository: { owner: { login: "acme" }, name: "r".repeat(101) },
      }),
    ).toThrow(WebhookParseError);
  });

  it("rejects check_suite out-of-range ids and shas", () => {
    const base = {
      action: "completed",
      installation: { id: 9 },
      repository: { owner: { login: "acme" }, name: "pr-agent" },
      check_suite: {
        id: 55,
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 12, head: { sha: "abc123" } }],
      },
    };
    expect(() =>
      parseGithubPayload("check_suite", {
        ...base,
        check_suite: { ...base.check_suite, id: 1.5 },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("check_suite", {
        ...base,
        check_suite: { ...base.check_suite, head_sha: "" },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("check_suite", {
        ...base,
        check_suite: { ...base.check_suite, head_sha: "a".repeat(65) },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("check_suite", {
        ...base,
        repository: { owner: { login: "o".repeat(40) }, name: "pr-agent" },
      }),
    ).toThrow(WebhookParseError);
  });

  it("rejects ciRefresh pull_requests out-of-range", () => {
    const workflowBase = {
      action: "completed",
      installation: { id: 9 },
      repository: { owner: { login: "acme" }, name: "pr-agent" },
      workflow_run: {
        id: 55,
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        pull_requests: [{ number: 12, head: { sha: "abc123" } }],
      },
    };
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...workflowBase,
        workflow_run: {
          ...workflowBase.workflow_run,
          pull_requests: [{ number: 2_147_483_648, head: { sha: "abc123" } }],
        },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("workflow_run", {
        ...workflowBase,
        workflow_run: {
          ...workflowBase.workflow_run,
          pull_requests: [{ number: 12, head: { sha: "" } }],
        },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("check_suite", {
        action: "completed",
        installation: { id: 9 },
        repository: { owner: { login: "acme" }, name: "pr-agent" },
        check_suite: {
          id: 55,
          head_sha: "abc123",
          status: "completed",
          conclusion: "success",
          pull_requests: [{ number: 2_147_483_648, head: { sha: "abc123" } }],
        },
      }),
    ).toThrow(WebhookParseError);
  });

  it("accepts max-boundary valid identifiers", () => {
    const pullRequest = parseGithubPayload("pull_request", {
      action: "opened",
      before: "a".repeat(64),
      installation: { id: Number.MAX_SAFE_INTEGER },
      repository: { owner: { login: "o".repeat(39) }, name: "r".repeat(100), size: 1234 },
      pull_request: { number: 2_147_483_647, head: { sha: "a".repeat(64) } },
    });
    expect(pullRequest.name).toBe("pull_request");

    const issueComment = parseGithubPayload("issue_comment", {
      action: "created",
      installation: { id: Number.MAX_SAFE_INTEGER },
      repository: { owner: { login: "o".repeat(39) }, name: "r".repeat(100) },
      issue: { number: 2_147_483_647, pull_request: {} },
      comment: {
        id: Number.MAX_SAFE_INTEGER,
        user: { id: Number.MAX_SAFE_INTEGER, login: "o".repeat(39) },
        body: "/review",
      },
    });
    expect(issueComment.name).toBe("issue_comment");

    const workflowRun = parseGithubPayload("workflow_run", {
      action: "completed",
      installation: { id: Number.MAX_SAFE_INTEGER },
      repository: { owner: { login: "o".repeat(39) }, name: "r".repeat(100) },
      workflow_run: {
        id: Number.MAX_SAFE_INTEGER,
        head_sha: "a".repeat(64),
        status: "completed",
        conclusion: "failure",
        pull_requests: [{ number: 2_147_483_647, head: { sha: "a".repeat(64) } }],
      },
    });
    expect(workflowRun.name).toBe("workflow_run");

    expect(() =>
      parseGithubPayload("pull_request", {
        action: "opened",
        installation: { id: 42 },
        repository: { owner: { login: "o" }, name: "r" },
        pull_request: { number: 2_147_483_648, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        action: "opened",
        installation: { id: 42 },
        repository: { owner: { login: "o".repeat(40) }, name: "r" },
        pull_request: { number: 3, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        action: "opened",
        installation: { id: 42 },
        repository: { owner: { login: "o" }, name: "r".repeat(101) },
        pull_request: { number: 3, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        action: "opened",
        installation: { id: 42 },
        repository: { owner: { login: "o" }, name: "r" },
        pull_request: { number: 3, head: { sha: "a".repeat(65) } },
      }),
    ).toThrow(WebhookParseError);
  });

  it("rejects repo-name oversize, NaN/Infinity and string numbers", () => {
    const pullRequestBase = {
      action: "opened",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r", size: 1234 },
      pull_request: { number: 3, head: { sha: "abc" } },
    };
    expect(() =>
      parseGithubPayload("pull_request", {
        ...pullRequestBase,
        repository: { owner: { login: "o" }, name: "r".repeat(101) },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...pullRequestBase,
        pull_request: { number: Number.NaN, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...pullRequestBase,
        pull_request: { number: Number.POSITIVE_INFINITY, head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...pullRequestBase,
        pull_request: { number: "3", head: { sha: "abc" } },
      }),
    ).toThrow(WebhookParseError);
    expect(() =>
      parseGithubPayload("pull_request", {
        ...pullRequestBase,
        installation: { id: "42" },
      }),
    ).toThrow(WebhookParseError);

    const reviewCommentBase = {
      action: "created",
      installation: { id: 42 },
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: { number: 3 },
      comment: {
        id: 100,
        user: { id: 15, login: "c" },
        body: "note",
        in_reply_to_id: 99,
        pull_request_review_id: 55,
        path: "src/hook.ts",
        line: 12,
        side: "RIGHT" as const,
      },
    };
    for (const inReplyToId of [0, -1, 1.5, Number.NaN] as const) {
      expect(() =>
        parseGithubPayload("pull_request_review_comment", {
          ...reviewCommentBase,
          comment: { ...reviewCommentBase.comment, in_reply_to_id: inReplyToId },
        }),
      ).toThrow(WebhookParseError);
    }
    expect(() =>
      parseGithubPayload("pull_request_review_comment", {
        ...reviewCommentBase,
        comment: { ...reviewCommentBase.comment, pull_request_review_id: 9_007_199_254_740_992 },
      }),
    ).toThrow(WebhookParseError);
  });

  it("throws WebhookParseError on malformed pull_request", () => {
    try {
      parseGithubPayload("pull_request", { action: "opened" });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookParseError);
      expect(e).toBeInstanceOf(AppError);
      expect((e as WebhookParseError).code).toBe("webhook.parse_failed");
      expect((e as WebhookParseError).eventName).toBe("pull_request");
      expect((e as WebhookParseError).valibotError).toBeInstanceOf(v.ValiError);
    }
  });

  it("ignores pull_request actions outside the automated allowlist", () => {
    const parsed = parseGithubPayload("pull_request", {
      action: "labeled",
      installation: { id: 1 },
    });
    expect(parsed.name).toBe("ignored");
  });

  it("ignores issue_comment actions other than created", () => {
    const parsed = parseGithubPayload("issue_comment", {
      action: "edited",
      installation: { id: 1 },
    });
    expect(parsed.name).toBe("ignored");
  });

  it("ignores pull_request_review_comment actions other than created", () => {
    const parsed = parseGithubPayload("pull_request_review_comment", {
      action: "edited",
      installation: { id: 1 },
    });
    expect(parsed.name).toBe("ignored");
  });

  it("parses completed workflow_run payloads", () => {
    const parsed = parseGithubPayload("workflow_run", {
      action: "completed",
      installation: { id: 9 },
      repository: {
        name: "pr-agent",
        owner: { login: "acme" },
      },
      workflow_run: {
        id: 55,
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        pull_requests: [{ number: 12, head: { sha: "abc123" } }],
      },
    });
    expect(parsed.name).toBe("workflow_run");
    if (parsed.name !== "workflow_run") {
      throw new Error("expected workflow_run payload");
    }
    expect(parsed.data.installation.id).toBe(9);
    expect(parsed.data.workflow_run.head_sha).toBe("abc123");
    expect(parsed.data.workflow_run.pull_requests).toHaveLength(1);
  });

  it("ignores workflow_run actions other than completed", () => {
    const parsed = parseGithubPayload("workflow_run", {
      action: "requested",
      installation: { id: 1 },
    });
    expect(parsed.name).toBe("ignored");
  });

  it("parses completed check_suite payloads", () => {
    const parsed = parseGithubPayload("check_suite", {
      action: "completed",
      installation: { id: 9 },
      repository: {
        name: "pr-agent",
        owner: { login: "acme" },
      },
      check_suite: {
        id: 55,
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 12, head: { sha: "abc123" } }],
      },
    });
    expect(parsed.name).toBe("check_suite");
    if (parsed.name !== "check_suite") {
      throw new Error("expected check_suite payload");
    }
    expect(parsed.data.installation.id).toBe(9);
    expect(parsed.data.check_suite.head_sha).toBe("abc123");
    expect(parsed.data.check_suite.pull_requests).toHaveLength(1);
  });

  it("ignores check_suite actions other than completed", () => {
    const parsed = parseGithubPayload("check_suite", {
      action: "requested",
      installation: { id: 1 },
    });
    expect(parsed.name).toBe("ignored");
  });
});
