import * as v from "valibot";
import { checkRunWebhookSchema, type CheckRunWebhookPayload } from "./payloads/checkRunEvent.ts";
import {
  checkSuiteWebhookSchema,
  type CheckSuiteWebhookPayload,
} from "./payloads/checkSuiteEvent.ts";
import { issueCommentWebhookSchema } from "./payloads/issueCommentEvent.ts";
import { pullRequestReviewCommentWebhookSchema } from "./payloads/pullRequestReviewCommentEvent.ts";
import {
  isApprovalReview,
  pullRequestReviewWebhookSchema,
} from "./payloads/pullRequestReviewEvent.ts";
import { pullRequestWebhookSchema } from "./payloads/pullRequestEvent.ts";
import { statusWebhookSchema, type StatusWebhookPayload } from "./payloads/statusEvent.ts";
import { workflowRunWebhookSchema } from "./payloads/workflowRunEvent.ts";
import type { IssueCommentWebhookPayload } from "./payloads/issueCommentEvent.ts";
import type { PullRequestReviewCommentWebhookPayload } from "./payloads/pullRequestReviewCommentEvent.ts";
import type { PullRequestReviewWebhookPayload } from "./payloads/pullRequestReviewEvent.ts";
import type { PullRequestWebhookPayload } from "./payloads/pullRequestEvent.ts";
import type { WorkflowRunWebhookPayload } from "./payloads/workflowRunEvent.ts";
import { AppError } from "../errors/appError.ts";
import { AUTOMATED_PR_ACTIONS } from "../settings/index.ts";

type WebhookSchemaError = v.ValiError<v.GenericSchema | v.GenericSchemaAsync>;

export class WebhookParseError extends AppError {
  readonly eventName: string;
  readonly valibotError?: WebhookSchemaError;

  constructor(message: string, eventName: string, valibotError?: WebhookSchemaError) {
    super({
      domain: "webhook",
      kind: "parse_failed",
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
