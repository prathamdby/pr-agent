import * as v from "valibot";
import { installationIdPickSchema } from "./payloads/common.js";
import { issueCommentWebhookSchema } from "./payloads/issueCommentEvent.js";
import { pullRequestReviewCommentWebhookSchema } from "./payloads/pullRequestReviewCommentEvent.js";
import { pullRequestWebhookSchema } from "./payloads/pullRequestEvent.js";
import { checkSuiteWebhookSchema } from "./payloads/checkSuiteEvent.js";
import { workflowRunWebhookSchema } from "./payloads/workflowRunEvent.js";
import type { CheckSuiteWebhookPayload } from "./payloads/checkSuiteEvent.js";
import type { IssueCommentWebhookPayload } from "./payloads/issueCommentEvent.js";
import type { PullRequestReviewCommentWebhookPayload } from "./payloads/pullRequestReviewCommentEvent.js";
import type { PullRequestWebhookPayload } from "./payloads/pullRequestEvent.js";
import type { WorkflowRunWebhookPayload } from "./payloads/workflowRunEvent.js";
import { AppError } from "../errors/appError.js";
import { AUTOMATED_PR_ACTIONS } from "../settings/index.js";

export type WebhookSchemaError = v.ValiError<v.GenericSchema | v.GenericSchemaAsync>;

export class WebhookParseError extends AppError {
  readonly eventName: string;
  readonly valibotError?: WebhookSchemaError;

  constructor(message: string, eventName: string, valibotError?: WebhookSchemaError) {
    super({
      code: "webhook.parse_failed",
      message,
      context: { eventName },
      cause: valibotError,
    });
    this.name = "WebhookParseError";
    this.eventName = eventName;
    this.valibotError = valibotError;
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
  | { name: "check_suite"; data: CheckSuiteWebhookPayload }
  | { name: "ignored"; data: unknown };

function parseOrThrow<T>(
  eventName: string,
  schema: v.GenericSchema<unknown, T>,
  payload: unknown,
): T {
  try {
    return v.parse(schema, payload);
  } catch (e) {
    if (e instanceof v.ValiError) {
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
    case "check_suite":
      if (payloadAction(payload) !== "completed") {
        return { name: "ignored", data: payload };
      }
      return {
        name: "check_suite",
        data: parseOrThrow(eventName, checkSuiteWebhookSchema, payload),
      };
    default:
      return { name: "ignored", data: payload };
  }
}

/** Installation id for any App webhook JSON (extra top-level keys allowed). */
export function parseInstallationId(payload: unknown): number | undefined {
  const r = v.safeParse(installationIdPickSchema, payload);
  return r.success ? r.output.installation.id : undefined;
}
