import { describe, expect, it } from "vitest";
import { toIntakeCommand } from "../src/webhook/intakeCommand.ts";
import { parseGithubPayload } from "../src/webhook/parseGithubPayload.ts";
import { makeTestConfig } from "./helpers/config.ts";

const cfg = makeTestConfig();
const bot = { userId: 42, login: "pr-agent[bot]" };
const headers = { event: "issue_comment", delivery: "d1", rawBody: Buffer.from("{}") };
const repository = { owner: { login: "acme" }, name: "app", size: 10 };
function commentEvent(
  body: string,
  inline = false,
  parent?: number,
  association: string | null = "MEMBER",
  userId = 7,
  userType?: string,
) {
  return parseGithubPayload(inline ? "pull_request_review_comment" : "issue_comment", {
    action: "created",
    installation: { id: 9 },
    repository,
    ...(inline ? { pull_request: { number: 7 } } : { issue: { number: 7, pull_request: {} } }),
    comment: {
      id: 100,
      user: { id: userId, login: "alice", ...(userType != null ? { type: userType } : {}) },
      author_association: association,
      body,
      ...(inline ? { path: "src/x.ts", line: 4, side: "RIGHT", in_reply_to_id: parent } : {}),
    },
  });
}

describe("pure intake commands", () => {
  it.each(["/review", "ordinary comment", "@pr-agent why?"])(
    "requires explicit identity before association and mention gates: %s",
    (body) => {
      expect(toIntakeCommand(cfg, headers, commentEvent(body, false, undefined, "NONE"))).toEqual({
        kind: "auth_required",
      });
    },
  );
  it.each(["/review", "@pr-agent why?"])(
    "ignores the resolved app identity before association: %s",
    (body) => {
      expect(
        toIntakeCommand(cfg, headers, commentEvent(body, false, undefined, "NONE", 42), bot),
      ).toMatchObject({ kind: "ignored", decision: "ignored_bot_slash_command" });
    },
  );
  it.each(["NONE", "FIRST_TIME_CONTRIBUTOR", null])(
    "rejects disallowed and absent association: %s",
    (association) => {
      expect(
        toIntakeCommand(cfg, headers, commentEvent("/review", false, undefined, association), bot),
      ).toMatchObject({ kind: "ignored", decision: "ignored_unauthorized_slash" });
    },
  );
  it("allows the star association policy", () => {
    expect(
      toIntakeCommand(
        makeTestConfig({ associations: { slashAllowed: new Set(["*"]) } }),
        headers,
        commentEvent("/review", false, undefined, "NONE"),
        bot,
      ),
    ).toMatchObject({ kind: "slash", input: { command: "review", commenterLogin: "alice" } });
  });
  it.each([false, true])("ignores ordinary comments after authorization: inline=%s", (inline) => {
    expect(toIntakeCommand(cfg, headers, commentEvent("why?", inline, 99), bot)).toMatchObject({
      kind: "ignored",
      decision: "ignored_no_slash_command",
    });
  });
  it.each([undefined, 99])(
    "inline ask replies to parent-or-self, not a resolved root: parent=%s",
    (parent) => {
      expect(
        toIntakeCommand(cfg, headers, commentEvent("@pr-agent[bot] why?", true, parent), bot),
      ).toMatchObject({
        kind: "slash",
        input: {
          command: "ask",
          commentId: 100,
          botLogin: bot.login,
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 7,
            inReplyToCommentId: parent ?? 100,
          },
          codeAnchor: { path: "src/x.ts", line: 4, side: "RIGHT" },
        },
      });
    },
  );
  it.each([undefined, 99])("triage scopes only an existing parent: parent=%s", (parent) => {
    expect(toIntakeCommand(cfg, headers, commentEvent("/triage", true, parent), bot)).toMatchObject(
      {
        kind: "slash",
        input: {
          triageScope: parent == null ? undefined : "thread",
          threadAnchorCommentId: parent,
          needsThreadRootResolution: parent != null,
          replyTarget: { inReplyToCommentId: parent ?? 100 },
        },
      },
    );
  });
  it("enqueues verification for an authorized finding-thread reply", () => {
    const event = commentEvent("why?", true, 99, "OWNER", 7, "User");
    expect(toIntakeCommand(cfg, headers, event, bot)).toEqual({
      kind: "verification_reply",
      headers,
      installationId: 9,
      owner: "acme",
      repo: "app",
      prNumber: 7,
      repositorySizeKb: 10,
    });
    expect(toIntakeCommand(cfg, headers, event)).toEqual({ kind: "auth_required" });
  });
  it("does not enqueue verification outside an authorized auto reply", () => {
    const ignored = { kind: "ignored", decision: "ignored_no_slash_command" };
    expect(
      toIntakeCommand(cfg, headers, commentEvent("why?", true, 99, "OWNER", 7, "Bot"), bot),
    ).toMatchObject(ignored);
    expect(
      toIntakeCommand(cfg, headers, commentEvent("why?", true, 99, "OWNER", 7), bot),
    ).toMatchObject(ignored);
    expect(
      toIntakeCommand(
        cfg,
        headers,
        commentEvent("why?", true, 99, "OWNER", bot.userId, "User"),
        bot,
      ),
    ).toMatchObject({ kind: "ignored", decision: "ignored_bot_slash_command" });
    expect(
      toIntakeCommand(cfg, headers, commentEvent("why?", false, 99, "OWNER", 7, "User"), bot),
    ).toMatchObject(ignored);
    expect(
      toIntakeCommand(cfg, headers, commentEvent("why?", true, undefined, "OWNER", 7, "User"), bot),
    ).toMatchObject(ignored);
    expect(
      toIntakeCommand(
        cfg,
        headers,
        commentEvent("@pr-agent[bot] why?", true, 99, "OWNER", 7, "User"),
        bot,
      ),
    ).toMatchObject({ kind: "slash", input: { command: "ask" } });
    expect(
      toIntakeCommand(cfg, headers, commentEvent("/verify", true, 99, "OWNER", 7, "User"), bot),
    ).toMatchObject({ kind: "slash", input: { command: "verify" } });
    for (const verification of ["manual", "off"] as const) {
      expect(
        toIntakeCommand(
          makeTestConfig({ features: { verification } }),
          headers,
          commentEvent("why?", true, 99, "OWNER", 7, "User"),
          bot,
        ),
      ).toMatchObject(ignored);
    }
  });
  it("uses maintainer decision, not the slash allowlist", () => {
    const event = commentEvent("why?", true, 99, "OWNER", 7, "User");
    expect(
      toIntakeCommand(
        makeTestConfig({
          associations: {
            slashAllowed: new Set(["COLLABORATOR"]),
            maintainerDecision: new Set(["OWNER"]),
          },
        }),
        headers,
        event,
        bot,
      ),
    ).toMatchObject({ kind: "verification_reply" });
    expect(
      toIntakeCommand(
        makeTestConfig({
          associations: {
            slashAllowed: new Set(["MEMBER"]),
            maintainerDecision: new Set(["OWNER"]),
          },
        }),
        headers,
        commentEvent("why?", true, 99, "MEMBER", 7, "User"),
        bot,
      ),
    ).toMatchObject({ kind: "ignored", decision: "ignored_no_slash_command" });
  });
  it("conversation mentions and triage use the conversation surface", () => {
    expect(toIntakeCommand(cfg, headers, commentEvent("@pr-agent hey"), bot)).toMatchObject({
      kind: "slash",
      input: { command: "ask", replyTarget: { kind: "prConversation", prNumber: 7 } },
    });
    expect(toIntakeCommand(cfg, headers, commentEvent("/triage"), bot)).toMatchObject({
      kind: "slash",
      input: { command: "triage", triageScope: "all" },
    });
  });
  it("maps a fork contributor open to maintainer approval", () => {
    const event = parseGithubPayload("pull_request", {
      action: "opened",
      installation: { id: 9 },
      repository,
      pull_request: {
        number: 7,
        author_association: "CONTRIBUTOR",
        head: { sha: "head", repo: { id: 2 } },
        base: { repo: { id: 1 } },
      },
    });
    expect(toIntakeCommand(cfg, headers, event)).toMatchObject({
      kind: "pull_request",
      action: "opened",
      opts: { authorTrust: "awaiting_maintainer_approval" },
    });
  });
  it.each([false, true])("maps close evidence without changing merged=%s", (merged) => {
    const event = parseGithubPayload("pull_request", {
      action: "closed",
      installation: { id: 9 },
      repository,
      pull_request: {
        number: 7,
        head: { sha: "head" },
        merged,
        state: "closed",
        updated_at: "2026-10-01T00:00:01Z",
      },
    });
    expect(toIntakeCommand(cfg, headers, event)).toMatchObject({
      kind: "pull_request",
      action: "closed",
      opts: {
        merged,
        lifecycle: { state: merged ? "merged" : "closed", observedAt: "2026-10-01T00:00:01Z" },
      },
    });
  });
  it.each(["Bot", "bot"])("gates a bot approval without requesting auth: %s", (type) => {
    const event = parseGithubPayload("pull_request_review", {
      action: "submitted",
      installation: { id: 9 },
      repository,
      pull_request: { number: 7, head: { sha: "head" } },
      review: { id: 1, state: "approved", user: { id: 7, type }, author_association: "MEMBER" },
    });
    const approvalCfg = makeTestConfig({ features: { ...cfg.features, review: "approval" } });
    expect(toIntakeCommand(approvalCfg, headers, event)).toMatchObject({
      kind: "ignored",
      decision: "ignored_bot_slash_command",
    });
    expect(
      toIntakeCommand(
        makeTestConfig({ features: { ...cfg.features, review: "manual" } }),
        headers,
        event,
      ),
    ).toMatchObject({ kind: "ignored", decision: "ignored_review_approval_not_enabled" });
  });
  it.each(["check_suite", "workflow_run"])(
    "preserves normalized matching-head CI targets: %s",
    (name) => {
      const event = parseGithubPayload(name, {
        action: "completed",
        installation: { id: 9 },
        repository,
        [name]: {
          id: 55,
          head_sha: "head",
          status: "completed",
          conclusion: "success",
          pull_requests: [
            { number: 7, head: { sha: "head" } },
            { number: 8, head: { sha: "other" } },
            { number: 7, head: { sha: "head" } },
          ],
        },
      });
      expect(toIntakeCommand(cfg, headers, event)).toMatchObject({
        kind: "ci_refresh",
        data: { installationId: 9, owner: "acme", repo: "app", headSha: "head", prNumbers: [7] },
      });
    },
  );
});
