import { captureEvent, captureException } from "../analytics/index.js";
import {
  classifyFailure,
  classifiedFailurePostHogProperties,
} from "../errors/classifiedFailure.js";
import type { TriageScope } from "./types.js";

export type TriageAnalyticsRef = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly workItemId?: string;
  readonly scope?: TriageScope;
};

function distinctId(installationId: number): string {
  return `installation:${installationId}`;
}

function baseProperties(ref: TriageAnalyticsRef): Record<string, unknown> {
  return {
    owner: ref.owner,
    repo: ref.repo,
    pr_number: ref.prNumber,
    ...(ref.workItemId != null ? { work_item_id: ref.workItemId } : {}),
    ...(ref.scope != null ? { scope: ref.scope } : {}),
  };
}

export function captureTriageEvent(
  ref: TriageAnalyticsRef,
  event: string,
  properties?: Record<string, unknown>,
): void {
  captureEvent({
    distinctId: distinctId(ref.installationId),
    event,
    properties: { ...baseProperties(ref), ...properties },
  });
}

export function captureTriageFailure(
  ref: TriageAnalyticsRef,
  step: string,
  error: unknown,
  properties?: Record<string, unknown>,
): void {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  const failure = classifyFailure(error, { phase: step });
  captureTriageEvent(ref, "triage failed", {
    step,
    ...classifiedFailurePostHogProperties(failure),
    ...properties,
  });
  captureException(errorObj, distinctId(ref.installationId), {
    type: "triage",
    step,
    ...baseProperties(ref),
    ...classifiedFailurePostHogProperties(failure),
    ...properties,
  });
}
