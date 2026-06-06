import { describe, expect, it } from "vitest";
import {
  WebhookParseError,
  parseGithubPayload,
  parseInstallationId,
} from "../src/webhook/parseGithubPayload.js";

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
    expect(p.data.installation.id).toBe(42);
    expect(p.data.repository.size).toBe(1234);
    expect(p.data.pull_request.head.sha).toBe("abc");
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
        body: "/review",
        created_at: "2026-05-16T06:33:46Z",
      },
      sender: { login: "commenter", id: 15 },
    };

    const p = parseGithubPayload("issue_comment", raw);
    expect(p.name).toBe("issue_comment");
    expect(p.data.issue.number).toBe(3);
    expect(p.data.comment.body).toBe("/review");
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
    expect(p.data.pull_request.number).toBe(3);
    expect(p.data.comment.id).toBe(100);
    expect(p.data.comment.path).toBe("src/hook.ts");
    expect(p.data.comment.line).toBe(12);
    expect(p.data.comment.diff_hunk).toContain("@@");
  });

  it("throws WebhookParseError on malformed pull_request", () => {
    expect(() => parseGithubPayload("pull_request", { action: "opened" })).toThrow(
      WebhookParseError,
    );
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
});

describe("parseInstallationId", () => {
  it("extracts installation id when present", () => {
    expect(parseInstallationId({ installation: { id: 7 } })).toBe(7);
  });

  it("returns undefined when missing", () => {
    expect(parseInstallationId({})).toBeUndefined();
  });
});
