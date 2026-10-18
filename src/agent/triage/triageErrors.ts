import { AppError } from "../../errors/appError.ts";
import { isPullRequestOpenAndUnmerged } from "../../github/listPullRequestFiles.ts";
import type { PrSurface } from "../../github/prSurface.ts";

export class TriageCancelledError extends AppError {
  constructor(message = "Triage work was cancelled") {
    super({ domain: "triage", kind: "cancelled", message });
    this.name = "TriageCancelledError";
  }
}

export class TriageClosedPullRequestError extends AppError {
  constructor(message = "Pull request is closed or merged; triage will not write to its branch") {
    super({ domain: "triage", kind: "closed_pull_request", message });
    this.name = "TriageClosedPullRequestError";
  }
}

export async function assertTriagePullRequestWritable(prSurface: PrSurface): Promise<void> {
  const { pullRequest } = await prSurface.getHead();
  if (!isPullRequestOpenAndUnmerged(pullRequest)) {
    throw new TriageClosedPullRequestError();
  }
}
