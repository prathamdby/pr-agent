import * as v from "valibot";
import { checkRunWebhookSchema, type CheckRunWebhookPayload } from "./payloads/checkRunEvent.js";
import {
  checkSuiteWebhookSchema,
  type CheckSuiteWebhookPayload,
} from "./payloads/checkSuiteEvent.js";
import { issueCommentWebhookSchema } from "./payloads/issueCommentEvent.js";
import { pullRequestReviewCommentWebhookSchema } from "./payloads/pullRequestReviewCommentEvent.js";
import {
  isApprovalReview,
  pullRequestReviewWebhookSchema,
} from "./payloads/pullRequestReviewEvent.js";
import { pullRequestWebhookSchema } from "./payloads/pullRequestEvent.js";
import { statusWebhookSchema, type StatusWebhookPayload } from "./payloads/statusEvent.js";
import { workflowRunWebhookSchema } from "./payloads/workflowRunEvent.js";
import type { IssueCommentWebhookPayload } from "./payloads/issueCommentEvent.js";
import type { PullRequestReviewCommentWebhookPayload } from "./payloads/pullRequestReviewCommentEvent.js";
import type { PullRequestReviewWebhookPayload } from "./payloads/pullRequestReviewEvent.js";
import type { PullRequestWebhookPayload } from "./payloads/pullRequestEvent.js";
import type { WorkflowRunWebhookPayload } from "./payloads/workflowRunEvent.js";
import { AppError } from "../errors/appError.js";
import { AUTOMATED_PR_ACTIONS } from "../settings/index.js";

type WebhookSchemaError = v.ValiError<v.GenericSchema | v.GenericSchemaAsync>;

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
  | { name: "pull_request_review"; data: PullRequestReviewWebhookPayload }
  | { name: "issue_comment"; data: IssueCommentWebhookPayload }
  | {
      name: "pull_request_review_comment";
      data: PullRequestReviewCommentWebhookPayload;
    }
  | { name: "workflow_run"; data: WorkflowRunWebhookPayload }
  | { name: "workflow_run_started"; data: WorkflowRunWebhookPayload }
  | { name: "check_suite"; data: CheckSuiteWebhookPayload }
  | { name: "check_run"; data: CheckRunWebhookPayload }
  | { name: "status"; data: StatusWebhookPayload }
  | { name: "ignored"; data: unknown };

const CHECK_RUN_ACTIONS = new Set(["created", "completed"]);

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
    case "pull_request_review": {
      if (payloadAction(payload) !== "submitted") {
        return { name: "ignored", data: payload };
      }
      const parsed = parseOrThrow(eventName, pullRequestReviewWebhookSchema, payload);
      if (!isApprovalReview(parsed)) {
        return { name: "ignored", data: payload };
      }
      return { name: "pull_request_review", data: parsed };
    }
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
    case "workflow_run": {
      const action = payloadAction(payload);
      if (action !== "completed" && action !== "in_progress") {
        return { name: "ignored", data: payload };
      }
      const data = parseOrThrow(eventName, workflowRunWebhookSchema, payload);
      if (action === "in_progress") {
        return data.workflow_run.event === "pull_request"
          ? { name: "workflow_run_started", data }
          : { name: "ignored", data: payload };
      }
      return {
        name: "workflow_run",
        data,
      };
    }
    case "check_suite":
      if (payloadAction(payload) !== "completed") {
        return { name: "ignored", data: payload };
      }
      return {
        name: "check_suite",
        data: parseOrThrow(eventName, checkSuiteWebhookSchema, payload),
      };
    case "check_run":
      if (!CHECK_RUN_ACTIONS.has(payloadAction(payload) ?? "")) {
        return { name: "ignored", data: payload };
      }
      return {
        name: "check_run",
        data: parseOrThrow(eventName, checkRunWebhookSchema, payload),
      };
    case "status":
      return {
        name: "status",
        data: parseOrThrow(eventName, statusWebhookSchema, payload),
      };
    default:
      return { name: "ignored", data: payload };
  }
}
