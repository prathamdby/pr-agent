import { describe, expect, it } from "vitest";
import {
  sanitizePostHogEvent,
  type PostHogEventMessage,
} from "../src/security/sanitizePostHogEvent.js";

const TOKEN = ["ghp", "1234567890123456789012345678901234"].join("_");

describe("sanitizePostHogEvent", () => {
  it("returns null unchanged", () => {
    expect(sanitizePostHogEvent(null)).toBeNull();
  });

  it("leaves benign events without error fields unchanged by identity", () => {
    const event: PostHogEventMessage = {
      distinctId: "installation:1",
      event: "triage degraded",
      properties: { step: "publish_push", reason: "stale_head" },
    };
    expect(sanitizePostHogEvent(event)).toBe(event);
  });

  it("redacts error_message while preserving other properties", () => {
    const event: PostHogEventMessage = {
      distinctId: "installation:1",
      event: "triage failed",
      properties: {
        step: "publish_report",
        error_message: `push failed Bearer ${TOKEN}`,
        owner: "o",
      },
    };
    const sanitized = sanitizePostHogEvent(event);
    expect(sanitized).not.toBe(event);
    expect(sanitized?.properties?.step).toBe("publish_report");
    expect(sanitized?.properties?.owner).toBe("o");
    expect(sanitized?.properties?.error_message).toContain("[redacted]");
    expect(String(sanitized?.properties?.error_message)).not.toContain("ghp_");
  });

  it("redacts exception value and stack-frame string fields", () => {
    const event: PostHogEventMessage = {
      distinctId: "installation:1",
      event: "$exception",
      properties: {
        $exception_list: [
          {
            type: "Error",
            value: `failed with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz`,
            stacktrace: {
              type: "raw",
              frames: [
                {
                  platform: "node:javascript",
                  filename: `/tmp/app.ts`,
                  function: "run",
                  context_line: `const auth = "Bearer ${TOKEN}";`,
                  pre_context: [`// token ${TOKEN}`],
                  post_context: ["return;"],
                  lineno: 12,
                },
              ],
            },
          },
        ],
      },
    };

    const sanitized = sanitizePostHogEvent(event);
    const entry = (sanitized?.properties?.$exception_list as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(entry.type).toBe("Error");
    expect(String(entry.value)).toContain("[redacted]");
    expect(String(entry.value)).not.toContain("sk-");

    const frame = (entry.stacktrace as { frames: Array<Record<string, unknown>> }).frames[0];
    expect(frame.filename).toBe("/tmp/app.ts");
    expect(frame.function).toBe("run");
    expect(frame.lineno).toBe(12);
    expect(String(frame.context_line)).toContain("[redacted]");
    expect(String(frame.context_line)).not.toContain("ghp_");
    expect((frame.pre_context as string[])[0]).toContain("[redacted]");
    expect((frame.pre_context as string[])[0]).not.toContain("ghp_");
    expect(frame.post_context).toEqual(["return;"]);
  });

  it("does not mutate the input event, nested exception structures, or original secret strings", () => {
    const errorMessage = `push failed Bearer ${TOKEN}`;
    const exceptionValue = `failed with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz`;
    const contextLine = `const auth = "Bearer ${TOKEN}";`;
    const preContext = [`// token ${TOKEN}`];
    const postContext = ["return;"];
    const frame = {
      platform: "node:javascript",
      filename: "/tmp/app.ts",
      function: "run",
      context_line: contextLine,
      pre_context: preContext,
      post_context: postContext,
      lineno: 12,
    };
    const frames = [frame];
    const stacktrace = { type: "raw", frames };
    const exceptionEntry = {
      type: "Error",
      value: exceptionValue,
      stacktrace,
    };
    const exceptionList = [exceptionEntry];
    const properties = {
      step: "publish_report",
      error_message: errorMessage,
      $exception_list: exceptionList,
    };
    const event: PostHogEventMessage = {
      distinctId: "installation:1",
      event: "$exception",
      properties,
    };

    const sanitized = sanitizePostHogEvent(event);

    expect(sanitized).not.toBe(event);
    expect(sanitized?.properties).not.toBe(properties);
    expect(sanitized?.properties?.$exception_list).not.toBe(exceptionList);
    expect((sanitized?.properties?.$exception_list as unknown[])[0]).not.toBe(exceptionEntry);
    expect(
      ((sanitized?.properties?.$exception_list as unknown[])[0] as { stacktrace: unknown })
        .stacktrace,
    ).not.toBe(stacktrace);
    expect(
      (
        (sanitized?.properties?.$exception_list as unknown[])[0] as {
          stacktrace: { frames: unknown[] };
        }
      ).stacktrace.frames,
    ).not.toBe(frames);
    expect(
      (
        (sanitized?.properties?.$exception_list as unknown[])[0] as {
          stacktrace: { frames: unknown[] };
        }
      ).stacktrace.frames[0],
    ).not.toBe(frame);
    expect(
      (
        (sanitized?.properties?.$exception_list as unknown[])[0] as {
          stacktrace: { frames: Array<{ pre_context: unknown }> };
        }
      ).stacktrace.frames[0].pre_context,
    ).not.toBe(preContext);

    expect(event.properties).toBe(properties);
    expect(properties.error_message).toBe(errorMessage);
    expect(properties.$exception_list).toBe(exceptionList);
    expect(exceptionEntry.value).toBe(exceptionValue);
    expect(exceptionEntry.stacktrace).toBe(stacktrace);
    expect(stacktrace.frames).toBe(frames);
    expect(frames[0]).toBe(frame);
    expect(frame.context_line).toBe(contextLine);
    expect(frame.pre_context).toBe(preContext);
    expect(preContext[0]).toBe(`// token ${TOKEN}`);
    expect(errorMessage).toContain("ghp_");
    expect(exceptionValue).toContain("sk-");
    expect(contextLine).toContain("ghp_");
    expect(String(sanitized?.properties?.error_message)).toContain("[redacted]");
    expect(String(sanitized?.properties?.error_message)).not.toContain("ghp_");
  });

  it("redacts camel and snake AppError fields recursively and breaks cycles", () => {
    const context: Record<string, unknown> = {
      workItemId: "work-1",
      rawValue: {
        apiKey: "opaque-provider-key",
        nested: [`Bearer ${TOKEN}`],
      },
    };
    context.self = context;
    const event: PostHogEventMessage = {
      distinctId: "installation:1",
      event: "agent_work_failed",
      properties: {
        message: `request failed Bearer ${TOKEN}`,
        errorMessage: `OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz`,
        error_context: context,
        errorCause: {
          error_message: `DATABASE_URL=postgres://user:pass@db/app`,
          values: [`Bearer ${TOKEN}`, { privateKey: "secret" }],
        },
        error_code: "worker.failed",
        unsupported: {
          bigint: 42n,
          symbol: Symbol("safe"),
          function: () => "not serialized",
        },
      },
    };

    const sanitized = sanitizePostHogEvent(event);
    const properties = sanitized?.properties as Record<string, unknown>;
    const json = JSON.stringify(sanitized);
    expect(properties.error_code).toBe("worker.failed");
    expect(properties.errorMessage).toContain("[redacted]");
    expect((properties.error_context as Record<string, unknown>).workItemId).toBe("work-1");
    expect((properties.error_context as Record<string, unknown>).self).toBe("[circular]");
    expect(JSON.stringify(sanitized)).not.toContain("opaque-provider-key");
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain("postgres://");
    expect(json).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(json).toContain("[redacted]");
  });

  it("does not return the original event when sanitization is not an object", () => {
    const event = {
      distinctId: "installation:1",
      event: "broken",
      toJSON() {
        return "nope";
      },
    };
    expect(sanitizePostHogEvent(event)).toEqual({ properties: {} });
  });
});
