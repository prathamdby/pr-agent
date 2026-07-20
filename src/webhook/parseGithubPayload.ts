import { z } from "zod";
import { installationIdPickSchema } from "./payloads/common.js";
import { issueCommentWebhookSchema } from "./payloads/issueCommentEvent.js";
import { pullRequestReviewCommentWebhookSchema } from "./payloads/pullRequestReviewCommentEvent.js";
import { pullRequestWebhookSchema } from "./payloads/pullRequestEvent.js";
import { workflowRunWebhookSchema } from "./payloads/workflowRunEvent.js";
import type { IssueCommentWebhookPayload } from "./payloads/issueCommentEvent.js";
import type { PullRequestReviewCommentWebhookPayload } from "./payloads/pullRequestReviewCommentEvent.js";
import type { PullRequestWebhookPayload } from "./payloads/pullRequestEvent.js";
import type { WorkflowRunWebhookPayload } from "./payloads/workflowRunEvent.js";
import { AUTOMATED_PR_ACTIONS } from "../settings/index.js";

export class WebhookParseError extends Error {
  constructor(
    message: string,
    public readonly eventName: string,
    public readonly zodError?: z.ZodError,
  ) {
    super(message);
    this.name = "WebhookParseError";
  }
}

export type ParsedGithubEvent =
  | { name: "pull_request"; data: PullRequestWebhookPayload }
  | { name: "issue_comment"; data: IssueCommentWebhookPayload }
  | {
      name: "pull_request_review_comment";
      data: PullRequestReviewCommentWebhookPayload;
    }
  | { name: "workflow_run"; data: WorkflowRunWebhookPayload }
  | { name: "ignored"; data: unknown };

function parseOrThrow<T>(eventName: string, schema: z.ZodType<T>, payload: unknown): T {
  try {
    return schema.parse(payload);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new WebhookParseError(e.message, eventName, e);
    }
    throw e;
  }
}

function payloadAction(payload: unknown): string | undefined {
  if (payload == null || typeof payload !== "object") return undefined;
  const action = (payload as { action?: unknown }).action;
  return typeof action === "string" ? action : undefined;
}

/**
 * Validates payloads for events we handle with strict shapes; unknown `X-GitHub-Event` values pass through as `ignored`.
 */
export function parseGithubPayload(eventName: string, payload: unknown): ParsedGithubEvent {
  switch (eventName) {
    case "pull_request":
      if (!AUTOMATED_PR_ACTIONS.has(payloadAction(payload) ?? "")) {
        return { name: "ignored", data: payload };
      }
      return {
        name: "pull_request",
        data: parseOrThrow(eventName, pullRequestWebhookSchema, payload),
      };
    case "issue_comment":
      if (payloadAction(payload) !== "created") {
        return { name: "ignored", data: payload };
      }
      return {
        name: "issue_comment",
        data: parseOrThrow(eventName, issueCommentWebhookSchema, payload),
      };
    case "pull_request_review_comment":
      if (payloadAction(payload) !== "created") {
        return { name: "ignored", data: payload };
      }
      return {
        name: "pull_request_review_comment",
        data: parseOrThrow(eventName, pullRequestReviewCommentWebhookSchema, payload),
      };
    case "workflow_run":
      if (payloadAction(payload) !== "completed") {
        return { name: "ignored", data: payload };
      }
      return {
        name: "workflow_run",
        data: parseOrThrow(eventName, workflowRunWebhookSchema, payload),
      };
    default:
      return { name: "ignored", data: payload };
  }
}

/** Installation id for any App webhook JSON (extra top-level keys allowed). */
export function parseInstallationId(payload: unknown): number | undefined {
  const r = installationIdPickSchema.safeParse(payload);
  return r.success ? r.data.installation.id : undefined;
}
