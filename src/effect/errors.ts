import { Data } from "effect";

export class WebhookHandlerError extends Data.TaggedError("WebhookHandlerError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}
