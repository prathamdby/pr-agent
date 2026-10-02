import type { Config } from "../config.js";
import type { BotIdentity } from "../github/appAuth.js";
import type { IntakeCommand } from "../agentWork/intake/delivery.js";
import type { SlashCommandInput } from "../agentWork/intake/slashIntake.js";
import type { WebhookHeaders } from "../agentWork/types.js";
import { parseSlashCommand } from "../commands/parseSlashCommand.js";
import { commentMentionsBot } from "../commands/parseBotMention.js";
import { isSlashAssociationAllowed, reviewAuthorTrust } from "../commands/slashAssociation.js";
import {
  IGNORED_BOT_SLASH_COMMAND,
  IGNORED_REVIEW_APPROVAL_NOT_ENABLED,
  IGNORED_UNAUTHORIZED_SLASH,
  OWN_COMMIT_STATUS_CONTEXT,
} from "../settings/index.js";
import { isOwnCiCheck, observedAtFromGithub } from "../review/ci/classifySnapshot.js";
import type { ParsedGithubEvent } from "./parseGithubPayload.js";
import { codeAnchorFromReviewComment } from "./payloads/pullRequestReviewCommentEvent.js";
import { prNumbersForCiHead, toCiHeadSourceFromCompletedRun } from "./payloads/ciHeadSource.js";

/** Missing identity is explicit. The caller resolves it, then repeats this pure mapping. */
export function toIntakeCommand(
  cfg: Pick<Config, "features" | "slashAllowedAssociations" | "githubAppId">,
  headers: WebhookHeaders,
  event: ParsedGithubEvent,
  bot?: BotIdentity,
): IntakeCommand | { readonly kind: "auth_required" } {
  const ignored = (decision: string): IntakeCommand => ({ kind: "ignored", headers, decision });
  const authorize = (id: number, association: string | null | undefined, type?: string) => {
    if (type?.toLowerCase() === "bot") return ignored(IGNORED_BOT_SLASH_COMMAND);
    if (bot == null) return { kind: "auth_required" } as const;
    if (id === bot.userId) return ignored(IGNORED_BOT_SLASH_COMMAND);
    if (!isSlashAssociationAllowed(cfg.slashAllowedAssociations, association)) {
      return ignored(IGNORED_UNAUTHORIZED_SLASH);
    }
    return bot;
  };
  switch (event.name) {
    case "ignored":
      return ignored(`ignored_event_${headers.event || "missing"}`);
    case "pull_request": {
      const data = event.data;
      return {
        kind: "pull_request",
        headers,
        ref: {
          owner: data.repository.owner.login,
          repo: data.repository.name,
          prNumber: data.pull_request.number,
          headSha: data.pull_request.head.sha,
          installationId: data.installation.id,
          repositorySizeKb: data.repository.size,
        },
        action: data.action ?? "",
        opts: {
          authorTrust: reviewAuthorTrust(data.pull_request),
          pushBeforeSha: data.before,
          merged: data.pull_request.merged,
          lifecycle:
            (data.action === "closed" || data.action === "reopened") &&
            data.pull_request.updated_at != null
              ? {
                  state:
                    data.action === "reopened"
                      ? "open"
                      : data.pull_request.merged
                        ? "merged"
                        : "closed",
                  observedAt: data.pull_request.updated_at,
                }
              : undefined,
        },
      };
    }
    case "workflow_run_started":
      if (cfg.features.review !== "approval") {
        return ignored(IGNORED_REVIEW_APPROVAL_NOT_ENABLED);
      }
      return {
        kind: "review_approved",
        headers,
        signal: {
          kind: "workflow_run",
          installationId: event.data.installation.id,
          owner: event.data.repository.owner.login,
          repo: event.data.repository.name,
          headSha: event.data.workflow_run.head_sha,
          prNumbers: prNumbersForCiHead(
            event.data.workflow_run.head_sha,
            event.data.workflow_run.pull_requests,
          ),
        },
      };
    case "pull_request_review": {
      if (cfg.features.review !== "approval") {
        return ignored(IGNORED_REVIEW_APPROVAL_NOT_ENABLED);
      }
      const data = event.data;
      const gate = authorize(
        data.review.user.id,
        data.review.author_association,
        data.review.user.type,
      );
      if ("kind" in gate) return gate;
      return {
        kind: "review_approved",
        headers,
        signal: {
          kind: "pull_request_review",
          ref: {
            owner: data.repository.owner.login,
            repo: data.repository.name,
            prNumber: data.pull_request.number,
            headSha: data.pull_request.head.sha,
            installationId: data.installation.id,
            repositorySizeKb: data.repository.size,
          },
        },
      };
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      const data = event.data;
      const body = data.comment.body ?? "";
      const slash = parseSlashCommand(body);
      const gate = authorize(data.comment.user.id, data.comment.author_association);
      if ("kind" in gate) return gate;
      if (!slash && !commentMentionsBot(body, gate.login)) {
        return ignored("ignored_no_slash_command");
      }
      const command = slash ?? "ask";
      const fields: Pick<SlashCommandInput, "prNumber" | "replyTarget" | "codeAnchor"> =
        event.name === "issue_comment"
          ? {
              prNumber: event.data.issue.number,
              replyTarget: { kind: "prConversation", prNumber: event.data.issue.number },
            }
          : {
              prNumber: event.data.pull_request.number,
              replyTarget: {
                kind: "inlineReviewThread",
                prNumber: event.data.pull_request.number,
                inReplyToCommentId: event.data.comment.in_reply_to_id ?? event.data.comment.id,
              },
              codeAnchor: codeAnchorFromReviewComment(event.data.comment),
            };
      return {
        kind: "slash",
        input: {
          headers,
          installationId: data.installation.id,
          owner: data.repository.owner.login,
          repo: data.repository.name,
          repositorySizeKb: data.repository.size,
          ...fields,
          commenterId: data.comment.user.id,
          ...(slash ? { commenterLogin: data.comment.user.login ?? undefined } : {}),
          commentId: data.comment.id,
          body,
          command,
          ...(command === "triage"
            ? event.name === "issue_comment"
              ? { triageScope: "all" as const }
              : {
                  triageScope:
                    event.data.comment.in_reply_to_id != null ? ("thread" as const) : undefined,
                  threadAnchorCommentId: event.data.comment.in_reply_to_id ?? undefined,
                  needsThreadRootResolution: event.data.comment.in_reply_to_id != null,
                }
            : {}),
          ...(command === "ask" ? { botLogin: gate.login } : {}),
        },
      };
    }
    case "workflow_run":
    case "check_suite": {
      const data = event.data;
      const run = event.name === "workflow_run" ? event.data.workflow_run : event.data.check_suite;
      if (
        event.name === "check_suite" &&
        isOwnCiCheck(
          { githubAppId: cfg.githubAppId },
          { app_id: event.data.check_suite.app?.id ?? null, external_id: null },
        )
      )
        return ignored("ignored_own_check_suite");
      const source = toCiHeadSourceFromCompletedRun({
        installation: data.installation,
        repository: data.repository,
        run,
      });
      return {
        kind: "ci_refresh",
        headers,
        data: {
          installationId: source.installationId,
          owner: source.owner,
          repo: source.repo,
          headSha: source.headSha,
          prNumbers: prNumbersForCiHead(source.headSha, source.pullRequests),
        },
      };
    }
    case "check_run": {
      const data = event.data;
      const run = data.check_run;
      if (
        isOwnCiCheck(
          { githubAppId: cfg.githubAppId },
          { app_id: run.app?.id ?? null, external_id: run.external_id ?? null },
        )
      )
        return ignored("ignored_own_check_run");
      return {
        kind: "ci_state",
        headers,
        data: {
          installationId: data.installation.id,
          owner: data.repository.owner.login,
          repo: data.repository.name,
          headSha: run.head_sha,
          fact: {
            name: run.name,
            source: "check_run",
            status: run.status,
            conclusion: run.conclusion,
            url: run.html_url ?? null,
            external_id: run.external_id ?? null,
            app_id: run.app?.id ?? null,
            check_run_id: run.id,
            observed_at: observedAtFromGithub(run.completed_at, run.started_at),
          },
        },
      };
    }
    case "status": {
      const data = event.data;
      if (data.context === OWN_COMMIT_STATUS_CONTEXT) return ignored("ignored_own_commit_status");
      return {
        kind: "ci_state",
        headers,
        data: {
          installationId: data.installation.id,
          owner: data.repository.owner.login,
          repo: data.repository.name,
          headSha: data.sha,
          fact: {
            name: data.context,
            source: "status",
            status: data.state,
            conclusion: null,
            url: data.target_url ?? null,
            external_id: null,
            app_id: null,
            check_run_id: null,
            observed_at: observedAtFromGithub(data.updated_at, data.created_at),
          },
        },
      };
    }
    default:
      event satisfies never;
      return ignored(`ignored_unhandled_${headers.event || "missing"}`);
  }
}
