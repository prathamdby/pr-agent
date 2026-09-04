import { AppError } from "../../errors/appError.js";
import { isPullRequestOpenAndUnmerged } from "../../github/listPullRequestFiles.js";
import type { PrSurface } from "../../github/prSurface.js";

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

/** Pre-commit, pre-push, and post-push recheck share this open-state rule. */
export async function assertTriagePullRequestWritable(prSurface: PrSurface): Promise<void> {
  const { pullRequest } = await prSurface.getHead();
  if (!isPullRequestOpenAndUnmerged(pullRequest)) {
    throw new TriageClosedPullRequestError();
  }
}
