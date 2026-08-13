import { PostHog } from "posthog-node";
import { sanitizePostHogEvent } from "../security/sanitizePostHogEvent.js";
import { jsonObjectSchema } from "../util/jsonValue.js";
import * as v from "valibot";
import type { AnalyticsSink } from "./types.js";

export type PostHogClient = Pick<PostHog, "capture" | "captureException" | "shutdown">;
export type PostHogClientOptions = NonNullable<ConstructorParameters<typeof PostHog>[1]>;
export type PostHogClientFactory = (apiKey: string, options: PostHogClientOptions) => PostHogClient;

const defaultPostHogClientFactory: PostHogClientFactory = (apiKey, options) =>
  new PostHog(apiKey, options);

let postHogClientFactory: PostHogClientFactory = defaultPostHogClientFactory;

export function setPostHogClientFactory(factory: PostHogClientFactory): void {
  postHogClientFactory = factory;
}

export function resetPostHogClientFactory(): void {
  postHogClientFactory = defaultPostHogClientFactory;
}

export function createPostHogSink(opts: {
  readonly projectToken: string;
  readonly host: string;
}): AnalyticsSink {
  const clientOptions: PostHogClientOptions = {
    enableExceptionAutocapture: true,
    before_send: (event) => {
      if (event == null) return null;
      const properties = event.properties;
      if (properties == null) return event;
      const parsed = v.safeParse(jsonObjectSchema, properties);
      if (!parsed.success) return event;
      const sanitized = sanitizePostHogEvent({ properties: parsed.output });
      if (sanitized == null) return null;
      return { ...event, properties: sanitized.properties ?? properties };
    },
  };
  if (opts.host.length > 0) {
    clientOptions.host = opts.host;
  }
  const client = postHogClientFactory(opts.projectToken, clientOptions);

  return {
    captureEvent(input) {
      const payload: Parameters<PostHog["capture"]>[0] = {
        distinctId: input.distinctId,
        event: input.event,
      };
      if (input.properties !== undefined) {
        payload.properties = input.properties;
      }
      client.capture(payload);
    },
    captureException(error, distinctId, properties) {
      client.captureException(error, distinctId, properties);
    },
    shutdown() {
      return Promise.resolve(client.shutdown());
    },
  };
}
