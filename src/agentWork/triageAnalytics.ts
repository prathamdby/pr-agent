import { captureEvent, captureException } from "../analytics/index.js";
import {
  classifyFailure,
  classifiedFailurePostHogProperties,
} from "../errors/classifiedFailure.js";
import type { JsonObject } from "../util/jsonValue.js";
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

type TriageBaseProperties = {
  owner: string;
  repo: string;
  pr_number: number;
  work_item_id?: string;
  scope?: TriageScope;
};

function baseProperties(ref: TriageAnalyticsRef): JsonObject {
  const properties: TriageBaseProperties = {
    owner: ref.owner,
    repo: ref.repo,
    pr_number: ref.prNumber,
  };
  if (ref.workItemId != null) properties.work_item_id = ref.workItemId;
  if (ref.scope != null) properties.scope = ref.scope;
  return properties;
}

export function captureTriageEvent(
  ref: TriageAnalyticsRef,
  event: string,
  properties?: JsonObject,
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
  error: Error,
  properties?: JsonObject,
): void {
  const failure = classifyFailure(error, { phase: step });
  const extra: JsonObject = {
    step,
    ...classifiedFailurePostHogProperties(failure),
    ...properties,
  };
  captureTriageEvent(ref, "triage failed", extra);
  captureException(error, distinctId(ref.installationId), {
    type: "triage",
    ...baseProperties(ref),
    ...extra,
  });
}
