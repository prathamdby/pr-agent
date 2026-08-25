import { AppError } from "../../errors/appError.js";

export class TriageCancelledError extends AppError {
  constructor(message = "Triage work was cancelled") {
    super({ code: "triage.cancelled", message });
    this.name = "TriageCancelledError";
  }
}

export class TriageClosedPullRequestError extends AppError {
  constructor(message = "Pull request is closed or merged; triage will not write to its branch") {
    super({ code: "triage.closed_pull_request", message });
    this.name = "TriageClosedPullRequestError";
  }
}
