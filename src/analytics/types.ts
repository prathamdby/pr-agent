export type CaptureEventInput = {
  readonly distinctId: string;
  readonly event: string;
  readonly properties?: Record<string, unknown>;
};

export type AnalyticsSink = {
  readonly captureEvent: (input: CaptureEventInput) => void;
  readonly captureException: (
    error: unknown,
    distinctId: string,
    properties?: Record<string, unknown>,
  ) => void;
  readonly shutdown: () => Promise<void>;
};
