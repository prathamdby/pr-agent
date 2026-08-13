import type { JsonObject } from "../util/jsonValue.js";

export type CaptureEventInput = {
  readonly distinctId: string;
  readonly event: string;
  readonly properties?: JsonObject;
};

export type AnalyticsSink = {
  readonly captureEvent: (input: CaptureEventInput) => void;
  readonly captureException: (error: Error, distinctId: string, properties?: JsonObject) => void;
  readonly shutdown: () => Promise<void>;
};
